-- SPM-163/147 follow SPM-134's final capacity rule (20261030142619, Master
-- 1.10): the place limit is the primary venue's max_capacity, lowered by
-- registration_capacity when the organiser set one, and an event without a
-- primary venue has no places (never "unlimited"). 20261030170100 and
-- 20261030170200 read registration_capacity alone.
--
-- Rebuilt from the live definitions with these changes only:
--   * _free_places and the late-withdrawal notice use _event_place_limit;
--   * _offer_freed_places offers nothing when the limit is unknown;
--   * join_event_waitlist refuses with event_registration_availability, so
--     the waitlist opens exactly when direct registration refuses as full
--     (adds REGISTRATION_NOT_YET_OPEN and REGISTRATION_UNAVAILABLE);
--   * accept_waitlist_offer checks the same limit (adds
--     REGISTRATION_UNAVAILABLE).

-- The limit event_registration_availability applies. NULL when the event has
-- no primary venue (LEAST alone would ignore the missing venue).
CREATE FUNCTION public._event_place_limit(p_event public.event)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN v.max_capacity IS NOT NULL
              THEN LEAST(v.max_capacity, COALESCE(p_event.registration_capacity, v.max_capacity))
         END
    FROM (SELECT min(max_capacity) AS max_capacity FROM public._event_primary_venue(p_event.event_id)) AS v;
$$;

REVOKE ALL ON FUNCTION public._event_place_limit(public.event) FROM PUBLIC, anon, authenticated, service_role;


CREATE OR REPLACE FUNCTION public._free_places(p_event_id integer)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public._event_place_limit(e)
         - (SELECT count(*) FROM public.registration AS r
             WHERE r.event_id = e.event_id AND r.registration_status = 'REGISTERED')::integer
         - (SELECT count(*) FROM public.waitlist_offer AS o
              JOIN public.registration AS r ON r.registration_id = o.registration_id
             WHERE r.event_id = e.event_id AND o.state = 'OPEN')::integer
    FROM public.event AS e
   WHERE e.event_id = p_event_id;
$$;

CREATE OR REPLACE FUNCTION public._offer_freed_places(p_event_id integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_free integer;
  v_expires_at timestamptz;
  v_next record;
  v_offer_id bigint;
  v_offered integer := 0;
BEGIN
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id;
  IF NOT FOUND
     OR NOT v_event.is_published
     OR v_event.status <> 'CONFIRMED'
     OR v_event.start_datetime IS NULL THEN
    RETURN 0;
  END IF;

  v_expires_at := LEAST(
    now() + interval '24 hours',
    v_event.start_datetime,
    COALESCE(v_event.registration_close_at, 'infinity'::timestamptz)
  );
  IF v_expires_at <= now() THEN
    RETURN 0;
  END IF;

  v_free := public._free_places(p_event_id);
  IF v_free IS NULL OR v_free <= 0 THEN
    RETURN 0;
  END IF;

  FOR v_next IN
    SELECT r.registration_id
      FROM public.registration AS r
      JOIN public."user" AS u ON u.user_id = r.attendee_id AND u.is_active
     WHERE r.event_id = p_event_id
       AND r.registration_status = 'WAITLISTED'
       AND NOT EXISTS (
         SELECT 1 FROM public.waitlist_offer AS o
          WHERE o.registration_id = r.registration_id AND o.state = 'OPEN'
       )
     ORDER BY r.queue_order
     LIMIT v_free
     FOR UPDATE OF r
  LOOP
    INSERT INTO public.waitlist_offer (registration_id, offered_at, expires_at)
    VALUES (v_next.registration_id, now(), v_expires_at)
    RETURNING offer_id INTO v_offer_id;

    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, audience, actor_role)
    VALUES (
      NULL,
      'registration',
      v_next.registration_id,
      'WAITLIST_OFFER_CREATED',
      format('Waitlist offer %s for event %s, open until %s', v_offer_id, p_event_id, v_expires_at),
      'STAFF_ONLY',
      'SYSTEM'
    );

    PERFORM public._notify_place_offered(v_next.registration_id, v_offer_id, v_expires_at);
    v_offered := v_offered + 1;
  END LOOP;
  RETURN v_offered;
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
  -- Read-time expiry: an overdue offer never takes a place (Master 5.6).
  IF v_offer.state = 'EXPIRED' OR (v_offer.state = 'OPEN' AND v_offer.expires_at <= now()) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_EXPIRED';
  END IF;
  IF v_offer.state <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_NOT_OPEN';
  END IF;

  IF NOT v_event.is_published OR v_event.status <> 'CONFIRMED' THEN
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
     SET state = 'ACCEPTED', responded_at = now()
   WHERE offer_id = v_offer.offer_id;

  UPDATE public.registration
     SET registration_status = 'REGISTERED',
         registration_datetime = now(),
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

CREATE OR REPLACE FUNCTION public._notify_late_withdrawal(p_registration_id integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_registration public.registration;
  v_event public.event;
  v_registered integer;
  v_limit integer;
BEGIN
  SELECT * INTO v_registration FROM public.registration WHERE registration_id = p_registration_id;
  IF NOT FOUND OR v_registration.registration_status <> 'WITHDRAWN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_NOT_WITHDRAWN';
  END IF;
  SELECT * INTO v_event FROM public.event WHERE event_id = v_registration.event_id;
  SELECT count(*) INTO v_registered
    FROM public.registration
   WHERE event_id = v_event.event_id AND registration_status = 'REGISTERED';
  v_limit := public._event_place_limit(v_event);

  RETURN public._notify_event_users(
    v_event.event_id,
    'Late withdrawal',
    format(
      'An attendee withdrew from "%s", which starts %s. Registered now: %s%s.',
      v_event.title,
      public._attendee_datetime_text(v_event.start_datetime),
      v_registered,
      CASE WHEN v_limit IS NULL THEN '' ELSE format(' of %s', v_limit) END
    ),
    ARRAY(SELECT user_id FROM public."user" WHERE user_id = v_event.organiser_id AND is_active),
    'REGISTRATION_ALERT',
    format('LATE_WITHDRAWAL:%s:%s', p_registration_id, public._notification_key_time(v_registration.withdrawal_date)),
    NULL
  );
END;
$$;
