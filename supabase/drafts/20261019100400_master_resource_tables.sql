-- DRAFT FOR AGREEMENT - do not apply until the SPM-179 (venue booking request),
-- SPM-181 (venue booking review) and SPM-186 (venue booking approval) owners
-- agree. Schema only: no endpoints. Written for SPM-173, whose readiness check
-- (Master 5.3) needs these tables; it replaces the interim readiness rules of
-- 20261020112025 and 20261020142915.
--
-- What this does (Master v1.2 sections 5.4, 5.5, 6.2, 6.3):
--   * venue_booking moves from rooms to venues IN PLACE (Master 6.2 forbids a
--     second, plural venue_bookings table next to it). room_id stays for the
--     existing rows and becomes optional; venue_id is backfilled from the room.
--   * Adds the primary flag, stored occupied range, converted hold ID,
--     replacement link and safety-rejection reason, with the Master 6.3
--     constraints. label, expected_attendance and layout_type already exist
--     (SPM-181, 20261020070631) and are not added again.
--   * New tables technical_requests (+ lines) and resource_incidents.
--   * Points the primary venue and readiness at those columns and tables.
--
-- Not here, because Master 1.2 (T27) keeps them in MongoDB: tentative holds and
-- operational blocks (venue_calendar) and setup/turnaround minutes
-- (venue_details). The backend computes each booking's occupied range from the
-- venue's MongoDB minutes under the venue lock (Master 7.4) and stores it here.
--
-- Open questions for the owners (answer before applying):
--   Q-A  equipment_request (5 rows) duplicates technical_request_lines. Retire it,
--        or turn it into the lines table? (SPM-26 to SPM-28.) Left untouched here.
--   Q-C  event_change_request keeps PENDING as "open" (Master says OPEN); SPM-172
--        may rename it. Readiness treats PENDING as open.
--   Q-D  Before applying, check that no event holds two active legacy bookings in
--        rooms of the same venue; the one-active-booking-per-venue index fails
--        otherwise. (None on the shared project on 2026-10-19.)
--   Q-E  Legacy bookings get no occupied range (the minutes they were made with
--        are unknown), so the exclusion constraint ignores them. Backfill with
--        the venue's MongoDB minutes, or leave them unguarded?

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- ---------- venue bookings (Master 5.4, 5.4.1, 5.4.2) ----------

ALTER TABLE public.venue_booking
  ALTER COLUMN room_id DROP NOT NULL,
  ADD COLUMN venue_id integer REFERENCES public.venue (venue_id) ON DELETE RESTRICT,
  ADD COLUMN is_primary boolean NOT NULL DEFAULT false,
  ADD COLUMN occupied_range tstzrange,
  -- The MongoDB venue_calendar hold this booking was converted from (Master 5.4.3).
  ADD COLUMN converted_hold_id text CHECK (char_length(converted_hold_id) <= 64),
  ADD COLUMN replaces_booking_id integer REFERENCES public.venue_booking (booking_id) ON DELETE RESTRICT,
  ADD COLUMN safety_rejection_reason text CHECK (char_length(safety_rejection_reason) <= 1000),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.venue_booking AS b
   SET venue_id = r.venue_id
  FROM public.room AS r
 WHERE r.room_id = b.room_id
   AND b.venue_id IS NULL;

-- Keeps the interim rule for existing events: an event's only active booking is
-- its primary venue.
UPDATE public.venue_booking AS b
   SET is_primary = true
 WHERE b.status IN ('PENDING', 'APPROVED')
   AND (SELECT count(*) FROM public.venue_booking AS other
         WHERE other.event_id = b.event_id AND other.status IN ('PENDING', 'APPROVED')) = 1;

ALTER TABLE public.venue_booking
  ADD CONSTRAINT venue_booking_place_check CHECK (venue_id IS NOT NULL OR room_id IS NOT NULL),
  ADD CONSTRAINT venue_booking_window_order_check CHECK (end_datetime > start_datetime),
  -- The occupied range is [start - setupMinutes, end + turnaroundMinutes), stored
  -- when the booking is created (Master 5.4.1); it always covers the booking window.
  ADD CONSTRAINT venue_booking_occupied_range_check CHECK (
    occupied_range IS NULL OR occupied_range @> tstzrange(start_datetime, end_datetime, '[)')
  ),
  -- Master 6.3: no active occupied-range overlap per venue (half-open ranges, so
  -- adjacent is fine). Holds and blocks are checked under the venue lock instead.
  ADD CONSTRAINT venue_booking_no_overlap EXCLUDE USING gist (venue_id WITH =, occupied_range WITH &&)
    WHERE (status IN ('PENDING', 'APPROVED') AND occupied_range IS NOT NULL);

