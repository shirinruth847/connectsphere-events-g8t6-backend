-- SPM-173 AC8: an open resource incident blocks readiness. The resource
-- incident table is still an unapproved draft dependency, so fail closed if it
-- is not deployed yet; once present, inspect its open incidents.
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
  v_has_open_incident boolean;
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

    -- Booking overlap uses half-open event booking windows. The exclusion
    -- constraint is authoritative for writes; readiness reports legacy conflicts.
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
         AND tstzrange(b.start_datetime, b.end_datetime, '[)')
             && tstzrange(other.start_datetime, other.end_datetime, '[)')
    ) THEN
      v_failures := array_append(v_failures, 'BOOKING_CONFLICT');
    END IF;

    SELECT * INTO v_primary FROM public._event_primary_venue(p_event_id);
    IF NOT FOUND THEN
      v_failures := array_append(v_failures, 'NO_PRIMARY_VENUE');
    END IF;
  END IF;

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

  IF to_regclass('public.resource_incidents') IS NULL THEN
    v_failures := array_append(v_failures, 'READINESS_DATA_PENDING');
  ELSE
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.resource_incidents WHERE event_id = $1 AND status = ''OPEN'')'
       INTO v_has_open_incident USING p_event_id;
    IF v_has_open_incident THEN
      v_failures := array_append(v_failures, 'OPEN_BLOCKING_INCIDENT');
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.event_change_request WHERE event_id = p_event_id AND status = 'PENDING') THEN
    v_failures := array_append(v_failures, 'OPEN_CHANGE_REQUEST');
  END IF;

  RETURN v_failures;
END;
$$;

REVOKE ALL ON FUNCTION public._event_readiness(integer) FROM PUBLIC, anon, authenticated, service_role;
