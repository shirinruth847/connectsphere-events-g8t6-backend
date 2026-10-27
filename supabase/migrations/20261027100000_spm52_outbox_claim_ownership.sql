-- SPM-52: fence worker results by a monotonically increasing claim generation.
-- Stop all sync workers (including post-commit appliers) before deployment.
-- Old result RPCs are removed so an older worker cannot bypass ownership checks.
-- Existing payloads and retry history are retained. A latest-generation late
-- success may complete after expiry/terminal failure, but not after reclamation.
BEGIN;

ALTER TABLE public.outbox_entries
  ADD COLUMN claim_generation bigint NOT NULL DEFAULT 0
  CONSTRAINT outbox_entries_claim_generation_check CHECK (claim_generation >= 0);

CREATE OR REPLACE FUNCTION public.claim_outbox_entries(p_limit integer, p_lease_seconds integer, p_max_attempts integer DEFAULT 8)
RETURNS SETOF public.outbox_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.outbox_entries AS o
     SET attempts = o.attempts + 1,
         state = 'FAILED',
         lease_expires_at = NULL,
         last_error = 'Lease expired before the attempt was recorded'
   WHERE o.entry_id IN (
     SELECT entry_id
       FROM public.outbox_entries
      WHERE state = 'PENDING'
        AND lease_expires_at <= now()
        AND attempts + 1 >= greatest(p_max_attempts, 1)
      ORDER BY entry_id
      LIMIT least(greatest(p_limit, 1), 100)
        FOR UPDATE SKIP LOCKED
   );

  RETURN QUERY
  WITH claimed AS (
    UPDATE public.outbox_entries AS o
       SET claim_generation = o.claim_generation + 1,
           lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
           attempts = o.attempts + CASE WHEN o.lease_expires_at IS NULL THEN 0 ELSE 1 END
     WHERE o.entry_id IN (
       SELECT entry_id
         FROM public.outbox_entries
        WHERE state = 'PENDING'
          AND next_attempt_at <= now()
          AND (lease_expires_at IS NULL OR lease_expires_at <= now())
        ORDER BY next_attempt_at, entry_id
        LIMIT least(greatest(p_limit, 1), 100)
          FOR UPDATE SKIP LOCKED
     )
    RETURNING o.*
  )
  SELECT * FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_outbox_entry(p_entry_id bigint, p_lease_seconds integer, p_max_attempts integer DEFAULT 8)
RETURNS SETOF public.outbox_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_entry public.outbox_entries;
BEGIN
  SELECT * INTO v_entry
    FROM public.outbox_entries
   WHERE entry_id = p_entry_id
     AND state = 'PENDING'
     AND (lease_expires_at IS NULL OR lease_expires_at <= now())
     FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_entry.lease_expires_at IS NOT NULL AND v_entry.attempts + 1 >= greatest(p_max_attempts, 1) THEN
    UPDATE public.outbox_entries
       SET attempts = attempts + 1,
           state = 'FAILED',
           lease_expires_at = NULL,
           last_error = 'Lease expired before the attempt was recorded'
     WHERE entry_id = p_entry_id;
    RETURN;
  END IF;

  RETURN QUERY
  WITH claimed AS (
    UPDATE public.outbox_entries AS o
       SET claim_generation = o.claim_generation + 1,
           lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
           attempts = o.attempts + CASE WHEN o.lease_expires_at IS NULL THEN 0 ELSE 1 END
     WHERE o.entry_id = p_entry_id
    RETURNING o.*
  )
  SELECT * FROM claimed;
END;
$$;

DROP FUNCTION public.release_outbox_entry(bigint, text, integer);
DROP FUNCTION public.fail_outbox_entry(bigint, text, integer);
DROP FUNCTION public.complete_outbox_entry(bigint);

CREATE FUNCTION public.release_outbox_entry(
  p_entry_id bigint, p_claim_generation bigint, p_error text, p_retry_seconds integer DEFAULT 30
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.outbox_entries
     SET lease_expires_at = NULL,
         next_attempt_at = now() + make_interval(secs => greatest(p_retry_seconds, 1)),
         last_error = left(coalesce(p_error, 'MongoDB unavailable'), 500)
   WHERE entry_id = p_entry_id
     AND claim_generation = p_claim_generation AND p_claim_generation > 0
     AND lease_expires_at IS NOT NULL AND state = 'PENDING';
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.fail_outbox_entry(
  p_entry_id bigint, p_claim_generation bigint, p_error text, p_max_attempts integer DEFAULT 8
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state text;
BEGIN
  UPDATE public.outbox_entries
     SET attempts = attempts + 1,
         state = CASE WHEN attempts + 1 >= greatest(p_max_attempts, 1) THEN 'FAILED' ELSE 'PENDING' END,
         next_attempt_at = now() + least(interval '1 hour', interval '30 seconds' * power(2, least(attempts, 10))),
         lease_expires_at = NULL,
         last_error = left(coalesce(p_error, 'Unknown error'), 500)
   WHERE entry_id = p_entry_id
     AND claim_generation = p_claim_generation AND p_claim_generation > 0
     AND lease_expires_at IS NOT NULL AND state = 'PENDING'
  RETURNING state INTO v_state;
  RETURN v_state;
END;
$$;

CREATE FUNCTION public.complete_outbox_entry(p_entry_id bigint, p_claim_generation bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_entry public.outbox_entries;
BEGIN
  UPDATE public.outbox_entries
     SET state = 'APPLIED', applied_at = now(), lease_expires_at = NULL, last_error = NULL
   WHERE entry_id = p_entry_id
     AND claim_generation = p_claim_generation AND p_claim_generation > 0
     AND (state = 'FAILED' OR (state = 'PENDING' AND lease_expires_at IS NOT NULL))
  RETURNING * INTO v_entry;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_entry.target_collection = 'equipment_details' THEN
    UPDATE public.equipment SET details_pending = false
     WHERE equipment_id = v_entry.document_id::integer AND details_pending;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.release_outbox_entry(bigint, bigint, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_outbox_entry(bigint, bigint, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_outbox_entry(bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_outbox_entry(bigint, bigint, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_outbox_entry(bigint, bigint, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_outbox_entry(bigint, bigint) TO service_role;

COMMIT;
