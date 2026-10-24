-- SPM-173, following Master v1.2 (sections 5.4.1, 6.2 and 6.5): readiness must
-- not read venue.setup_turnaround_min. Master 1.2 deprecates that column ("new
-- code neither reads nor writes it"), moves setup/turnaround minutes to MongoDB
-- venue_details, and keeps readiness on PostgreSQL only.
--
-- 20261020112025_spm173_interim_readiness widened each booking by that column
-- for the BOOKING_CONFLICT check. This redefines _event_readiness with the
-- booking windows compared as they are. Under Master 1.2 each booking stores its
-- occupied range when it is created, guarded by the booking exclusion constraint;
-- once bookings carry that range, the check should compare it instead. Every
-- other condition and failure code is unchanged.

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

    -- Another active booking at the same venue over an overlapping booking window.
    IF EXISTS (
      SELECT 1
        FROM public.venue_booking AS b
        JOIN public.room AS r ON r.room_id = b.room_id
        JOIN public.venue_booking AS other
          ON other.booking_id <> b.booking_id
         AND other.status IN ('PENDING', 'APPROVED')
        JOIN public.room AS other_room ON other_room.room_id = other.room_id AND other_room.venue_id = r.venue_id
       WHERE b.event_id = p_event_id
         AND b.status IN ('PENDING', 'APPROVED')
         AND tstzrange(b.start_datetime, b.end_datetime) && tstzrange(other.start_datetime, other.end_datetime)
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

REVOKE ALL ON FUNCTION public._event_readiness(integer) FROM PUBLIC, anon, authenticated, service_role;
