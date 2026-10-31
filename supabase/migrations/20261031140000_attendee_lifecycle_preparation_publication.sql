-- Attendee lifecycle rule (supersedes the SPM-44 "CONFIRMED only" rule):
--   * a successful confirmation publishes the event;
--   * published CONFIRMED and PREPARATION events that have not ended are
--     attendee-facing: discoverable, registration-capable and waitlist-capable,
--     under the same registration window and effective-capacity rules;
--   * PLANNING, SAFETY_REVIEW, COMPLETED, CANCELLED and every other state stay
--     hidden from attendees and refused as EVENT_NOT_FOUND, as before.
-- Each function below is its latest definition with only the lifecycle check
-- changed. Withdrawal, decline, leave and offer expiry have no CONFIRMED-only
-- check and are unchanged.

BEGIN;

-- 1. Confirmation publishes the event. Set in the same UPDATE as
--    previously_confirmed, so the version is bumped once and the event row
--    returned to confirm_event (and so its snapshot) records is_published = true.
--    Publication is never cleared by a later transition; a published event that
--    returns to PLANNING stays hidden by its status.
CREATE OR REPLACE FUNCTION public._apply_event_transition(
  p_event public.event,
  p_action text,
  p_actor_id integer,
  p_details text
)
RETURNS public.event
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rule record;
  v_current public.event;
  v_updated public.event;
BEGIN
  SELECT * INTO v_rule FROM public._lifecycle_transitions() AS t WHERE t.action = p_action;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNKNOWN_LIFECYCLE_ACTION', DETAIL = p_action;
  END IF;

  -- Re-read under the caller's lock: the caller may have changed the row (for
  -- example, set the coordinator) after locking it.
  SELECT * INTO v_current FROM public.event WHERE event_id = p_event.event_id FOR UPDATE;

  -- Master 5.2 / 6.3: SUBMITTED never has a coordinator; every active state
  -- from UNDER_REVIEW onward has exactly one.
  IF v_rule.to_state = 'SUBMITTED' AND v_current.coordinator_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COORDINATOR_INVARIANT', DETAIL = v_rule.to_state;
  END IF;
  IF v_rule.to_state IN ('UNDER_REVIEW', 'AWAITING_CLARIFICATION', 'PLANNING', 'SAFETY_REVIEW', 'CONFIRMED', 'PREPARATION')
     AND v_current.coordinator_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COORDINATOR_INVARIANT', DETAIL = v_rule.to_state;
  END IF;

  UPDATE public.event
     SET status = v_rule.to_state::public.event_status,
         previously_confirmed = previously_confirmed OR v_rule.to_state = 'CONFIRMED',
         is_published = is_published OR v_rule.to_state = 'CONFIRMED',
         updated_at = now()
   WHERE event_id = v_current.event_id
   RETURNING * INTO v_updated;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id,
    'event',
    v_updated.event_id,
    v_rule.activity_action,
    p_details,
    COALESCE((SELECT role::text FROM public."user" WHERE user_id = p_actor_id), 'SYSTEM'),
    jsonb_build_object('status', jsonb_build_object('before', v_current.status::text, 'after', v_rule.to_state)),
    v_rule.audience
  );

  RETURN v_updated;
END;
$$;

CREATE OR REPLACE FUNCTION public._apply_event_transition(
  p_event public.event,
  p_action text,
  p_actor_id integer,
  p_details text,
  p_coordinator_id integer
)
RETURNS public.event
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rule record;
  v_current public.event;
  v_updated public.event;
