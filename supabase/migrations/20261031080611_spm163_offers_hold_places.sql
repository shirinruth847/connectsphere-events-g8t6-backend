-- SPM-163: an open waitlist offer holds its place against SPM-134 direct
-- registration until it is accepted, declined or expires (Master 5.6: "An
-- invitation reserves a place until accepted, declined, expired or
-- cancelled"), and a freed place goes to the queue before any direct
-- registrant. SPM-134's place limit is unchanged: the primary venue's
-- max_capacity, lowered by registration_capacity when set (_event_place_limit).
--
-- Rebuilt from the live definitions (20261030142619, 20261031030000,
-- 20261030170100) with these changes only:
--   * _places_held: REGISTERED places plus OPEN offers still inside their
--     window. An overdue offer holds nothing, even before the job runs.
--   * _waitlist_offer_deadline: when an offer made now would end, or NULL when
--     no offer can be made. Offers follow SPM-134's registration period, so an
--     event without a registration start or end time gets none (it is
--     UNAVAILABLE, never open-ended).
--   * _free_places counts _places_held; _offer_freed_places uses the deadline.
--   * event_registration_availability is FULL_WAITLIST once held places, plus
--     the eligible attendees still queued without an offer while offers can be
--     made, reach the limit.
--   * register_for_event expires overdue offers and offers freed places to the
--     queue, under the event lock, before deciding availability.
--   * expire_due_waitlist_offers also offers places that are free while an
--     eligible queue waits. A refused direct registration rolls back the
--     offers it made, so the job hands them out instead.
-- Lock order stays event, then registrations, then offers (Master 7).

CREATE FUNCTION public._places_held(p_event_id integer)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT (SELECT count(*) FROM public.registration AS r
           WHERE r.event_id = p_event_id AND r.registration_status = 'REGISTERED')::integer
       + (SELECT count(*) FROM public.waitlist_offer AS o
            JOIN public.registration AS r ON r.registration_id = o.registration_id
           WHERE r.event_id = p_event_id AND o.state = 'OPEN' AND o.expires_at > now())::integer;
$$;

-- 24 hours, capped at registration close and event start (D05).
CREATE FUNCTION public._waitlist_offer_deadline(p_event public.event)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
           WHEN p_event.is_published
            AND p_event.status = 'CONFIRMED'
            AND p_event.start_datetime IS NOT NULL
            AND p_event.registration_open_at IS NOT NULL
            AND p_event.registration_close_at IS NOT NULL
            AND now() >= p_event.registration_open_at
            AND LEAST(now() + interval '24 hours', p_event.start_datetime, p_event.registration_close_at) > now()
           THEN LEAST(now() + interval '24 hours', p_event.start_datetime, p_event.registration_close_at)
         END;
$$;

REVOKE ALL ON FUNCTION public._places_held(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._waitlist_offer_deadline(public.event) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._free_places(p_event_id integer)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public._event_place_limit(e) - public._places_held(e.event_id)
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
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  v_expires_at := public._waitlist_offer_deadline(v_event);
  IF v_expires_at IS NULL THEN
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

CREATE OR REPLACE FUNCTION public.event_registration_availability(p_event public.event)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := now();
  v_limit integer;
  v_waiting integer := 0;
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

  v_limit := public._event_place_limit(p_event);
  IF v_limit IS NULL THEN
    RETURN 'UNAVAILABLE';
  END IF;

  -- A free place is owed to the eligible attendees queued without an offer
  -- for as long as offers can be made; one with an overdue offer is leaving
  -- the queue and is not counted.
  IF public._waitlist_offer_deadline(p_event) IS NOT NULL THEN
    SELECT count(*) INTO v_waiting
      FROM public.registration AS r
      JOIN public."user" AS u ON u.user_id = r.attendee_id AND u.is_active
     WHERE r.event_id = p_event.event_id
       AND r.registration_status = 'WAITLISTED'
       AND NOT EXISTS (
         SELECT 1 FROM public.waitlist_offer AS o
          WHERE o.registration_id = r.registration_id AND o.state = 'OPEN'
       );
  END IF;

  IF public._places_held(p_event.event_id) + v_waiting >= v_limit THEN
    RETURN 'FULL_WAITLIST';
  END IF;
  RETURN 'OPEN';
END;
$$;

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

  -- Places freed by overdue offers or capacity go to the queue first
  -- (SPM-163); only what is left after those offers is open to this attendee.
  PERFORM public._expire_overdue_waitlist_offers(p_event_id);
  PERFORM public._offer_freed_places(p_event_id);

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

-- Expires overdue offers and offers free places on, for up to p_limit events.
-- An event qualifies with an overdue offer, or with a free place while an
-- eligible attendee waits without an offer. Database time and event locks make
-- late, repeated or parallel runs safe: a busy event is skipped and picked up
-- by the next run. Returns the number of offers expired.
CREATE OR REPLACE FUNCTION public.expire_due_waitlist_offers(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event_id integer;
  v_expired integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_LIMIT';
  END IF;

  FOR v_event_id IN
    SELECT due.event_id
      FROM (
        SELECT r.event_id
          FROM public.waitlist_offer AS o
          JOIN public.registration AS r ON r.registration_id = o.registration_id
         WHERE o.state = 'OPEN' AND o.expires_at <= now()
        UNION
        SELECT e.event_id
          FROM public.event AS e
         WHERE EXISTS (
                 SELECT 1
                   FROM public.registration AS r
                   JOIN public."user" AS u ON u.user_id = r.attendee_id AND u.is_active
                  WHERE r.event_id = e.event_id
                    AND r.registration_status = 'WAITLISTED'
                    AND NOT EXISTS (
                      SELECT 1 FROM public.waitlist_offer AS o
                       WHERE o.registration_id = r.registration_id AND o.state = 'OPEN'
                    )
               )
           AND public._waitlist_offer_deadline(e) IS NOT NULL
           AND public._free_places(e.event_id) > 0
      ) AS due
     ORDER BY due.event_id
     LIMIT p_limit
  LOOP
    PERFORM 1 FROM public.event WHERE event_id = v_event_id FOR UPDATE SKIP LOCKED;
    IF FOUND THEN
      v_expired := v_expired + public._expire_overdue_waitlist_offers(v_event_id);
      PERFORM public._offer_freed_places(v_event_id);
    END IF;
  END LOOP;
  RETURN v_expired;
END;
$$;
