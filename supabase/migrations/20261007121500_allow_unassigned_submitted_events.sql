-- SPM-174: submitted requests must be assignable by Coordinator operations.
-- Assignment is intentionally deferred until a coordinator selects one.
ALTER TABLE public.event
  DROP CONSTRAINT IF EXISTS event_coordinator_after_submission_check,
  DROP CONSTRAINT IF EXISTS event_submitted_coordinator_check;
