-- SPM-163/147: decide acceptance/withdrawal with fresh post-lock time.
-- Applied migrations remain unchanged. Existing successful idempotent responses
-- replay before deadline validation; new attempts are checked at admission.
-- No backfill, schema change or HTTP-contract change. Retain on app rollback.
BEGIN;

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

  IF NOT v_event.is_published OR v_event.status <> 'CONFIRMED'
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

CREATE OR REPLACE FUNCTION public.withdraw_event_registration(
  p_attendee_id integer,
  p_event_id integer,
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
  v_late boolean;
  v_now timestamptz;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_attendee_id, 'registration.withdraw', p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  SELECT * INTO v_registration
    FROM public.registration
   WHERE attendee_id = p_attendee_id AND event_id = p_event_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  IF v_registration.registration_status <> 'REGISTERED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOT_REGISTERED';
  END IF;

  -- The transaction may have started before waiting for these locks.
  v_now := clock_timestamp();
  IF v_event.status = 'COMPLETED' OR v_event.start_datetime IS NULL OR v_event.start_datetime <= v_now THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_STARTED';
  END IF;
  IF v_event.status IN ('CANCELLED', 'REJECTED') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_ACTIVE';
  END IF;

  UPDATE public.registration
     SET registration_status = 'WITHDRAWN', withdrawal_date = v_now
   WHERE registration_id = v_registration.registration_id
  RETURNING * INTO v_registration;

  v_late := v_event.start_datetime <= v_now + interval '24 hours';

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, audience)
  VALUES (
    p_attendee_id,
    'registration',
    v_registration.registration_id,
    'REGISTRATION_WITHDRAWN',
    format('Withdrew from event %s%s', p_event_id, CASE WHEN v_late THEN ' within 24 hours of the start' ELSE '' END),
    'STAFF_ONLY'
  );

  PERFORM public._notify_registration_withdrawn(v_registration.registration_id);
  IF v_late THEN
    PERFORM public._notify_late_withdrawal(v_registration.registration_id);
  END IF;

  PERFORM public._expire_overdue_waitlist_offers(p_event_id);
  PERFORM public._offer_freed_places(p_event_id);

  RETURN public._store_idempotent_response(
    p_attendee_id,
    'registration.withdraw',
    p_idempotency_key,
    jsonb_set(
      public._waitlist_action_result(v_registration.registration_id, 'WITHDRAWN'),
      '{registration,late_withdrawal}',
      to_jsonb(v_late)
    )
  );
END;
$$;