BEGIN
  SELECT * INTO v_rule FROM public._lifecycle_transitions() AS t WHERE t.action = p_action;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNKNOWN_LIFECYCLE_ACTION', DETAIL = p_action;
  END IF;

  SELECT * INTO v_current FROM public.event WHERE event_id = p_event.event_id FOR UPDATE;

  IF v_rule.to_state = 'SUBMITTED' AND v_current.coordinator_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COORDINATOR_INVARIANT', DETAIL = v_rule.to_state;
  END IF;
  IF v_rule.to_state IN ('UNDER_REVIEW', 'AWAITING_CLARIFICATION', 'PLANNING', 'SAFETY_REVIEW', 'CONFIRMED', 'PREPARATION')
     AND COALESCE(p_coordinator_id, v_current.coordinator_id) IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COORDINATOR_INVARIANT', DETAIL = v_rule.to_state;
  END IF;

  UPDATE public.event
     SET status = v_rule.to_state::public.event_status,
         coordinator_id = COALESCE(p_coordinator_id, coordinator_id),
         previously_confirmed = previously_confirmed OR v_rule.to_state = 'CONFIRMED',
         is_published = is_published OR v_rule.to_state = 'CONFIRMED',
         updated_at = now()
   WHERE event_id = v_current.event_id
   RETURNING * INTO v_updated;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id,
    'event',
    v_updated.event_id,
    v_rule.activity_action,
    p_details,
    COALESCE((SELECT role::text FROM public."user" WHERE user_id = p_actor_id), 'SYSTEM'),
    jsonb_build_object('status', jsonb_build_object('before', v_current.status::text, 'after', v_rule.to_state)),
    v_rule.audience
  );

  RETURN v_updated;
END;
$$;

