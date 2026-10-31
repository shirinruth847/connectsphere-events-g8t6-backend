-- SPM-39: "Approved" is display wording; feasibility acceptance enters PLANNING.
BEGIN;

-- Preserve operations introduced by other tickets (the SPM-72 upgrade pattern).
DO $operations$
DECLARE
  v_existing_check text;
BEGIN
  LOCK TABLE public.idempotency_records IN ACCESS EXCLUSIVE MODE;
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT v_existing_check
    FROM pg_constraint
   WHERE conrelid = 'public.idempotency_records'::regclass
     AND conname = 'idempotency_records_operation_check' AND contype = 'c';
  EXECUTE format(
    'ALTER TABLE public.idempotency_records
       DROP CONSTRAINT idempotency_records_operation_check,
       ADD CONSTRAINT idempotency_records_operation_check CHECK ((%s) OR operation = %L)',
    v_existing_check, 'event.accept_feasibility'
  );
END;
$operations$;

CREATE FUNCTION public.accept_event_feasibility(
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
  v_operation constant text := 'event.accept_feasibility';
  v_event public.event;
  v_owner public."user";
  v_missing text[] := ARRAY[]::text[];
  v_replay jsonb;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_PATCH';
  END IF;
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  SELECT * INTO v_event FROM public.event
   WHERE event_id = p_event_id AND coordinator_id = p_actor_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  -- Authorization is rechecked even on replay, after any reassignment has committed.
  PERFORM 1 FROM public."user"
   WHERE user_id = p_actor_id AND role = 'COORDINATOR' AND is_active FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN';
  END IF;
  v_replay := public._claim_idempotency_key(p_actor_id, v_operation, p_idempotency_key, p_request_hash);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  PERFORM public._check_event_transition(v_event, 'accept_feasibility', p_actor_id, p_expected_version);
  SELECT * INTO v_owner FROM public."user" WHERE user_id = v_event.organiser_id FOR SHARE;

  IF nullif(btrim(v_event.title), '') IS NULL THEN v_missing := array_append(v_missing, 'title'); END IF;
  IF nullif(btrim(v_event.purpose), '') IS NULL THEN v_missing := array_append(v_missing, 'purpose'); END IF;
  IF nullif(btrim(v_event.description), '') IS NULL THEN v_missing := array_append(v_missing, 'description'); END IF;
  IF v_event.start_datetime IS NULL OR NOT isfinite(v_event.start_datetime) THEN
    v_missing := array_append(v_missing, 'startDatetime');
  END IF;
  IF v_event.end_datetime IS NULL OR NOT isfinite(v_event.end_datetime)
     OR v_event.end_datetime <= v_event.start_datetime THEN
    v_missing := array_append(v_missing, 'endDatetime');
  END IF;
  IF v_event.expected_attendance IS NULL OR v_event.expected_attendance < 1 THEN
    v_missing := array_append(v_missing, 'expectedAttendance');
  END IF;
  IF nullif(btrim(v_event.preferred_layout_type), '') IS NULL THEN
    v_missing := array_append(v_missing, 'preferredLayoutType');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.event_venue_preference WHERE event_id = p_event_id) THEN
    v_missing := array_append(v_missing, 'venuePreferences');
  END IF;
  IF nullif(btrim(v_owner.name), '') IS NULL THEN v_missing := array_append(v_missing, 'contactName'); END IF;
  IF nullif(btrim(v_owner.email), '') IS NULL THEN v_missing := array_append(v_missing, 'contactEmail'); END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FEASIBILITY_REQUIREMENTS_MISSING',
      DETAIL = array_to_string(v_missing, ',');
  END IF;

  v_event := public._apply_event_transition(v_event, 'accept_feasibility', p_actor_id, 'Event request approved for planning.');
  PERFORM public._notify_event_users(p_event_id, 'Event request approved for planning',
    'Your coordinator approved the event request for planning. Venues and equipment are not booked by this approval.',
    ARRAY[v_event.organiser_id]);
  RETURN public._store_idempotent_response(p_actor_id, v_operation, p_idempotency_key,
    jsonb_build_object('event', to_jsonb(v_event)));
END;
$$;

REVOKE ALL ON FUNCTION public.accept_event_feasibility(integer, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_event_feasibility(integer, integer, integer, text, text) TO service_role;

COMMIT;
