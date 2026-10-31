-- SPM-134 Event Registration: an attendee registers themselves for an event.
--   * registration keeps the dietary restrictions and accessibility
--     requirements the attendee submitted for this event. They start from the
--     attendee profile in the form, but are stored here so a later profile
--     edit never rewrites what was submitted, and the profile is never changed.
--     Name and email stay on "user" and are not copied.
--   * register_for_event is the whole operation in one transaction (Master
--     5.6, 7, 7.1): event lock first, then the attendee; window by database
--     time; capacity recount; one registration per attendee and event; the
--     activity entry and the in-app confirmation (Master 8, SPM-155
--     _notify_registration_recorded). A full event is refused: SPM-134 creates
--     no waitlist entry.
--   * An optional Idempotency-Key replays the stored result (Master 6.3).

BEGIN;

ALTER TABLE public.registration
  ADD COLUMN dietary_restrictions text,
  ADD COLUMN accessibility_requirements text,
  ADD CONSTRAINT registration_dietary_restrictions_check
    CHECK (dietary_restrictions IS NULL OR (btrim(dietary_restrictions) <> '' AND char_length(dietary_restrictions) <= 1000)),
  ADD CONSTRAINT registration_accessibility_requirements_check
    CHECK (accessibility_requirements IS NULL OR (btrim(accessibility_requirements) <> '' AND char_length(accessibility_requirements) <= 1000));

DO $idempotency_operations$
DECLARE
  v_existing_check text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT v_existing_check
    FROM pg_constraint
   WHERE conrelid = 'public.idempotency_records'::regclass
     AND conname = 'idempotency_records_operation_check'
     AND contype = 'c';
  EXECUTE format(
    'ALTER TABLE public.idempotency_records
       DROP CONSTRAINT idempotency_records_operation_check,
       ADD CONSTRAINT idempotency_records_operation_check CHECK ((%s) OR operation = %L)',
    v_existing_check, 'registration.register'
  );
END;
$idempotency_operations$;

-- Refusals are P0001 with a stable message:
--   EVENT_NOT_FOUND           not published, ended, missing, or never confirmed
--   NOT_ATTENDEE              not an active ATTENDEE
--   ALREADY_REGISTERED        a REGISTERED record exists for this event
--   ALREADY_WAITLISTED        a WAITLISTED record exists for this event
--   REGISTRATION_NOT_ENABLED  the organiser has not enabled registration
--   REGISTRATION_CLOSED       outside [registration_open_at, registration_close_at),
--                             or paused while a confirmed event is replanned
--   REGISTRATION_FULL         REGISTERED records have reached the capacity
-- A WITHDRAWN record is re-entered in place with a new registration time
-- (Master 5.6, D05), so the unique attendee/event pair still holds.
CREATE FUNCTION public.register_for_event(
  p_attendee_id integer,
  p_event_id integer,
  p_dietary_restrictions text,
  p_accessibility_requirements text,
  p_idempotency_key text DEFAULT NULL,
  p_request_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_replay jsonb;
  v_now timestamptz := now();
  v_event public.event;
  v_existing public.registration;
  v_registration public.registration;
  v_registered integer;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_attendee_id, 'registration.register', p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  -- Every registration for an event queues here, so the capacity recount and
  -- the duplicate check below see all earlier registrations.
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND
     OR NOT v_event.is_published
     OR v_event.end_datetime IS NULL
     OR v_event.end_datetime <= v_now
     OR NOT (v_event.status IN ('CONFIRMED', 'PREPARATION')
             OR (v_event.previously_confirmed AND v_event.status IN ('PLANNING', 'SAFETY_REVIEW'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  PERFORM 1 FROM public."user"
   WHERE user_id = p_attendee_id AND role = 'ATTENDEE' AND is_active
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOT_ATTENDEE';
  END IF;

  SELECT * INTO v_existing
    FROM public.registration
   WHERE attendee_id = p_attendee_id AND event_id = p_event_id
   FOR UPDATE;
  IF v_existing.registration_status = 'REGISTERED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ALREADY_REGISTERED';
  ELSIF v_existing.registration_status = 'WAITLISTED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ALREADY_WAITLISTED';
  END IF;

  IF NOT v_event.is_registration_enabled THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_NOT_ENABLED';
  END IF;
  -- Half-open window, as Event Discovery shows it: closed at registration_close_at itself.
  IF v_event.status NOT IN ('CONFIRMED', 'PREPARATION')
     OR (v_event.registration_open_at IS NOT NULL AND v_now < v_event.registration_open_at)
     OR (v_event.registration_close_at IS NOT NULL AND v_now >= v_event.registration_close_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_CLOSED';
  END IF;

  IF v_event.registration_capacity IS NOT NULL THEN
    SELECT count(*) INTO v_registered
      FROM public.registration
     WHERE event_id = p_event_id AND registration_status = 'REGISTERED';
    IF v_registered >= v_event.registration_capacity THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_FULL';
    END IF;
  END IF;

  IF v_existing.registration_id IS NULL THEN
    INSERT INTO public.registration (
      attendee_id, event_id, registration_status, registration_datetime,
      dietary_restrictions, accessibility_requirements
    )
    VALUES (p_attendee_id, p_event_id, 'REGISTERED', v_now, p_dietary_restrictions, p_accessibility_requirements)
    RETURNING * INTO v_registration;
  ELSE
    UPDATE public.registration
       SET registration_status = 'REGISTERED',
           registration_datetime = v_now,
           withdrawal_date = NULL,
           dietary_restrictions = p_dietary_restrictions,
           accessibility_requirements = p_accessibility_requirements
     WHERE registration_id = v_existing.registration_id
    RETURNING * INTO v_registration;
  END IF;

  -- No dietary or accessibility text in the audit entry: it is personal data.
  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, audience)
  VALUES (
    p_attendee_id,
    'registration',
    v_registration.registration_id,
    CASE WHEN v_existing.registration_id IS NULL THEN 'REGISTRATION_CREATED' ELSE 'REGISTRATION_REENTERED' END,
    format('Registered for event %s', p_event_id),
    'STAFF_ONLY'
  );

  PERFORM public._notify_registration_recorded(v_registration.registration_id);

  RETURN public._store_idempotent_response(
    p_attendee_id,
    'registration.register',
    p_idempotency_key,
    jsonb_build_object(
      'registration', jsonb_build_object(
        'registration_id', v_registration.registration_id,
        'registration_status', v_registration.registration_status,
        'registration_datetime', v_registration.registration_datetime,
        'dietary_restrictions', v_registration.dietary_restrictions,
        'accessibility_requirements', v_registration.accessibility_requirements
      ),
      'event', jsonb_build_object(
        'event_id', v_event.event_id,
        'title', v_event.title,
        'start_datetime', v_event.start_datetime,
        'end_datetime', v_event.end_datetime,
        'organisation_name', (SELECT o.name FROM public.organisation AS o WHERE o.organisation_id = v_event.organisation_id)
      )
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_for_event(integer, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_for_event(integer, integer, text, text, text, text) TO service_role;

COMMIT;
