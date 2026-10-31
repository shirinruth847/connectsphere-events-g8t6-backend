-- SPM-134 final rule (team agreement of 30 October 2026, Master 1.10):
-- registration is available for a confirmed, attendee-visible event from the
-- organiser's registration start time until the registration end time, subject
-- to venue capacity. Supersedes 20261029164310, which ignored the start time.
--
-- event_registration_availability is the one place the rule lives. Event
-- Discovery (list, detail and the attendee's registered-event view) reads it as
-- a PostgREST computed field and register_for_event calls it under the event
-- lock, so what attendees see and what registration accepts cannot drift.
--
--   NOT_YET_OPEN   now < registration_open_at
--   CLOSED         now >= registration_close_at (half-open [open, close)),
--                  and every status but CONFIRMED
--   FULL_WAITLIST  REGISTERED places have reached the capacity
--   UNAVAILABLE    no start or end time, or no primary venue: missing data
--                  never means "always open" or "unlimited"
--   OPEN           otherwise
--
-- The capacity is the primary venue's max_capacity (_event_primary_venue, as
-- SPM-173 readiness reads it), lowered by registration_capacity when the
-- organiser set one (Master 5.6, T18). is_registration_enabled is not read.

BEGIN;

CREATE OR REPLACE FUNCTION public.event_registration_availability(p_event public.event)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := now();
  v_venue_capacity integer;
  v_registered integer;
BEGIN
  IF p_event.status IS DISTINCT FROM 'CONFIRMED' THEN
    RETURN 'CLOSED';
  END IF;
  IF p_event.registration_open_at IS NULL OR p_event.registration_close_at IS NULL THEN
    RETURN 'UNAVAILABLE';
  END IF;
  IF v_now < p_event.registration_open_at THEN
    RETURN 'NOT_YET_OPEN';
  END IF;
  IF v_now >= p_event.registration_close_at THEN
    RETURN 'CLOSED';
  END IF;

  SELECT min(max_capacity) INTO v_venue_capacity FROM public._event_primary_venue(p_event.event_id);
  IF v_venue_capacity IS NULL THEN
    RETURN 'UNAVAILABLE';
  END IF;

  SELECT count(*) INTO v_registered
    FROM public.registration
   WHERE event_id = p_event.event_id AND registration_status = 'REGISTERED';
  IF v_registered >= LEAST(v_venue_capacity, COALESCE(p_event.registration_capacity, v_venue_capacity)) THEN
    RETURN 'FULL_WAITLIST';
  END IF;
  RETURN 'OPEN';
END;
$$;

REVOKE ALL ON FUNCTION public.event_registration_availability(public.event) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_registration_availability(public.event) TO service_role;

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
  v_availability text;
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
     OR v_event.status <> 'CONFIRMED' THEN
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

  -- The same rule Event Discovery shows, decided under the event lock.
  v_availability := public.event_registration_availability(v_event);
  IF v_availability = 'NOT_YET_OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_NOT_YET_OPEN';
  ELSIF v_availability = 'CLOSED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_CLOSED';
  ELSIF v_availability = 'FULL_WAITLIST' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_FULL';
  ELSIF v_availability IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_UNAVAILABLE';
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

-- Event Discovery selects the new computed field through PostgREST.
NOTIFY pgrst, 'reload schema';

COMMIT;