-- 2. The publication flag is not an attendee-facing detail: a reconfirmation
--    whose only difference from the previous snapshot is the publication flag
--    (snapshots taken before this migration recorded false) does not tell
--    registered attendees that the details changed.
CREATE OR REPLACE FUNCTION public.confirm_event(
  p_event_id integer,
  p_actor_id integer,
  p_expected_version integer,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_operation constant text := 'event.confirm';
  v_event public.event;
  v_failures text[];
  v_previous jsonb;
  v_snapshot jsonb;
  v_request_id text;
  v_replay jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_actor_id, v_operation, p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  PERFORM public._check_event_transition(v_event, 'confirm', p_actor_id, p_expected_version);

  IF NOT EXISTS (
    SELECT 1 FROM public.safety_reviews AS r
     WHERE r.event_id = p_event_id
       AND r.status = 'APPROVED'
       AND r.arrangement_version = v_event.arrangement_version
       AND r.round_number = (SELECT max(round_number) FROM public.safety_reviews WHERE event_id = p_event_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SAFETY_APPROVAL_REQUIRED';
  END IF;

  v_failures := public._event_readiness(p_event_id);
  IF cardinality(v_failures) > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'READINESS_BLOCKED', DETAIL = array_to_string(v_failures, ',');
  END IF;

  SELECT snapshot INTO v_previous
    FROM public.event_confirmation_snapshots
   WHERE event_id = p_event_id
   ORDER BY snapshot_id DESC
   LIMIT 1;

  v_event := public._apply_event_transition(v_event, 'confirm', p_actor_id, 'Event confirmed.');
  v_snapshot := public._event_attendee_snapshot(v_event);

  INSERT INTO public.event_confirmation_snapshots (event_id, event_version, arrangement_version, snapshot, confirmed_by)
  VALUES (p_event_id, v_event.version, v_event.arrangement_version, v_snapshot, p_actor_id);

  v_request_id := 'REQ-' || lpad(p_event_id::text, 6, '0');
  PERFORM public._notify_event_users(
    p_event_id,
    'Event confirmed',
    format('Your event "%s" (%s) is confirmed.', v_event.title, v_request_id),
    ARRAY[v_event.organiser_id]
  );
  PERFORM public._notify_event_users(
    p_event_id,
    'Event confirmed',
    format('Event %s "%s" is confirmed.', v_request_id, v_event.title),
    public._event_staff_recipients(p_event_id)
  );
  IF v_previous IS NOT NULL AND (v_previous - 'is_published') IS DISTINCT FROM (v_snapshot - 'is_published') THEN
    PERFORM public._notify_event_users(
      p_event_id,
      'Event details updated',
      format('The details of "%s" have changed. Please check the latest information.', v_event.title),
      ARRAY(SELECT attendee_id FROM public.registration WHERE event_id = p_event_id AND registration_status = 'REGISTERED')
    );
  END IF;

  RETURN public._store_idempotent_response(p_actor_id, v_operation, p_idempotency_key, jsonb_build_object('event', to_jsonb(v_event)));
END;
$$;

-- 3. Registration availability: PREPARATION uses the same window and capacity
--    states as CONFIRMED instead of CLOSED.
CREATE OR REPLACE FUNCTION public._event_registration_availability_at(p_event public.event, p_now timestamptz)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_venue_capacity integer;
  v_registered integer;
  v_offered integer := 0;
  v_waiting integer := 0;
BEGIN
  IF p_event.status IS NULL OR p_event.status NOT IN ('CONFIRMED', 'PREPARATION') THEN
    RETURN 'CLOSED';
  END IF;
  IF p_event.registration_open_at IS NULL OR p_event.registration_close_at IS NULL THEN
    RETURN 'UNAVAILABLE';
  END IF;
  IF p_now < p_event.registration_open_at THEN
    RETURN 'NOT_YET_OPEN';
  END IF;
  IF p_now >= p_event.registration_close_at THEN
    RETURN 'CLOSED';
  END IF;

  SELECT min(max_capacity) INTO v_venue_capacity FROM public._event_primary_venue(p_event.event_id);
  IF v_venue_capacity IS NULL THEN
    RETURN 'UNAVAILABLE';
  END IF;

  SELECT count(*) INTO v_registered
    FROM public.registration
   WHERE event_id = p_event.event_id AND registration_status = 'REGISTERED';
  -- Preserve SPM-163's reserved places and queue priority. Use the same
  -- explicit post-lock time for offer expiry and admission. An overdue OPEN
  -- offer holds no place and its departing attendee is not counted as queued.
  IF to_regclass('public.waitlist_offer') IS NOT NULL THEN
    SELECT count(*) INTO v_offered
      FROM public.waitlist_offer AS o
      JOIN public.registration AS r ON r.registration_id = o.registration_id
     WHERE r.event_id = p_event.event_id
       AND o.state = 'OPEN' AND o.expires_at > p_now;

    -- The registration window is already open above. Offers can still be
    -- made only before event start (also capped by registration close).
    IF p_event.start_datetime > p_now THEN
      SELECT count(*) INTO v_waiting
        FROM public.registration AS r
        JOIN public."user" AS u ON u.user_id = r.attendee_id AND u.is_active
       WHERE r.event_id = p_event.event_id AND r.registration_status = 'WAITLISTED'
         AND NOT EXISTS (
           SELECT 1 FROM public.waitlist_offer AS o
            WHERE o.registration_id = r.registration_id AND o.state = 'OPEN'
         );
    END IF;
  END IF;

  IF v_registered + v_offered + v_waiting >= LEAST(v_venue_capacity, COALESCE(p_event.registration_capacity, v_venue_capacity)) THEN
    RETURN 'FULL_WAITLIST';
  END IF;
  RETURN 'OPEN';
END;
$$;

-- 4. Direct registration, joining the waitlist and accepting an offer accept
--    PREPARATION as well as CONFIRMED.
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
  v_now timestamptz;
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
  v_now := clock_timestamp();
  IF v_event.event_id IS NULL
     OR NOT v_event.is_published
     OR v_event.end_datetime IS NULL
     OR v_event.end_datetime <= v_now
     OR v_event.status NOT IN ('CONFIRMED', 'PREPARATION') THEN
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

  -- Keep SPM-163's expiry/allocation work in this transaction under the
  -- event lock. Standalone SPM-134 does not require the waitlist module.
  IF to_regclass('public.waitlist_offer') IS NOT NULL THEN
    PERFORM public._expire_overdue_waitlist_offers(p_event_id);
    PERFORM public._offer_freed_places(p_event_id);
  END IF;

  -- All potentially waiting row locks are held. Use a fresh database clock,
  -- not transaction-start now(), for the admission decision and stored time.
  v_now := clock_timestamp();
  IF v_event.end_datetime <= v_now THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  v_availability := public._event_registration_availability_at(v_event, v_now);
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

CREATE OR REPLACE FUNCTION public.join_event_waitlist(
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
  v_event public.event;
  v_existing public.registration;
  v_registration public.registration;
  v_availability text;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_attendee_id, 'registration.join_waitlist', p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  -- Same lock and visibility as register_for_event (SPM-134).
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND
     OR NOT v_event.is_published
     OR v_event.end_datetime IS NULL
     OR v_event.end_datetime <= now()
     OR v_event.status NOT IN ('CONFIRMED', 'PREPARATION') THEN
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

  -- Places freed by overdue offers go to the people already queued first.
  PERFORM public._expire_overdue_waitlist_offers(p_event_id);
  PERFORM public._offer_freed_places(p_event_id);
  -- The waitlist takes exactly the attendees register_for_event refuses as
  -- full: the same rule (SPM-134), decided under the same event lock.
  v_availability := public.event_registration_availability(v_event);
  IF v_availability = 'NOT_YET_OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_NOT_YET_OPEN';
  ELSIF v_availability = 'CLOSED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_CLOSED';
  ELSIF v_availability = 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PLACES_AVAILABLE';
  ELSIF v_availability IS DISTINCT FROM 'FULL_WAITLIST' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_UNAVAILABLE';
  END IF;

  IF v_existing.registration_id IS NULL THEN
    INSERT INTO public.registration (
      attendee_id, event_id, registration_status, registration_datetime,
      dietary_restrictions, accessibility_requirements
    )
    VALUES (p_attendee_id, p_event_id, 'WAITLISTED', now(), p_dietary_restrictions, p_accessibility_requirements)
    RETURNING * INTO v_registration;
  ELSE
    UPDATE public.registration
       SET registration_status = 'WAITLISTED',
           registration_datetime = now(),
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
    CASE WHEN v_existing.registration_id IS NULL THEN 'WAITLIST_JOINED' ELSE 'WAITLIST_REENTERED' END,
    format('Joined the waitlist for event %s', p_event_id),
    'STAFF_ONLY'
  );

  PERFORM public._notify_registration_recorded(v_registration.registration_id);

  RETURN public._store_idempotent_response(
    p_attendee_id,
    'registration.join_waitlist',
    p_idempotency_key,
    public._waitlist_action_result(v_registration.registration_id, 'JOINED')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_waitlist_offer(
  p_attendee_id integer,
  p_event_id integer,
  p_offer_id bigint,
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
  v_event public.event;
  v_registration public.registration;
  v_offer public.waitlist_offer;
  v_registered integer;
  v_limit integer;
  v_now timestamptz;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_attendee_id, 'registration.accept_offer', p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  -- The expiry job takes the same event lock and rechecks the offer, so an
  -- accept and an expiry at the same moment cannot both succeed.
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  PERFORM 1 FROM public."user"
   WHERE user_id = p_attendee_id AND role = 'ATTENDEE' AND is_active
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOT_ATTENDEE';
  END IF;

  SELECT * INTO v_registration
    FROM public.registration
   WHERE attendee_id = p_attendee_id AND event_id = p_event_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  SELECT * INTO v_offer
    FROM public.waitlist_offer
   WHERE offer_id = p_offer_id AND registration_id = v_registration.registration_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_NOT_FOUND';
  END IF;
  -- Evaluate after every potentially waiting event/user/registration/offer lock.
  v_now := clock_timestamp();
  -- Read-time expiry: an overdue offer never takes a place (Master 5.6).
  IF v_offer.state = 'EXPIRED' OR (v_offer.state = 'OPEN' AND v_offer.expires_at <= v_now) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_EXPIRED';
  END IF;
  IF v_offer.state <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_NOT_OPEN';
  END IF;

  IF NOT v_event.is_published OR v_event.status NOT IN ('CONFIRMED', 'PREPARATION')
     OR v_event.start_datetime IS NULL OR v_event.start_datetime <= v_now
     OR v_event.registration_close_at IS NULL OR v_event.registration_close_at <= v_now THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_CLOSED';
  END IF;

  -- The offered place is already held for this attendee; refuse only when the
  -- limit has since dropped (venue changed, capacity lowered) or is unknown.
  v_limit := public._event_place_limit(v_event);
  IF v_limit IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_UNAVAILABLE';
  END IF;
  SELECT count(*) INTO v_registered
    FROM public.registration
   WHERE event_id = p_event_id AND registration_status = 'REGISTERED';
  IF v_registered >= v_limit THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_FULL';
  END IF;

  UPDATE public.waitlist_offer
     SET state = 'ACCEPTED', responded_at = v_now
   WHERE offer_id = v_offer.offer_id;

  UPDATE public.registration
     SET registration_status = 'REGISTERED',
         registration_datetime = v_now,
         withdrawal_date = NULL
   WHERE registration_id = v_registration.registration_id
  RETURNING * INTO v_registration;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, audience)
  VALUES (
    p_attendee_id,
    'registration',
    v_registration.registration_id,
    'WAITLIST_OFFER_ACCEPTED',
    format('Waitlist offer %s accepted for event %s', v_offer.offer_id, p_event_id),
    'STAFF_ONLY'
  );

  PERFORM public._notify_registration_recorded(v_registration.registration_id);

  RETURN public._store_idempotent_response(
    p_attendee_id,
    'registration.accept_offer',
    p_idempotency_key,
    public._waitlist_action_result(v_registration.registration_id, 'ACCEPTED')
  );
END;
$$;

-- 5. A place freed while the event is in PREPARATION is offered to the queue.
CREATE OR REPLACE FUNCTION public._waitlist_offer_deadline(p_event public.event)
RETURNS timestamptz
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
           WHEN p_event.is_published
            AND p_event.status IN ('CONFIRMED', 'PREPARATION')
            AND p_event.start_datetime IS NOT NULL
            AND p_event.registration_open_at IS NOT NULL
            AND p_event.registration_close_at IS NOT NULL
            AND clock_timestamp() >= p_event.registration_open_at
            AND LEAST(clock_timestamp() + interval '24 hours', p_event.start_datetime, p_event.registration_close_at) > clock_timestamp()
           THEN LEAST(clock_timestamp() + interval '24 hours', p_event.start_datetime, p_event.registration_close_at)
         END;
$$;

-- 6. Discovery index matches the discovery rule again.
DROP INDEX IF EXISTS public.event_attendee_discovery_idx;
CREATE INDEX event_attendee_discovery_idx
  ON public.event (start_datetime, event_id)
  WHERE is_published AND status IN ('CONFIRMED', 'PREPARATION');

-- 7. Backfill. Before this migration nothing set is_published, so events that
--    were confirmed through the real transition stayed hidden. Publish exactly
--    those that are still attendee-facing: currently CONFIRMED or PREPARATION,
--    confirmed at least once, unpublished, and not ended. Rows never confirmed
--    (inserted directly in a lifecycle state) and every other state are left
--    unchanged. Confirmation snapshots are history and are not rewritten.
UPDATE public.event
   SET is_published = true
 WHERE status IN ('CONFIRMED', 'PREPARATION')
   AND previously_confirmed
   AND NOT is_published
   AND end_datetime > now();

COMMIT;