-- Master 6.3: at most one active booking per event and venue.
CREATE UNIQUE INDEX venue_booking_one_active_per_event_venue
  ON public.venue_booking (event_id, venue_id)
  WHERE status IN ('PENDING', 'APPROVED') AND venue_id IS NOT NULL;

-- Master 6.3: at most one primary venue per event.
CREATE UNIQUE INDEX venue_booking_one_primary_per_event
  ON public.venue_booking (event_id)
  WHERE is_primary AND status IN ('PENDING', 'APPROVED');

-- Master 6.3: a booking window lies within its event's interval. Rechecking when
-- the event's timing changes belongs to the change workflow (SPM-172).
CREATE OR REPLACE FUNCTION public._venue_booking_window_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.venue_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.event AS e
     WHERE e.event_id = NEW.event_id
       AND e.start_datetime <= NEW.start_datetime
       AND e.end_datetime >= NEW.end_datetime
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BOOKING_WINDOW_OUTSIDE_EVENT';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER venue_booking_window_within_event
  BEFORE INSERT OR UPDATE OF start_datetime, end_datetime, event_id, venue_id ON public.venue_booking
  FOR EACH ROW EXECUTE FUNCTION public._venue_booking_window_check();

-- ---------- technical requests (Master 5.5) ----------

