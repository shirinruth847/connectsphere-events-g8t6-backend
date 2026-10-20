-- SPM-174/SPM-180: database-level defense in depth against overlapping
-- coordinator assignments. The assign/reassign RPCs already serialize via
-- FOR UPDATE row locks and recheck overlap inside a single transaction; this
-- exclusion constraint guarantees the invariant even if a code path bypasses
-- the RPC or a race slips past the application check.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Existing rows must satisfy the invariant before PostgreSQL can install the
-- exclusion constraint. Fail with actionable event IDs rather than silently
-- changing ownership or status during migration rollout.
DO $$
DECLARE
  conflict_count bigint;
  conflict_events text;
BEGIN
  SELECT count(*)
    INTO conflict_count
    FROM public.event AS first_event
    JOIN public.event AS second_event
      ON second_event.coordinator_id = first_event.coordinator_id
     AND second_event.event_id > first_event.event_id
     AND tstzrange(second_event.start_datetime, second_event.end_datetime)
         && tstzrange(first_event.start_datetime, first_event.end_datetime)
   WHERE first_event.coordinator_id IS NOT NULL
     AND first_event.status NOT IN ('DRAFT', 'COMPLETED', 'REJECTED', 'CANCELLED')
     AND second_event.status NOT IN ('DRAFT', 'COMPLETED', 'REJECTED', 'CANCELLED');

  IF conflict_count > 0 THEN
    SELECT string_agg(format('%s/%s/%s', first_event_id, second_event_id, coordinator_id), ', ')
      INTO conflict_events
      FROM (
        SELECT first_event.event_id AS first_event_id,
               second_event.event_id AS second_event_id,
               first_event.coordinator_id
          FROM public.event AS first_event
          JOIN public.event AS second_event
            ON second_event.coordinator_id = first_event.coordinator_id
           AND second_event.event_id > first_event.event_id
           AND tstzrange(second_event.start_datetime, second_event.end_datetime)
               && tstzrange(first_event.start_datetime, first_event.end_datetime)
         WHERE first_event.coordinator_id IS NOT NULL
           AND first_event.status NOT IN ('DRAFT', 'COMPLETED', 'REJECTED', 'CANCELLED')
           AND second_event.status NOT IN ('DRAFT', 'COMPLETED', 'REJECTED', 'CANCELLED')
         ORDER BY first_event.event_id, second_event.event_id
         LIMIT 20
      ) AS sample;
    RAISE EXCEPTION 'Cannot add coordinator overlap constraint: % conflicting event pairs exist. Sample event_id/coordinator_id values: %',
      conflict_count, conflict_events
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

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
