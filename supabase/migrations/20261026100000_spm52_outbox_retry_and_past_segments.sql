-- SPM-52 review fixes (Master 7.2, 7.3).
--   * The unavailable-stock check starts at now(): segments that are already
--     over are history, so a lowered total no longer refuses edits to a record
--     that started before the change.
--   * release_outbox_entry hands an entry back without counting an attempt.
--     The backend uses it when MongoDB cannot be reached, which is an outage to
--     retry (Master 7.3 failure table), not an entry that keeps failing.
--   * Claiming an entry whose lease expired counts the abandoned attempt, and
--     marks the entry FAILED once that reaches the limit, so a worker that dies
--     mid-apply cannot make an entry retry forever.
--   * complete_outbox_entry also accepts a FAILED entry, for a slow worker that
--     finishes after its lease ran out and the entry was given up.

CREATE OR REPLACE FUNCTION public._check_unavailability_fits(
  p_equipment public.equipment,
  p_quantity integer,
  p_from timestamptz,
  p_to timestamptz,
  p_exclude_id integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_peak record;
BEGIN
  IF p_to <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNAVAILABILITY_END_IN_PAST';
  END IF;
  SELECT * INTO v_peak
    FROM public._equipment_peak_unavailable(p_equipment.equipment_id, greatest(p_from, now()), p_to, p_exclude_id);
  IF v_peak.peak + p_quantity > p_equipment.total_quantity THEN
    PERFORM public._raise_equipment_conflict('EQUIPMENT_STOCK_EXCEEDED', jsonb_build_object(
      'availableQuantity', greatest(p_equipment.total_quantity - v_peak.peak, 0),
      'periodStart', v_peak.segment_start,
      'periodEnd', v_peak.segment_end
    ));
  END IF;
END;
$$;

-- ---------- outbox ----------

DROP FUNCTION public.claim_outbox_entries(integer, integer);
DROP FUNCTION public.claim_outbox_entry(bigint, integer);

CREATE FUNCTION public.claim_outbox_entries(p_limit integer, p_lease_seconds integer, p_max_attempts integer DEFAULT 8)
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
       SET lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
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

-- The request handler's single attempt right after commit. Returns nothing when
-- the entry is already leased, applied or failed.
CREATE FUNCTION public.claim_outbox_entry(p_entry_id bigint, p_lease_seconds integer, p_max_attempts integer DEFAULT 8)
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
       SET lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
           attempts = o.attempts + CASE WHEN o.lease_expires_at IS NULL THEN 0 ELSE 1 END
     WHERE o.entry_id = p_entry_id
    RETURNING o.*
  )
  SELECT * FROM claimed;
END;
$$;

-- Hands a claimed entry back when MongoDB could not be reached: no attempt is
-- counted and the entry is due again after p_retry_seconds.
CREATE FUNCTION public.release_outbox_entry(p_entry_id bigint, p_error text, p_retry_seconds integer DEFAULT 30)
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
     AND state = 'PENDING';
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_outbox_entry(p_entry_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_entry public.outbox_entries;
BEGIN
  UPDATE public.outbox_entries
     SET state = 'APPLIED',
         applied_at = now(),
         lease_expires_at = NULL,
         last_error = NULL
   WHERE entry_id = p_entry_id
     AND state IN ('PENDING', 'FAILED')
  RETURNING * INTO v_entry;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_entry.target_collection = 'equipment_details' THEN
    UPDATE public.equipment
       SET details_pending = false
     WHERE equipment_id = v_entry.document_id::integer
       AND details_pending;
  END IF;
  RETURN true;
END;
$$;

-- ---------- privileges ----------

REVOKE ALL ON FUNCTION public.claim_outbox_entries(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_outbox_entry(bigint, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_outbox_entry(bigint, text, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_outbox_entries(integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_outbox_entry(bigint, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_outbox_entry(bigint, text, integer) TO service_role;