-- Shared expiry, decline and offer helpers must not reuse transaction-start time.
CREATE OR REPLACE FUNCTION public._expire_overdue_waitlist_offers(p_event_id integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_due record;
  v_expired integer := 0;
BEGIN
  FOR v_due IN
    SELECT o.offer_id, o.registration_id
      FROM public.waitlist_offer AS o
      JOIN public.registration AS r ON r.registration_id = o.registration_id
     WHERE r.event_id = p_event_id
       AND o.state = 'OPEN'
       AND o.expires_at <= clock_timestamp()
     ORDER BY o.registration_id
     FOR UPDATE OF r, o
  LOOP
    PERFORM public._end_waitlist_place(v_due.registration_id, v_due.offer_id, 'EXPIRED', NULL);
    v_expired := v_expired + 1;
  END LOOP;
  RETURN v_expired;
END;
$$;

CREATE OR REPLACE FUNCTION public._end_waitlist_place(
  p_registration_id integer,
  p_offer_id bigint,
  p_outcome text,
  p_actor_id integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_registration public.registration;
  v_title text;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('LEFT', 'DECLINED', 'EXPIRED')
     OR (p_outcome = 'LEFT') <> (p_offer_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'WAITLIST_OUTCOME_INVALID';
  END IF;

  IF p_offer_id IS NOT NULL THEN
    UPDATE public.waitlist_offer
       SET state = p_outcome, responded_at = clock_timestamp()
     WHERE offer_id = p_offer_id
       AND registration_id = p_registration_id
       AND state = 'OPEN';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_NOT_OPEN';
    END IF;
  END IF;

  UPDATE public.registration
     SET registration_status = 'WITHDRAWN', withdrawal_date = clock_timestamp()
   WHERE registration_id = p_registration_id
     AND registration_status = 'WAITLISTED'
  RETURNING * INTO v_registration;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOT_WAITLISTED';
  END IF;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, audience, actor_role)
  VALUES (
    p_actor_id,
    'registration',
    p_registration_id,
    CASE p_outcome
      WHEN 'LEFT' THEN 'WAITLIST_LEFT'
      WHEN 'DECLINED' THEN 'WAITLIST_OFFER_DECLINED'
      ELSE 'WAITLIST_OFFER_EXPIRED'
    END,
    CASE
      WHEN p_offer_id IS NULL THEN format('Left the waitlist for event %s', v_registration.event_id)
      ELSE format('Waitlist offer %s %s for event %s', p_offer_id, lower(p_outcome), v_registration.event_id)
    END,
    'STAFF_ONLY',
    CASE WHEN p_actor_id IS NULL THEN 'SYSTEM' END
  );

  SELECT title INTO v_title FROM public.event WHERE event_id = v_registration.event_id;
  PERFORM public._notify_event_users(
    v_registration.event_id,
    CASE p_outcome
      WHEN 'EXPIRED' THEN 'Place offer expired'
      WHEN 'DECLINED' THEN 'Place declined'
      ELSE 'You left the waitlist'
    END,
    format(
      '%s To attend, register again; if the event is still full, you''ll join the back of the waitlist.',
      CASE p_outcome
        WHEN 'EXPIRED' THEN format('Your offer of a place at "%s" expired, so you''ve left the waitlist.', v_title)
        WHEN 'DECLINED' THEN format('You declined the place at "%s" and left the waitlist.', v_title)
        ELSE format('You left the waitlist for "%s".', v_title)
      END
    ),
    ARRAY(SELECT user_id FROM public."user" WHERE user_id = v_registration.attendee_id AND is_active),
    'WAITLIST_LEFT',
    format('WAITLIST_LEFT:%s:%s', p_registration_id, public._notification_key_time(v_registration.withdrawal_date)),
    NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.decline_waitlist_offer(
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
  v_registration public.registration;
  v_offer public.waitlist_offer;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_attendee_id, 'registration.decline_offer', p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  PERFORM 1 FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
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
  IF v_offer.state = 'EXPIRED' OR (v_offer.state = 'OPEN' AND v_offer.expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_EXPIRED';
  END IF;
  IF v_offer.state <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_NOT_OPEN';
  END IF;

  PERFORM public._end_waitlist_place(v_registration.registration_id, v_offer.offer_id, 'DECLINED', p_attendee_id);
  PERFORM public._expire_overdue_waitlist_offers(p_event_id);
  PERFORM public._offer_freed_places(p_event_id);

  RETURN public._store_idempotent_response(
    p_attendee_id,
    'registration.decline_offer',
    p_idempotency_key,
    public._waitlist_action_result(v_registration.registration_id, 'DECLINED')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._places_held(p_event_id integer)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT (SELECT count(*) FROM public.registration AS r
           WHERE r.event_id = p_event_id AND r.registration_status = 'REGISTERED')::integer
       + (SELECT count(*) FROM public.waitlist_offer AS o
            JOIN public.registration AS r ON r.registration_id = o.registration_id
           WHERE r.event_id = p_event_id AND o.state = 'OPEN' AND o.expires_at > clock_timestamp())::integer;
$$;

CREATE OR REPLACE FUNCTION public._waitlist_offer_deadline(p_event public.event)
RETURNS timestamptz
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
           WHEN p_event.is_published
            AND p_event.status = 'CONFIRMED'
            AND p_event.start_datetime IS NOT NULL
            AND p_event.registration_open_at IS NOT NULL
            AND p_event.registration_close_at IS NOT NULL
            AND clock_timestamp() >= p_event.registration_open_at
            AND LEAST(clock_timestamp() + interval '24 hours', p_event.start_datetime, p_event.registration_close_at) > clock_timestamp()
           THEN LEAST(clock_timestamp() + interval '24 hours', p_event.start_datetime, p_event.registration_close_at)
         END;
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
    -- Queue-row locks may also wait. Recheck the offer window afterwards.
    v_expires_at := public._waitlist_offer_deadline(v_event);
    EXIT WHEN v_expires_at IS NULL;
    INSERT INTO public.waitlist_offer (registration_id, offered_at, expires_at)
    VALUES (v_next.registration_id, clock_timestamp(), v_expires_at)
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

-- CREATE OR REPLACE preserves existing ACLs; explicitly retain backend-only access.
REVOKE ALL ON FUNCTION public.accept_waitlist_offer(integer,integer,bigint,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_waitlist_offer(integer,integer,bigint,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.withdraw_event_registration(integer,integer,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_event_registration(integer,integer,text,text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
