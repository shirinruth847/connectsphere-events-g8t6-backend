-- SPM-286 / SPM-287: allow the two technical request operations in
-- idempotency_records. 20261031090000 claims keys for
-- 'event.request_technical_support' and 'technical_request.decide', which the
-- live operation check refuses (23514) until this runs. The current check is
-- read and extended, so operations added by other tickets are kept.

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
       ADD CONSTRAINT idempotency_records_operation_check CHECK ((%s) OR operation = ANY (ARRAY[%L, %L]))',
    v_existing_check, 'event.request_technical_support', 'technical_request.decide'
  );
END;
$idempotency_operations$;
