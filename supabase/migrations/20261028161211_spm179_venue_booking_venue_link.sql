-- SPM-179: venue bookings name their venue (Master 1.6.2 sections 5.4.2, 6.2,
-- 6.3, T33). Taken from the venue part of the SPM-173 draft
-- supabase/drafts/20261019100400_master_resource_tables.sql, adapted to the
-- room bridge: room_id stays NOT NULL because the applied SPM-186/189 decision
-- functions still join bookings through room, while SPM-199 already reads
-- venue_id and is_primary.
--
-- Not here: the occupied-range exclusion constraint (SPM-185/273/274), the
-- RELEASED state, and rechecking booking windows when event timing changes
-- (change workflow, SPM-172).

ALTER TABLE public.venue_booking
  ADD COLUMN venue_id integer REFERENCES public.venue (venue_id) ON DELETE RESTRICT,
  ADD COLUMN is_primary boolean NOT NULL DEFAULT false,
  ADD COLUMN occupied_range tstzrange;

UPDATE public.venue_booking AS b
   SET venue_id = r.venue_id
  FROM public.room AS r
 WHERE r.room_id = b.room_id;

-- Keeps the interim rule for existing events: an event's only active booking is
-- its primary venue. Events with several active bookings get no primary.
UPDATE public.venue_booking AS b
   SET is_primary = true
 WHERE b.status IN ('PENDING', 'APPROVED')
   AND (SELECT count(*) FROM public.venue_booking AS other
         WHERE other.event_id = b.event_id AND other.status IN ('PENDING', 'APPROVED')) = 1;

ALTER TABLE public.venue_booking
  ALTER COLUMN venue_id SET NOT NULL,
  -- [start - setupMinutes, end + turnaroundMinutes), stored when the booking is
  -- created (Master 5.4.1); legacy rows have none.
  ADD CONSTRAINT venue_booking_occupied_range_check CHECK (
    occupied_range IS NULL OR occupied_range @> tstzrange(start_datetime, end_datetime, '[)')
  );

-- Bookings inserted with only a room (seeds, fixtures) get the room's venue; a
-- room of another venue is refused, so venue_id and room_id never disagree.
CREATE OR REPLACE FUNCTION public._venue_booking_fill_venue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_room_venue integer;
BEGIN
  SELECT venue_id INTO v_room_venue FROM public.room WHERE room_id = NEW.room_id;
  IF NEW.venue_id IS NULL THEN
    NEW.venue_id := v_room_venue;
  ELSIF v_room_venue IS DISTINCT FROM NEW.venue_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BOOKING_ROOM_VENUE_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER venue_booking_fill_venue
  BEFORE INSERT OR UPDATE OF room_id, venue_id ON public.venue_booking
  FOR EACH ROW EXECUTE FUNCTION public._venue_booking_fill_venue();

-- Master 6.3: a booking window lies within its event's interval. Created after
-- the backfill; it fires only when the window or event changes, so decisions
-- that update the status never re-check legacy rows.
CREATE OR REPLACE FUNCTION public._venue_booking_window_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.event AS e
     WHERE e.event_id = NEW.event_id
       AND e.start_datetime <= NEW.start_datetime
       AND e.end_datetime >= NEW.end_datetime
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BOOKING_OUTSIDE_EVENT';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER venue_booking_window_within_event
  BEFORE INSERT OR UPDATE OF start_datetime, end_datetime, event_id ON public.venue_booking
  FOR EACH ROW EXECUTE FUNCTION public._venue_booking_window_check();

-- Master 6.3: at most one active booking per event and venue, and at most one
-- active primary venue per event.
CREATE UNIQUE INDEX venue_booking_one_active_per_event_venue
  ON public.venue_booking (event_id, venue_id)
  WHERE status IN ('PENDING', 'APPROVED');

CREATE UNIQUE INDEX venue_booking_one_primary_per_event
  ON public.venue_booking (event_id)
  WHERE is_primary AND status IN ('PENDING', 'APPROVED');

CREATE INDEX venue_booking_venue_idx ON public.venue_booking (venue_id);

-- The event's primary venue is its active booking marked primary (Master 5.4.2).
-- Bookings written outside the SPM-179 request (seeds, other tickets' fixtures)
-- carry no flag, so an event with no flagged booking keeps the SPM-173 interim
-- rule: its only active booking is the primary venue.
CREATE OR REPLACE FUNCTION public._event_primary_venue(p_event_id integer)
RETURNS TABLE (venue_id integer, name text, address text, max_capacity integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT v.venue_id, v.name::text, v.address::text, v.max_capacity
    FROM public.venue_booking AS b
    JOIN public.venue AS v ON v.venue_id = b.venue_id
   WHERE b.event_id = p_event_id
     AND b.status IN ('PENDING', 'APPROVED')
     AND (
       b.is_primary
       OR (
         NOT EXISTS (
           SELECT 1 FROM public.venue_booking AS flagged
            WHERE flagged.event_id = p_event_id AND flagged.is_primary
              AND flagged.status IN ('PENDING', 'APPROVED')
         )
         AND (
           SELECT count(*) FROM public.venue_booking AS other
            WHERE other.event_id = p_event_id AND other.status IN ('PENDING', 'APPROVED')
         ) = 1
       )
     );
$$;

REVOKE ALL ON FUNCTION public._venue_booking_fill_venue() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._venue_booking_window_check() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_primary_venue(integer) FROM PUBLIC, anon, authenticated, service_role;
