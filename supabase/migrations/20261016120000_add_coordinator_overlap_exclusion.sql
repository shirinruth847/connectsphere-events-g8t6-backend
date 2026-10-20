-- SPM-174/SPM-180: database-level defense in depth against overlapping
-- coordinator assignments. The assign/reassign RPCs already serialize via
-- FOR UPDATE row locks and recheck overlap inside a single transaction; this
-- exclusion constraint guarantees the invariant even if a code path bypasses
-- the RPC or a race slips past the application check.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE public.event
  ADD CONSTRAINT event_no_overlapping_coordinator_assignment
  EXCLUDE USING gist (
    coordinator_id WITH =,
    tstzrange(start_datetime, end_datetime) WITH &&
  )
  WHERE (
    coordinator_id IS NOT NULL
    AND status NOT IN ('DRAFT', 'COMPLETED', 'REJECTED', 'CANCELLED')
  );
