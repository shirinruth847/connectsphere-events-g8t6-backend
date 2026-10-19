-- DRAFT FOR AGREEMENT - do not apply until the SPM-179 (venue booking request)
-- and SPM-186 (venue booking approval) owners agree. Schema only: no endpoints.
-- Written for SPM-173, whose readiness check (Master 5.3) needs these tables.
--
-- What this does (Master v1.1 sections 5.4, 5.5, 6.2, 6.3):
--   * venue_booking moves from rooms to venues IN PLACE (Master 6.2 forbids a
--     second, plural venue_bookings table next to it). room_id stays for the
--     existing rows and becomes optional; venue_id is backfilled from the room.
--   * Adds the booking window, label, per-booking attendance and layout, primary
--     flag, stored occupied range, hold expiry, replacement link and
--     safety-rejection reason, with the Master 6.3 constraints.
--   * New tables technical_requests (+ lines), venue_blocks and resource_incidents.
--   * Replaces the SPM-173 readiness placeholder with the real check.
--
-- Open questions for the owners (answer before applying):
--   Q-A  equipment_request (5 rows) duplicates technical_request_lines. Retire it,
--        or turn it into the lines table? (SPM-26 to SPM-28.) Left untouched here.
--   Q-B  The venue has one setup_turnaround_min column; Master 5.4.1 wants
--        setup_minutes and turnaround_minutes. This migration does not change the
--        venue table (SPM-72/SPM-73); the occupied range is stored on each booking.
--   Q-C  event_change_request keeps PENDING as "open" (Master says OPEN); SPM-172
--        may rename it. Readiness treats PENDING as open.
--   Q-D  Before applying, check that no event holds two active legacy bookings in
--        rooms of the same venue; the one-active-booking-per-venue index fails
--        otherwise. (None on the shared project on 2026-10-19.)

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- ---------- venue bookings (Master 5.4, 5.4.1-5.4.3) ----------

ALTER TABLE public.venue_booking
  ALTER COLUMN room_id DROP NOT NULL,
  ADD COLUMN venue_id integer REFERENCES public.venue (venue_id) ON DELETE RESTRICT,
  ADD COLUMN label text CHECK (char_length(label) <= 100),
  ADD COLUMN expected_attendance integer CHECK (expected_attendance > 0),
  ADD COLUMN layout_type text CHECK (char_length(layout_type) <= 100),
  ADD COLUMN is_primary boolean NOT NULL DEFAULT false,
  ADD COLUMN occupied_range tstzrange,
  ADD COLUMN hold_expires_at timestamptz,
  ADD COLUMN hold_extended_at timestamptz,
  ADD COLUMN replaces_booking_id integer REFERENCES public.venue_booking (booking_id) ON DELETE RESTRICT,
  ADD COLUMN safety_rejection_reason text CHECK (char_length(safety_rejection_reason) <= 1000),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.venue_booking AS b
   SET venue_id = r.venue_id
  FROM public.room AS r
 WHERE r.room_id = b.room_id
   AND b.venue_id IS NULL;

ALTER TABLE public.venue_booking
  ADD CONSTRAINT venue_booking_place_check CHECK (venue_id IS NOT NULL OR room_id IS NOT NULL),
  ADD CONSTRAINT venue_booking_window_order_check CHECK (end_datetime > start_datetime),
  -- The occupied range is [start - setup, end + turnaround), stored when the hold
  -- or booking is created (Master 5.4.1); it always covers the booking window.
  ADD CONSTRAINT venue_booking_occupied_range_check CHECK (
    occupied_range IS NULL OR occupied_range @> tstzrange(start_datetime, end_datetime, '[)')
  ),
  -- Master 6.3: every hold has an expiry no later than 24 hours before its occupied range starts.
  ADD CONSTRAINT venue_booking_hold_expiry_check CHECK (
    status <> 'HELD'
    OR (hold_expires_at IS NOT NULL AND occupied_range IS NOT NULL
        AND hold_expires_at <= lower(occupied_range) - interval '24 hours')
  ),
  -- Master 6.3: no active occupied-range overlap per venue (half-open ranges, so adjacent is fine).
  ADD CONSTRAINT venue_booking_no_overlap EXCLUDE USING gist (venue_id WITH =, occupied_range WITH &&)
    WHERE (status IN ('HELD', 'PENDING', 'APPROVED') AND occupied_range IS NOT NULL);

-- Master 6.3: at most one active booking per event and venue.
CREATE UNIQUE INDEX venue_booking_one_active_per_event_venue
  ON public.venue_booking (event_id, venue_id)
  WHERE status IN ('HELD', 'PENDING', 'APPROVED') AND venue_id IS NOT NULL;

-- Master 6.3: at most one primary venue per event.
CREATE UNIQUE INDEX venue_booking_one_primary_per_event
  ON public.venue_booking (event_id)
  WHERE is_primary AND status IN ('HELD', 'PENDING', 'APPROVED');

