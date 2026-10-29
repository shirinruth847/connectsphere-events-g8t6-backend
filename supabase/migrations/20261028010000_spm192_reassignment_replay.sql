-- SPM-192 AC10: a replay must not repeat the reassignment or its owner notice,
-- including after another command has reassigned the event back again.
-- Preserve operations added by other branches and their existing replay rows.
DO $idempotency_operations$
DECLARE
  v_existing_check text;
BEGIN
  LOCK TABLE public.idempotency_records IN ACCESS EXCLUSIVE MODE;
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT v_existing_check
    FROM pg_constraint
   WHERE conrelid = 'public.idempotency_records'::regclass
     AND conname = 'idempotency_records_operation_check'
     AND contype = 'c';
  EXECUTE format(
    'ALTER TABLE public.idempotency_records
       DROP CONSTRAINT idempotency_records_operation_check,
       ADD CONSTRAINT idempotency_records_operation_check CHECK ((%s) OR operation = %L)',
    v_existing_check, 'event.reassign_coordinator'
  );
END;
$idempotency_operations$;

-- Delegates to the installed assignment function, preserving later SPM-193
-- notification types and future changes to that workflow. This is one database
-- transaction: command result, assignment, history and every notice roll back
-- together. The original four-argument function remains for rollout compatibility.
CREATE FUNCTION public.reassign_event_coordinator_idempotent(
  p_event_id integer,
  p_coordinator_id integer,
  p_expected_coordinator_id integer,
  p_lead_id integer,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_operation constant text := 'event.reassign_coordinator';
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  -- Event first, then user locks, consistent with the underlying workflow.
  -- Reauthorize even on replay, without requiring the old coordinator/state.
  PERFORM 1 FROM public.event
   WHERE event_id = p_event_id AND status <> 'DRAFT' AND coordinator_id IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_REASSIGNABLE';
  END IF;
  PERFORM 1 FROM public."user"
   WHERE user_id = p_lead_id AND role = 'COORDINATOR_LEAD' AND is_active
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.event_assignments
     WHERE event_id = p_event_id AND ended_at IS NULL
       AND assigned_by IS NOT NULL AND assigned_by <> p_lead_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_REASSIGNABLE';
  END IF;

  v_replay := public._claim_idempotency_key(
    p_lead_id, v_operation, p_idempotency_key, p_request_hash
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_result := public.reassign_event_coordinator(
    p_event_id, p_coordinator_id, p_expected_coordinator_id, p_lead_id
  );
  RETURN public._store_idempotent_response(
    p_lead_id, v_operation, p_idempotency_key, v_result
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reassign_event_coordinator_idempotent(integer, integer, integer, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reassign_event_coordinator_idempotent(integer, integer, integer, integer, text, text)
  TO service_role;
