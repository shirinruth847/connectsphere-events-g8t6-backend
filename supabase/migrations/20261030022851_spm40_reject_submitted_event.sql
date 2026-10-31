-- SPM-40: rejection of a submitted request while UNDER_REVIEW.
-- Planning/resource-release rejection is a separate workflow.
BEGIN;
DO $operations$
DECLARE v_existing text;
BEGIN
  LOCK TABLE public.idempotency_records IN ACCESS EXCLUSIVE MODE;
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT v_existing FROM pg_constraint
   WHERE conrelid='public.idempotency_records'::regclass
     AND conname='idempotency_records_operation_check' AND contype='c';
  EXECUTE format('ALTER TABLE public.idempotency_records DROP CONSTRAINT idempotency_records_operation_check,
    ADD CONSTRAINT idempotency_records_operation_check CHECK ((%s) OR operation = %L)', v_existing, 'event.reject_request');
END;
$operations$;

CREATE FUNCTION public.reject_submitted_event(
  p_event_id integer, p_actor_id integer, p_expected_version integer,
  p_reason text, p_idempotency_key text, p_request_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_event public.event;
  v_replay jsonb;
  v_reason text := btrim(p_reason);
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_EVENT_PATCH';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 10 OR char_length(v_reason) > 2000 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_REJECTION_REASON';
  END IF;
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  SELECT * INTO v_event FROM public.event
   WHERE event_id=p_event_id AND coordinator_id=p_actor_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='EVENT_NOT_FOUND'; END IF;
  PERFORM 1 FROM public."user" WHERE user_id=p_actor_id AND role='COORDINATOR' AND is_active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='FORBIDDEN'; END IF;
  v_replay := public._claim_idempotency_key(p_actor_id,'event.reject_request',p_idempotency_key,p_request_hash);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  PERFORM public._check_event_transition(v_event,'reject',p_actor_id,p_expected_version);
  IF v_event.status::text <> 'UNDER_REVIEW' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='TRANSITION_NOT_ALLOWED', DETAIL=v_event.status::text;
  END IF;
  v_event := public._apply_event_transition(v_event,'reject',p_actor_id,v_reason);
  PERFORM public._notify_event_users(p_event_id,'Event request rejected',
    format('Your event request "%s" was rejected. Reason: %s',v_event.title,v_reason),ARRAY[v_event.organiser_id]);
  RETURN public._store_idempotent_response(p_actor_id,'event.reject_request',p_idempotency_key,
    jsonb_build_object('event',to_jsonb(v_event)));
END;
$$;
REVOKE ALL ON FUNCTION public.reject_submitted_event(integer,integer,integer,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reject_submitted_event(integer,integer,integer,text,text,text) TO service_role;
COMMIT;
