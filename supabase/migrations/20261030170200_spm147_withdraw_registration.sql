-- SPM-147 Withdraw Event Registration.
--   * withdraw_event_registration is the whole operation in one transaction
--     (Master 7.1): event lock, registration WITHDRAWN, activity, the
--     attendee's confirmation, the late-withdrawal notice and the offer of the
--     freed place to the next waitlisted attendee (SPM-163
--     _offer_freed_places).
--   * Allowed in any active state before the event starts; refused once it has
--     started ("Cannot withdraw registration for past events").
--   * Within 24 hours of the start the event owner is told (SPM-192 audience:
--     owner only). The notice names no attendee.
--   * Re-entry later uses registration or the waitlist again (D05).

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
    v_existing_check, 'registration.withdraw'
  );
END;
$idempotency_operations$;

CREATE FUNCTION public._notify_registration_withdrawn(p_registration_id integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_registration public.registration;
  v_event public.event;
BEGIN
  SELECT * INTO v_registration FROM public.registration WHERE registration_id = p_registration_id;
  IF NOT FOUND OR v_registration.registration_status <> 'WITHDRAWN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_NOT_WITHDRAWN';
  END IF;
  SELECT * INTO v_event FROM public.event WHERE event_id = v_registration.event_id;

  RETURN public._notify_event_users(
    v_event.event_id,
    'Registration withdrawn',
    format(
      'You''ve withdrawn your registration for "%s" on %s. To attend, register again; if the event is full, you''ll join the back of the waitlist.',
      v_event.title,
      public._attendee_datetime_text(v_event.start_datetime)
    ),
    ARRAY(SELECT user_id FROM public."user" WHERE user_id = v_registration.attendee_id AND is_active),
    'REGISTRATION_WITHDRAWN',
    format('REGISTRATION:%s:WITHDRAWN:%s', p_registration_id, public._notification_key_time(v_registration.withdrawal_date)),
    NULL
  );
END;
$$;

CREATE FUNCTION public._notify_late_withdrawal(p_registration_id integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_registration public.registration;
  v_event public.event;
  v_registered integer;
BEGIN
  SELECT * INTO v_registration FROM public.registration WHERE registration_id = p_registration_id;
  IF NOT FOUND OR v_registration.registration_status <> 'WITHDRAWN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_NOT_WITHDRAWN';
  END IF;
  SELECT * INTO v_event FROM public.event WHERE event_id = v_registration.event_id;
  SELECT count(*) INTO v_registered
    FROM public.registration
   WHERE event_id = v_event.event_id AND registration_status = 'REGISTERED';

  RETURN public._notify_event_users(
    v_event.event_id,
    'Late withdrawal',
    format(
      'An attendee withdrew from "%s", which starts %s. Registered now: %s%s.',
      v_event.title,
      public._attendee_datetime_text(v_event.start_datetime),
      v_registered,
      CASE WHEN v_event.registration_capacity IS NULL THEN '' ELSE format(' of %s', v_event.registration_capacity) END
    ),
    ARRAY(SELECT user_id FROM public."user" WHERE user_id = v_event.organiser_id AND is_active),
    'REGISTRATION_ALERT',
    format('LATE_WITHDRAWAL:%s:%s', p_registration_id, public._notification_key_time(v_registration.withdrawal_date)),
    NULL
  );
END;
$$;

-- Refusals are P0001 with a stable message:
--   EVENT_NOT_FOUND    event missing, or no registration on it
--   NOT_REGISTERED     the place is not REGISTERED (waitlisted: leave instead)
--   EVENT_STARTED      the event has started or ended
--   EVENT_NOT_ACTIVE   the event was cancelled or rejected
CREATE FUNCTION public.withdraw_event_registration(
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

  IF v_event.status = 'COMPLETED' OR v_event.start_datetime IS NULL OR v_event.start_datetime <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_STARTED';
  END IF;
  IF v_event.status IN ('CANCELLED', 'REJECTED') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_ACTIVE';
  END IF;

  UPDATE public.registration
     SET registration_status = 'WITHDRAWN', withdrawal_date = now()
   WHERE registration_id = v_registration.registration_id
  RETURNING * INTO v_registration;

  v_late := v_event.start_datetime <= now() + interval '24 hours';

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

REVOKE ALL ON FUNCTION public._notify_registration_withdrawn(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_late_withdrawal(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.withdraw_event_registration(integer, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_event_registration(integer, integer, text, text) TO service_role;
