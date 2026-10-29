-- SPM-134 correction: direct registration is open only while the event is
-- exactly CONFIRMED, the same events attendee discovery shows (Master 5.3,
-- SPM-44). Migration 20261029055940 also accepted PREPARATION; that was wrong.
--   * PREPARATION and every other state that attendees cannot discover is
--     EVENT_NOT_FOUND, as a hidden event is.
--   * Unchanged: a previously confirmed event back in PLANNING or SAFETY_REVIEW
--     is paused (REGISTRATION_CLOSED), and every other check, lock, write,
--     notice and grant.
-- Only these two status conditions differ from 20261029055940.

BEGIN;

CREATE OR REPLACE FUNCTION public.register_for_event(
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
     OR NOT (v_event.status = 'CONFIRMED'
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
  IF v_event.status <> 'CONFIRMED'
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
