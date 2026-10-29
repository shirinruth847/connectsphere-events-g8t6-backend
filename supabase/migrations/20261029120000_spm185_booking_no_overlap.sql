-- SPM-185 (2026-10-29): setup and turnaround time in venue conflict detection.
-- Builds on 20261028161211_spm179_venue_booking_venue_link (SPM-179), which
-- added venue_booking.venue_id, occupied_range and venue_booking_occupied_range_check.
--   * public.venue_occupied_range is the one place that computes a booking's
--     occupied range, [start - setup, end + turnaround), half-open (Master
--     5.4.1, 7.2), from the venue's MongoDB minutes (T27).
--   * venue_booking_no_overlap (Master 6.3): two PENDING or APPROVED bookings
--     at one venue never have overlapping occupied ranges, even when both
--     requests commit at the same moment (SPM-185 AC7); the loser gets 23P01.
--     Holds and blocks live in MongoDB and are checked under the venue lock
--     (Master 7.4, SPM-188), not here. Rows without a range are ignored;
--     20261029120100_spm185_backfill_occupied_range fills the active ones.
-- Not applied to the shared database yet; run it with the backfill in one
-- transaction.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- [start - setup, end + turnaround). Without recorded minutes there is no range:
-- such a venue cannot receive bookings (Master 5.4.1).
CREATE FUNCTION public.venue_occupied_range(
  p_start timestamptz,
  p_end timestamptz,
  p_setup_minutes integer,
  p_turnaround_minutes integer
)
RETURNS tstzrange
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF p_setup_minutes IS NULL OR p_turnaround_minutes IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_setup_minutes < 0 OR p_turnaround_minutes < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'VENUE_BUFFERS_INVALID';
  END IF;
  RETURN tstzrange(
    p_start - make_interval(mins => p_setup_minutes),
    p_end + make_interval(mins => p_turnaround_minutes),
    '[)'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.venue_occupied_range(timestamptz, timestamptz, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venue_occupied_range(timestamptz, timestamptz, integer, integer)
  TO service_role;

-- Adjacent ranges are allowed; any overlap, even one second, is refused.
ALTER TABLE public.venue_booking
  ADD CONSTRAINT venue_booking_no_overlap EXCLUDE USING gist (venue_id WITH =, occupied_range WITH &&)
    WHERE (status IN ('PENDING', 'APPROVED'));