CREATE TABLE public.technical_requests (
  request_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id integer NOT NULL REFERENCES public.event (event_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'NOT_REQUIRED', 'SUPERSEDED', 'CANCELLED')),
  support_required boolean NOT NULL DEFAULT false,
  support_notes text CHECK (char_length(support_notes) <= 2000),
  requested_by integer NOT NULL REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  reviewer_id integer REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  decided_at timestamptz,
  requirement_version integer NOT NULL DEFAULT 1 CHECK (requirement_version > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Master 6.3: one active canonical technical request per event.
CREATE UNIQUE INDEX technical_requests_one_active_per_event
  ON public.technical_requests (event_id)
  WHERE status IN ('PENDING', 'APPROVED', 'NOT_REQUIRED');

CREATE TABLE public.technical_request_lines (
  request_id integer NOT NULL REFERENCES public.technical_requests (request_id) ON DELETE RESTRICT,
  equipment_id integer NOT NULL REFERENCES public.equipment (equipment_id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (request_id, equipment_id)
);

-- ---------- incidents (Master 5.4.4) ----------

-- A VENUE_BLOCK incident names the MongoDB venue_calendar BLOCK document by its
-- ID; there is no foreign key across the two stores.
CREATE TABLE public.resource_incidents (
  incident_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id integer NOT NULL REFERENCES public.event (event_id) ON DELETE RESTRICT,
  type text NOT NULL CHECK (type IN ('VENUE_BLOCK', 'EQUIPMENT_UNAVAILABLE')),
  booking_id integer REFERENCES public.venue_booking (booking_id) ON DELETE RESTRICT,
  calendar_block_id text CHECK (char_length(calendar_block_id) <= 64),
  equipment_id integer REFERENCES public.equipment (equipment_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution text CHECK (resolution IN ('RESTORED', 'REPLACED', 'RELEASED', 'EVENT_CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  -- Not "..._resolution_check": that is the generated name of the column check above.
  CONSTRAINT resource_incidents_resolution_state_check CHECK (
    (status = 'OPEN' AND resolution IS NULL AND resolved_at IS NULL)
    OR (status = 'RESOLVED' AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT resource_incidents_target_check CHECK (
    (type = 'VENUE_BLOCK' AND booking_id IS NOT NULL AND calendar_block_id IS NOT NULL)
    OR (type = 'EQUIPMENT_UNAVAILABLE' AND equipment_id IS NOT NULL)
  )
);

CREATE INDEX resource_incidents_open_by_event
  ON public.resource_incidents (event_id)
  WHERE status = 'OPEN';

-- ---------- privileges ----------

ALTER TABLE public.technical_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.technical_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_incidents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.technical_requests, public.technical_request_lines, public.resource_incidents
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.technical_requests, public.resource_incidents TO service_role;
-- Lines are replaced as a whole when a request is revised.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.technical_request_lines TO service_role;

REVOKE ALL ON FUNCTION public._venue_booking_window_check() FROM PUBLIC, anon, authenticated, service_role;

-- ---------- primary venue and readiness (replace the SPM-173 interim rules) ----------

-- The event's primary venue: its active booking marked primary (Master 5.4.2).
-- The confirmation snapshot reads it through this function.
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
   WHERE b.event_id = p_event_id AND b.is_primary AND b.status IN ('PENDING', 'APPROVED');
$$;

-- Master 5.3, one code per failing condition (empty = ready). Holds (MongoDB)
-- and rejected, released or cancelled bookings never count. Overlaps between
-- bookings are refused by venue_booking_no_overlap when they are made, so no
-- BOOKING_CONFLICT is reported here. No technical need and no technical request
-- means NOT_REQUIRED (D04).
CREATE OR REPLACE FUNCTION public._event_readiness(p_event_id integer)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_failures text[] := ARRAY[]::text[];
  v_primary record;
  v_technical_status text;
  v_needs_technical boolean;
BEGIN
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.venue_booking
     WHERE event_id = p_event_id AND venue_id IS NOT NULL AND status IN ('PENDING', 'APPROVED')
  ) THEN
    v_failures := array_append(v_failures, 'NO_ACTIVE_BOOKING');
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.venue_booking
       WHERE event_id = p_event_id AND venue_id IS NOT NULL AND status = 'PENDING'
    ) THEN
      v_failures := array_append(v_failures, 'BOOKING_NOT_APPROVED');
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.venue_booking AS b
        JOIN public.venue AS v ON v.venue_id = b.venue_id
       WHERE b.event_id = p_event_id
         AND b.status = 'APPROVED'
         AND COALESCE(b.expected_attendance, v_event.expected_attendance) > v.max_capacity
    ) THEN
      v_failures := array_append(v_failures, 'BOOKING_OVER_CAPACITY');
    END IF;

    SELECT * INTO v_primary FROM public._event_primary_venue(p_event_id);
    IF NOT FOUND THEN
      v_failures := array_append(v_failures, 'NO_PRIMARY_VENUE');
    END IF;
  END IF;

  SELECT status INTO v_technical_status
    FROM public.technical_requests
   WHERE event_id = p_event_id AND status IN ('PENDING', 'APPROVED', 'NOT_REQUIRED');
  v_needs_technical := EXISTS (SELECT 1 FROM public.event_equipment_requirement WHERE event_id = p_event_id)
                    OR EXISTS (SELECT 1 FROM public.technical_requests WHERE event_id = p_event_id);
  IF v_needs_technical AND (v_technical_status IS NULL OR v_technical_status = 'PENDING') THEN
    v_failures := array_append(v_failures, 'TECHNICAL_NOT_APPROVED');
  END IF;

  IF v_event.is_registration_enabled THEN
    IF v_event.registration_capacity IS NULL OR v_event.registration_capacity <= 0 THEN
      v_failures := array_append(v_failures, 'REGISTRATION_INVALID');
    ELSIF v_primary.max_capacity IS NOT NULL AND v_event.registration_capacity > v_primary.max_capacity THEN
      v_failures := array_append(v_failures, 'REGISTRATION_EXCEEDS_PRIMARY_CAPACITY');
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.resource_incidents WHERE event_id = p_event_id AND status = 'OPEN') THEN
    v_failures := array_append(v_failures, 'OPEN_BLOCKING_INCIDENT');
  END IF;

  IF EXISTS (SELECT 1 FROM public.event_change_request WHERE event_id = p_event_id AND status = 'PENDING') THEN
    v_failures := array_append(v_failures, 'OPEN_CHANGE_REQUEST');
  END IF;

  RETURN v_failures;
END;
$$;

-- Staff on the event now include the technical request reviewer.
CREATE OR REPLACE FUNCTION public._event_staff_recipients(p_event_id integer)
RETURNS integer[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(array_agg(DISTINCT staff.user_id), ARRAY[]::integer[])
    FROM (
      SELECT reviewed_by AS user_id FROM public.venue_booking
       WHERE event_id = p_event_id AND status = 'APPROVED' AND reviewed_by IS NOT NULL
      UNION
      SELECT reviewed_by FROM public.equipment_request
       WHERE event_id = p_event_id AND status = 'APPROVED' AND reviewed_by IS NOT NULL
      UNION
      SELECT reviewer_id FROM public.technical_requests
       WHERE event_id = p_event_id AND status = 'APPROVED' AND reviewer_id IS NOT NULL
    ) AS staff
    JOIN public."user" AS u ON u.user_id = staff.user_id AND u.is_active;
$$;

REVOKE ALL ON FUNCTION public._event_primary_venue(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_readiness(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_staff_recipients(integer) FROM PUBLIC, anon, authenticated, service_role;
