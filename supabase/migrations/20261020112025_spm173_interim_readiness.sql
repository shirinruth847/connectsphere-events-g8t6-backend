-- SPM-173 review fix: readiness (Master v1.1 section 5.3) on the tables that
-- exist today, replacing the READINESS_DATA_PENDING placeholder so a ready event
-- can be submitted for safety review and confirmed (AC8-AC10).
--
-- The full check needs the Master resource tables in
-- supabase/drafts/20261019100400_master_resource_tables.sql, which waits for the
-- SPM-179 / SPM-181 / SPM-186 owners. That migration later redefines these three
-- functions with the same names and failure codes, so nothing that calls them
-- changes. Until then:
--   * Bookings are the live room-based venue_booking rows. PENDING and APPROVED
--     are active (the live booking_status has no HELD); capacity is the venue's
--     max_capacity, because Master 5.4 books whole venues.
--   * There is no primary flag: the primary venue is the event's only active
--     booking. An event with several active bookings reports NO_PRIMARY_VENUE
--     until the flag exists.
--   * The occupied range is the booking window widened on both sides by the
--     venue's setup_turnaround_min (the only buffer column the venue has).
--   * Technical needs are event_equipment_requirement rows and equipment_request
--     rows; nothing requested means NOT_REQUIRED (Master D04).
--   * There is no incident table yet, so OPEN_BLOCKING_INCIDENT is never reported.

-- The event's primary venue, or no row when there is none. Interim rule: the
-- venue of the event's only active booking.
CREATE OR REPLACE FUNCTION public._event_primary_venue(p_event_id integer)
RETURNS TABLE (venue_id integer, name text, address text, max_capacity integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT v.venue_id, v.name::text, v.address::text, v.max_capacity
    FROM public.venue_booking AS b
    JOIN public.room AS r ON r.room_id = b.room_id
    JOIN public.venue AS v ON v.venue_id = r.venue_id
   WHERE b.event_id = p_event_id
     AND b.status IN ('PENDING', 'APPROVED')
     AND (SELECT count(*) FROM public.venue_booking AS other
           WHERE other.event_id = p_event_id AND other.status IN ('PENDING', 'APPROVED')) = 1;
$$;

-- Master 5.3, one code per failing condition (empty = ready).
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
BEGIN
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.venue_booking WHERE event_id = p_event_id AND status IN ('PENDING', 'APPROVED')
  ) THEN
    v_failures := array_append(v_failures, 'NO_ACTIVE_BOOKING');
  ELSE
    IF EXISTS (SELECT 1 FROM public.venue_booking WHERE event_id = p_event_id AND status = 'PENDING') THEN
      v_failures := array_append(v_failures, 'BOOKING_NOT_APPROVED');
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.venue_booking AS b
        JOIN public.room AS r ON r.room_id = b.room_id
        JOIN public.venue AS v ON v.venue_id = r.venue_id
       WHERE b.event_id = p_event_id
         AND b.status = 'APPROVED'
         AND COALESCE(b.expected_attendance, v_event.expected_attendance) > v.max_capacity
    ) THEN
      v_failures := array_append(v_failures, 'BOOKING_OVER_CAPACITY');
    END IF;

    -- Another active booking at the same venue over the occupied range.
    IF EXISTS (
      SELECT 1
        FROM public.venue_booking AS b
        JOIN public.room AS r ON r.room_id = b.room_id
        JOIN public.venue AS v ON v.venue_id = r.venue_id
        JOIN public.venue_booking AS other
          ON other.booking_id <> b.booking_id
         AND other.status IN ('PENDING', 'APPROVED')
        JOIN public.room AS other_room ON other_room.room_id = other.room_id AND other_room.venue_id = v.venue_id
       WHERE b.event_id = p_event_id
         AND b.status IN ('PENDING', 'APPROVED')
         AND tstzrange(
               b.start_datetime - make_interval(mins => COALESCE(v.setup_turnaround_min, 0)),
               b.end_datetime + make_interval(mins => COALESCE(v.setup_turnaround_min, 0))
             ) && tstzrange(
               other.start_datetime - make_interval(mins => COALESCE(v.setup_turnaround_min, 0)),
               other.end_datetime + make_interval(mins => COALESCE(v.setup_turnaround_min, 0))
             )
    ) THEN
      v_failures := array_append(v_failures, 'BOOKING_CONFLICT');
    END IF;

    SELECT * INTO v_primary FROM public._event_primary_venue(p_event_id);
    IF NOT FOUND THEN
      v_failures := array_append(v_failures, 'NO_PRIMARY_VENUE');
    END IF;
  END IF;

  -- Every requested technical need approved: no request still pending or only
  -- partly fulfilled, and an approved request for each required equipment item.
  IF EXISTS (
    SELECT 1 FROM public.equipment_request
     WHERE event_id = p_event_id AND status IN ('PENDING', 'PARTIALLY_FULFILLED')
  ) OR EXISTS (
    SELECT 1 FROM public.event_equipment_requirement AS need
     WHERE need.event_id = p_event_id
       AND NOT EXISTS (
         SELECT 1 FROM public.equipment_request AS req
          WHERE req.event_id = p_event_id AND req.equipment_id = need.equipment_id AND req.status = 'APPROVED'
       )
  ) THEN
    v_failures := array_append(v_failures, 'TECHNICAL_NOT_APPROVED');
  END IF;

  IF v_event.is_registration_enabled THEN
    IF v_event.registration_capacity IS NULL OR v_event.registration_capacity <= 0 THEN
      v_failures := array_append(v_failures, 'REGISTRATION_INVALID');
    ELSIF v_primary.max_capacity IS NOT NULL AND v_event.registration_capacity > v_primary.max_capacity THEN
      v_failures := array_append(v_failures, 'REGISTRATION_EXCEEDS_PRIMARY_CAPACITY');
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.event_change_request WHERE event_id = p_event_id AND status = 'PENDING') THEN
    v_failures := array_append(v_failures, 'OPEN_CHANGE_REQUEST');
  END IF;

  RETURN v_failures;
END;
$$;

-- What attendees are told at confirmation now includes the primary venue, the
-- only venue they see (Master 5.4.2).
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
      SELECT jsonb_build_object('venue_id', p.venue_id, 'name', p.name, 'address', p.address)
        FROM public._event_primary_venue(p_event.event_id) AS p
    )
  );
$$;

REVOKE ALL ON FUNCTION public._event_primary_venue(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_readiness(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_attendee_snapshot(public.event) FROM PUBLIC, anon, authenticated, service_role;
