-- SPM-44 limits attendee discovery to published CONFIRMED events, so the
-- SPM-34 index no longer needs PREPARATION rows. Columns and order are unchanged.
BEGIN;
DROP INDEX IF EXISTS public.event_attendee_discovery_idx;
CREATE INDEX event_attendee_discovery_idx
  ON public.event (start_datetime, event_id)
  WHERE is_published AND status = 'CONFIRMED';
COMMIT;
