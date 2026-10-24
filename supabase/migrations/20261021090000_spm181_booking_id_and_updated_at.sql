-- SPM-181 follow-up (2026-10-21).
--   * The booking reference shown to Venue Staff is the existing
--     venue_booking.booking_id, so the generated booking_reference column
--     (VB-000123, migration 20261020070631) is dropped with its unique
--     constraint. No function, view or trigger references it.
--   * updated_at records the last change to a booking, for the "Last edited"
--     sort on My Requests. Existing rows start at their created_at; a trigger
--     keeps it current on every update.
-- Applied manually in the Supabase SQL editor (the developer runs it); the
-- final INSERT records it in the migration history so the file and the
-- project history stay aligned.

BEGIN;

ALTER TABLE public.venue_booking DROP COLUMN booking_reference;

ALTER TABLE public.venue_booking ADD COLUMN updated_at timestamptz;
UPDATE public.venue_booking SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE public.venue_booking
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

CREATE FUNCTION public._touch_venue_booking_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER venue_booking_touch_updated_at
  BEFORE UPDATE ON public.venue_booking
  FOR EACH ROW EXECUTE FUNCTION public._touch_venue_booking_updated_at();

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261021090000', 'spm181_booking_id_and_updated_at');

COMMIT;