CREATE INDEX venue_booking_hold_expiry
  ON public.venue_booking (hold_expires_at)
  WHERE status = 'HELD';

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

-- ---------- venue blocks and incidents (Master 5.4.4) ----------

CREATE TABLE public.venue_blocks (
  block_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venue_id integer NOT NULL REFERENCES public.venue (venue_id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (reason IN ('MAINTENANCE', 'EQUIPMENT_FAILURE', 'RENOVATION', 'SAFETY', 'OTHER')),
  block_range tstzrange NOT NULL CHECK (NOT isempty(block_range)),
  note text CHECK (char_length(note) <= 2000),
  created_by integer NOT NULL REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz
);

CREATE INDEX venue_blocks_venue_range ON public.venue_blocks USING gist (venue_id, block_range);

CREATE TABLE public.resource_incidents (
  incident_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id integer NOT NULL REFERENCES public.event (event_id) ON DELETE RESTRICT,
  type text NOT NULL CHECK (type IN ('VENUE_BLOCK', 'EQUIPMENT_UNAVAILABLE')),
  booking_id integer REFERENCES public.venue_booking (booking_id) ON DELETE RESTRICT,
  block_id integer REFERENCES public.venue_blocks (block_id) ON DELETE RESTRICT,
  equipment_id integer REFERENCES public.equipment (equipment_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution text CHECK (resolution IN ('RESTORED', 'REPLACED', 'RELEASED', 'EVENT_CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT resource_incidents_resolution_check CHECK (
    (status = 'OPEN' AND resolution IS NULL AND resolved_at IS NULL)
    OR (status = 'RESOLVED' AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT resource_incidents_target_check CHECK (
    (type = 'VENUE_BLOCK' AND booking_id IS NOT NULL AND block_id IS NOT NULL)
    OR (type = 'EQUIPMENT_UNAVAILABLE' AND equipment_id IS NOT NULL)
  )
);

CREATE INDEX resource_incidents_open_by_event
  ON public.resource_incidents (event_id)
  WHERE status = 'OPEN';

-- ---------- privileges ----------

ALTER TABLE public.technical_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.technical_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venue_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_incidents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.technical_requests, public.technical_request_lines, public.venue_blocks, public.resource_incidents
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.technical_requests, public.venue_blocks, public.resource_incidents TO service_role;
-- Lines are replaced as a whole when a request is revised.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.technical_request_lines TO service_role;

REVOKE ALL ON FUNCTION public._venue_booking_window_check() FROM PUBLIC, anon, authenticated, service_role;

-- ---------- readiness (replaces the SPM-173 placeholder) ----------

-- Master 5.3, one code per failing condition (empty = ready). Holds and
-- rejected, expired, released or cancelled bookings never count. No technical
-- need and no technical request means NOT_REQUIRED (D04).
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
  v_has_active boolean;
  v_primary_capacity integer;
  v_technical_status text;
  v_needs_technical boolean;
BEGIN
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.venue_booking
     WHERE event_id = p_event_id AND venue_id IS NOT NULL AND status IN ('HELD', 'PENDING', 'APPROVED')
  ) INTO v_has_active;

  IF NOT v_has_active THEN
    v_failures := array_append(v_failures, 'NO_ACTIVE_BOOKING');
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.venue_booking
       WHERE event_id = p_event_id AND venue_id IS NOT NULL AND status IN ('HELD', 'PENDING')
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

    SELECT v.max_capacity INTO v_primary_capacity
      FROM public.venue_booking AS b
      JOIN public.venue AS v ON v.venue_id = b.venue_id
     WHERE b.event_id = p_event_id AND b.is_primary AND b.status IN ('HELD', 'PENDING', 'APPROVED');
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
    ELSIF v_primary_capacity IS NOT NULL AND v_event.registration_capacity > v_primary_capacity THEN
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

-- Attendees see only the primary venue (Master 5.4.2), so it is part of what
-- they are told at confirmation.
CREATE OR REPLACE FUNCTION public._event_attendee_snapshot(p_event public.event)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'title', p_event.title,
    'description', p_event.description,
    'start_datetime', p_event.start_datetime,
    'end_datetime', p_event.end_datetime,
    'is_published', p_event.is_published,
    'is_registration_enabled', p_event.is_registration_enabled,
    'registration_capacity', p_event.registration_capacity,
    'registration_open_at', p_event.registration_open_at,
    'registration_close_at', p_event.registration_close_at,
    'primary_venue', (
      SELECT jsonb_build_object('venue_id', v.venue_id, 'name', v.name, 'address', v.address)
        FROM public.venue_booking AS b
        JOIN public.venue AS v ON v.venue_id = b.venue_id
       WHERE b.event_id = p_event.event_id AND b.is_primary AND b.status = 'APPROVED'
    )
  );
$$;

REVOKE ALL ON FUNCTION public._event_readiness(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_staff_recipients(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_attendee_snapshot(public.event) FROM PUBLIC, anon, authenticated, service_role;
