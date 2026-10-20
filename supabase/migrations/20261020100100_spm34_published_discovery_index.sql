-- Run after the preceding enum migration has committed.
BEGIN;
DROP INDEX IF EXISTS public.event_attendee_discovery_idx;
CREATE INDEX event_attendee_discovery_idx
  ON public.event (start_datetime, event_id)
  WHERE is_published AND status IN ('CONFIRMED', 'PREPARATION');
COMMIT;
