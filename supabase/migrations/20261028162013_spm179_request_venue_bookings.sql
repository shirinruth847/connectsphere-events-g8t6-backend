-- SPM-179: the assigned coordinator requests venue bookings for an event in
-- PLANNING (Master 1.6.2 sections 5.2, 5.4, 5.4.1, 5.4.2, 7, 7.4, 8, T33).
--
-- Master 7.4 holds the venue lock while MongoDB holds and blocks are checked,
-- so the backend runs both functions in one transaction on the venue lock
-- connection (VENUE_LOCK_DATABASE_URL):
--   BEGIN;
--   begin_venue_booking_request  -- event lock, idempotency claim, venue locks
--   (backend reads setup/turnaround minutes, holds and blocks from MongoDB)
--   request_venue_bookings       -- re-checks, inserts, version, activity, notice
--   COMMIT;
-- Business errors are P0001 with a stable MESSAGE; per-booking errors carry a
-- JSON DETAIL with the booking's index so the form shows them inline.

-- Allow the new idempotent operation, preserving operations added by other
-- branches (same pattern as 20261028010000_spm192_reassignment_replay).
DO $idempotency_operations$
DECLARE
  v_existing_check text;
BEGIN
  LOCK TABLE public.idempotency_records IN ACCESS EXCLUSIVE MODE;
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT v_existing_check
    FROM pg_constraint
   WHERE conrelid = 'public.idempotency_records'::regclass
     AND conname = 'idempotency_records_operation_check'
     AND contype = 'c';
  EXECUTE format(
    'ALTER TABLE public.idempotency_records
       DROP CONSTRAINT idempotency_records_operation_check,
       ADD CONSTRAINT idempotency_records_operation_check CHECK ((%s) OR operation = %L)',
    v_existing_check, 'event.request_venue_bookings'
  );
END;
$idempotency_operations$;

-- The room a new booking stores until the decision functions read venue_id
-- (Master 6.2 room bridge, T33). The venue row is already locked by the caller,
-- so two requests never create a room for the same venue at once.
CREATE OR REPLACE FUNCTION public._venue_booking_room(p_venue_id integer, p_layout text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_room_id integer;
BEGIN
  SELECT room_id INTO v_room_id
    FROM public.room
   WHERE venue_id = p_venue_id
   ORDER BY room_id
   LIMIT 1;
  IF v_room_id IS NULL THEN
    INSERT INTO public.room (venue_id, layout_type, capacity)
    SELECT v.venue_id, left(p_layout, 50), v.max_capacity
      FROM public.venue AS v
     WHERE v.venue_id = p_venue_id
    RETURNING room_id INTO v_room_id;
  END IF;
  RETURN v_room_id;
END;
$$;

-- The actor must be the event's assigned coordinator and still active.
CREATE OR REPLACE FUNCTION public._require_booking_coordinator(p_actor_id integer, p_event public.event)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_event.coordinator_id IS DISTINCT FROM p_actor_id OR NOT EXISTS (
    SELECT 1 FROM public."user"
     WHERE user_id = p_actor_id AND role = 'COORDINATOR' AND is_active
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FORBIDDEN';
  END IF;
END;
$$;

-- Step 1: lock the event, claim the idempotency key, lock the venues (events,
-- then venues in ascending ID order, Master 7). A replay returns the stored
-- response and locks nothing else.
CREATE OR REPLACE FUNCTION public.begin_venue_booking_request(
  p_actor_id integer,
  p_event_id integer,
  p_venue_ids integer[],
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_replay jsonb;
  v_venues jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_event_id IS NULL OR p_venue_ids IS NULL
     OR cardinality(p_venue_ids) NOT BETWEEN 1 AND 10
     OR array_position(p_venue_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_BOOKING_REQUEST';
  END IF;
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  SELECT * INTO v_event
    FROM public.event
   WHERE event_id = p_event_id AND status::text <> 'DRAFT'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  PERFORM public._require_booking_coordinator(p_actor_id, v_event);

  v_replay := public._claim_idempotency_key(
    p_actor_id, 'event.request_venue_bookings', p_idempotency_key, p_request_hash
  );
  IF v_replay IS NOT NULL THEN
    RETURN jsonb_build_object('replay', v_replay);
  END IF;

  IF v_event.status::text <> 'PLANNING' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_IN_PLANNING';
  END IF;

  PERFORM 1 FROM public.venue
   WHERE venue_id = ANY (p_venue_ids)
   ORDER BY venue_id
   FOR UPDATE;

  SELECT jsonb_agg(jsonb_build_object(
           'venueId', venue_id,
           'name', name,
           'maxCapacity', max_capacity,
           'status', status,
           'isActive', is_active,
           'operatingHours', operating_hours
         ) ORDER BY venue_id)
    INTO v_venues
    FROM public.venue
   WHERE venue_id = ANY (p_venue_ids);

  RETURN jsonb_build_object(
    'replay', NULL,
    'event', jsonb_build_object(
      'eventId', v_event.event_id,
      'start', v_event.start_datetime,
      'end', v_event.end_datetime
    ),
    'venues', COALESCE(v_venues, '[]'::jsonb)
  );
END;
$$;

-- Step 2: every PostgreSQL check again under the same locks, then the bookings,
-- arrangement version, activity entry and Venue Staff notice in one commit.
-- p_minutes maps each venue ID to its MongoDB setupMinutes/turnaroundMinutes;
-- p_warnings (advisory, Master 5.4) is stored with the response for replays.
CREATE OR REPLACE FUNCTION public.request_venue_bookings(
  p_actor_id integer,
  p_event_id integer,
  p_bookings jsonb,
  p_minutes jsonb,
  p_warnings jsonb,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_venue public.venue;
  v_item jsonb;
  v_ordinal bigint;
  v_index integer;
  v_count integer;
  v_venue_id integer;
  v_label text;
  v_start timestamptz;
  v_end timestamptz;
  v_attendance integer;
  v_layout text;
  v_facilities text[];
  v_accessibility text[];
  v_special text;
  v_marked_primary boolean;
  v_is_primary boolean;
  v_has_primary boolean;
  v_primary_marks integer;
  v_setup integer;
  v_turnaround integer;
  v_range tstzrange;
  v_conflicts jsonb;
  v_room_id integer;
  v_booking_id integer;
  v_first_booking_id integer;
  v_bookings jsonb := '[]'::jsonb;
  v_booking_ids integer[] := ARRAY[]::integer[];
  v_venue_ids integer[] := ARRAY[]::integer[];
  v_venue_names text[] := ARRAY[]::text[];
  v_arrangement_version integer;
  v_request_id text;
  v_response jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_event_id IS NULL
     OR jsonb_typeof(p_bookings) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_bookings) NOT BETWEEN 1 AND 10
     OR jsonb_typeof(p_minutes) IS DISTINCT FROM 'object'
     OR (p_warnings IS NOT NULL AND jsonb_typeof(p_warnings) <> 'array') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_BOOKING_REQUEST';
  END IF;
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  SELECT * INTO v_event
    FROM public.event
   WHERE event_id = p_event_id AND status::text <> 'DRAFT'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  PERFORM public._require_booking_coordinator(p_actor_id, v_event);
  IF v_event.status::text <> 'PLANNING' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_IN_PLANNING';
  END IF;

  -- begin_venue_booking_request must have claimed this key in this transaction.
  IF NOT EXISTS (
    SELECT 1 FROM public.idempotency_records
     WHERE actor_id = p_actor_id
       AND operation = 'event.request_venue_bookings'
       AND idempotency_key = p_idempotency_key
       AND request_hash = p_request_hash
       AND response IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_BOOKING_REQUEST_NOT_STARTED';
  END IF;

  -- Parse every booking before writing anything; malformed input never reaches
  -- a cast error.
  CREATE TEMPORARY TABLE IF NOT EXISTS pg_temp.spm179_requested_booking (
    item_index integer PRIMARY KEY,
    venue_id integer NOT NULL,
    label text NOT NULL,
    start_at timestamptz NOT NULL,
    end_at timestamptz NOT NULL,
    attendance integer NOT NULL,
    layout text NOT NULL,
    facilities text[] NOT NULL,
    accessibility text[] NOT NULL,
    special text,
    marked_primary boolean NOT NULL
  ) ON COMMIT DROP;
  DELETE FROM pg_temp.spm179_requested_booking;

  FOR v_item, v_ordinal IN SELECT value, ordinality FROM jsonb_array_elements(p_bookings) WITH ORDINALITY LOOP
    v_index := v_ordinal::integer - 1;
    BEGIN
      -- IS DISTINCT FROM, so a missing key (NULL type) is refused too.
      IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_item -> 'venueId') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_item -> 'expectedAttendance') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_item -> 'label') IS DISTINCT FROM 'string'
         OR jsonb_typeof(v_item -> 'layout') IS DISTINCT FROM 'string'
         OR jsonb_typeof(v_item -> 'start') IS DISTINCT FROM 'string'
         OR jsonb_typeof(v_item -> 'end') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'malformed';
      END IF;
      v_venue_id := (v_item ->> 'venueId')::integer;
      v_attendance := (v_item ->> 'expectedAttendance')::integer;
      v_label := btrim(v_item ->> 'label');
      v_layout := btrim(v_item ->> 'layout');
      v_start := (v_item ->> 'start')::timestamptz;
      v_end := (v_item ->> 'end')::timestamptz;
      v_special := NULLIF(btrim(COALESCE(v_item ->> 'specialRequirements', '')), '');
      v_facilities := ARRAY(SELECT btrim(value) FROM jsonb_array_elements_text(COALESCE(v_item -> 'requiredFacilities', '[]'::jsonb)));
      v_accessibility := ARRAY(SELECT btrim(value) FROM jsonb_array_elements_text(COALESCE(v_item -> 'accessibilityNeeds', '[]'::jsonb)));
      v_marked_primary := COALESCE((v_item ->> 'isPrimary')::boolean, false);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_BOOKING_REQUEST',
        DETAIL = jsonb_build_object('index', v_index)::text;
    END;

    IF v_venue_id <= 0 OR v_attendance <= 0
       OR v_label = '' OR char_length(v_label) > 100
       OR v_layout = '' OR char_length(v_layout) > 50
       OR v_end <= v_start
       OR cardinality(v_facilities) > 20 OR cardinality(v_accessibility) > 20
       OR char_length(COALESCE(v_special, '')) > 2000 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_BOOKING_REQUEST',
        DETAIL = jsonb_build_object('index', v_index)::text;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_temp.spm179_requested_booking WHERE venue_id = v_venue_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_LISTED_TWICE',
        DETAIL = jsonb_build_object('index', v_index, 'venueId', v_venue_id)::text;
    END IF;

    INSERT INTO pg_temp.spm179_requested_booking
    VALUES (v_index, v_venue_id, v_label, v_start, v_end, v_attendance, v_layout,
            v_facilities, v_accessibility, v_special, v_marked_primary);
  END LOOP;

  -- Venues were locked by begin_venue_booking_request; re-locking is a no-op
  -- that keeps this function safe on its own.
  PERFORM 1 FROM public.venue
   WHERE venue_id IN (SELECT venue_id FROM pg_temp.spm179_requested_booking)
   ORDER BY venue_id
   FOR UPDATE;

  -- Primary venue (Master 5.4.2): an existing primary is kept; otherwise a
  -- single booking becomes primary and several need exactly one marked.
  SELECT count(*), count(*) FILTER (WHERE marked_primary)
    INTO v_count, v_primary_marks
    FROM pg_temp.spm179_requested_booking;
  -- An unflagged booking written outside this request that is the event's only
  -- active booking is already its primary venue (_event_primary_venue); flag it
  -- before adding more, so the primary does not silently disappear.
  UPDATE public.venue_booking AS b
     SET is_primary = true
   WHERE b.event_id = p_event_id
     AND b.status IN ('PENDING', 'APPROVED')
     AND NOT EXISTS (
       SELECT 1 FROM public.venue_booking AS flagged
        WHERE flagged.event_id = p_event_id AND flagged.is_primary
          AND flagged.status IN ('PENDING', 'APPROVED')
     )
     AND (
       SELECT count(*) FROM public.venue_booking AS other
        WHERE other.event_id = p_event_id AND other.status IN ('PENDING', 'APPROVED')
     ) = 1;
  v_has_primary := EXISTS (
    SELECT 1 FROM public.venue_booking
     WHERE event_id = p_event_id AND is_primary AND status IN ('PENDING', 'APPROVED')
  );
  IF v_has_primary AND v_primary_marks > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PRIMARY_VENUE_ALREADY_SET';
  END IF;
  IF NOT v_has_primary AND v_count > 1 AND v_primary_marks <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PRIMARY_VENUE_REQUIRED';
  END IF;

  FOR v_index, v_venue_id, v_label, v_start, v_end, v_attendance, v_layout,
      v_facilities, v_accessibility, v_special, v_marked_primary IN
    SELECT item_index, venue_id, label, start_at, end_at, attendance, layout,
           facilities, accessibility, special, marked_primary
      FROM pg_temp.spm179_requested_booking
     ORDER BY item_index
  LOOP
    SELECT * INTO v_venue FROM public.venue WHERE venue_id = v_venue_id;
    IF NOT FOUND OR NOT v_venue.is_active OR v_venue.status <> 'ACTIVE' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_NOT_BOOKABLE',
        DETAIL = jsonb_build_object('index', v_index, 'venueId', v_venue_id)::text;
    END IF;

    IF v_start <= now() THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BOOKING_IN_PAST',
        DETAIL = jsonb_build_object('index', v_index, 'venueId', v_venue_id)::text;
    END IF;
    IF v_start < v_event.start_datetime OR v_end > v_event.end_datetime THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BOOKING_OUTSIDE_EVENT',
        DETAIL = jsonb_build_object('index', v_index, 'venueId', v_venue_id)::text;
    END IF;

    IF v_attendance > v_venue.max_capacity THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_CAPACITY_EXCEEDED',
        DETAIL = jsonb_build_object('index', v_index, 'venueId', v_venue_id,
                                    'capacity', v_venue.max_capacity, 'expectedAttendance', v_attendance)::text;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.venue_booking
       WHERE event_id = p_event_id AND venue_id = v_venue_id AND status IN ('PENDING', 'APPROVED')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_ALREADY_BOOKED_FOR_EVENT',
        DETAIL = jsonb_build_object('index', v_index, 'venueId', v_venue_id)::text;
    END IF;

    -- Master 5.4.1: a venue without its MongoDB minutes takes no bookings.
    BEGIN
      v_setup := (p_minutes -> v_venue_id::text ->> 'setupMinutes')::integer;
      v_turnaround := (p_minutes -> v_venue_id::text ->> 'turnaroundMinutes')::integer;
    EXCEPTION WHEN OTHERS THEN
      v_setup := NULL;
    END;
    IF v_setup IS NULL OR v_turnaround IS NULL OR v_setup < 0 OR v_turnaround < 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_BUFFERS_NOT_SET',
        DETAIL = jsonb_build_object('index', v_index, 'venueId', v_venue_id)::text;
    END IF;

    -- Booking against booking over occupied ranges, half-open (Master 5.4).
    -- Minutes never change (T16), so other bookings use the same minutes.
    v_range := tstzrange(v_start - make_interval(mins => v_setup),
                         v_end + make_interval(mins => v_turnaround), '[)');
    SELECT jsonb_agg(jsonb_build_object('type', 'BOOKING',
                                        'occupiedStart', lower(other_range),
                                        'occupiedEnd', upper(other_range))
                     ORDER BY lower(other_range))
      INTO v_conflicts
      FROM (
        SELECT tstzrange(other.start_datetime - make_interval(mins => v_setup),
                         other.end_datetime + make_interval(mins => v_turnaround), '[)') AS other_range
          FROM public.venue_booking AS other
         WHERE other.venue_id = v_venue_id
           AND other.status IN ('PENDING', 'APPROVED')
      ) AS occupied
     WHERE other_range && v_range;
    IF v_conflicts IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BOOKING_CONFLICT',
        DETAIL = jsonb_build_object('index', v_index, 'venueId', v_venue_id, 'conflicts', v_conflicts)::text;
    END IF;

    v_is_primary := NOT v_has_primary AND (v_count = 1 OR v_marked_primary);
    v_room_id := public._venue_booking_room(v_venue_id, v_layout);

    INSERT INTO public.venue_booking (
      room_id, venue_id, event_id, requested_by, start_datetime, end_datetime, status,
      label, expected_attendance, layout_type, required_facilities,
      accessibility_requirements, special_requirements, is_primary, occupied_range
    ) VALUES (
      v_room_id, v_venue_id, p_event_id, p_actor_id, v_start, v_end, 'PENDING',
      v_label, v_attendance, v_layout, v_facilities,
      v_accessibility, v_special, v_is_primary, v_range
    )
    RETURNING booking_id INTO v_booking_id;

    v_first_booking_id := COALESCE(v_first_booking_id, v_booking_id);
    v_booking_ids := v_booking_ids || v_booking_id;
    v_venue_ids := v_venue_ids || v_venue_id;
    v_venue_names := v_venue_names || v_venue.name::text;
    v_bookings := v_bookings || jsonb_build_array(jsonb_build_object(
      'index', v_index,
      'bookingId', v_booking_id,
      'venueId', v_venue_id,
      'venueName', v_venue.name,
      'label', v_label,
      'start', v_start,
      'end', v_end,
      'occupiedStart', lower(v_range),
      'occupiedEnd', upper(v_range),
      'expectedAttendance', v_attendance,
      'layout', v_layout,
      'requiredFacilities', to_jsonb(v_facilities),
      'accessibilityNeeds', to_jsonb(v_accessibility),
      'specialRequirements', v_special,
      'isPrimary', v_is_primary,
      'status', 'PENDING'
    ));
  END LOOP;

  UPDATE public.event
     SET arrangement_version = arrangement_version + 1
   WHERE event_id = p_event_id
  RETURNING arrangement_version INTO v_arrangement_version;

  v_request_id := 'REQ-' || lpad(p_event_id::text, 6, '0');

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', p_event_id, 'VENUE_BOOKINGS_REQUESTED',
    format('Venue booking requested: %s.', array_to_string(v_venue_names, ', ')),
    'COORDINATOR',
    jsonb_build_object('bookingIds', to_jsonb(v_booking_ids), 'venueIds', to_jsonb(v_venue_ids),
                       'arrangementVersion', v_arrangement_version),
    'STAFF_ONLY'
  );

  -- Every active Venue Staff member decides bookings (Master 8, SPM-194 AC1).
  PERFORM public._notify_event_users(
    p_event_id,
    'New venue booking request',
    format('%s "%s" requests %s: %s.',
           v_request_id, v_event.title,
           CASE WHEN v_count = 1 THEN 'a venue booking' ELSE v_count || ' venue bookings' END,
           array_to_string(v_venue_names, ', ')),
    ARRAY(SELECT user_id FROM public."user" WHERE role = 'VENUE_STAFF' AND is_active ORDER BY user_id),
    'BOOKING_UPDATE',
    format('VENUE_BOOKINGS_REQUESTED:%s:%s', p_event_id, v_first_booking_id),
    NULL
  );

  v_response := jsonb_build_object(
    'eventId', p_event_id,
    'requestId', v_request_id,
    'arrangementVersion', v_arrangement_version,
    'bookings', v_bookings,
    'warnings', COALESCE(p_warnings, '[]'::jsonb)
  );
  RETURN public._store_idempotent_response(
    p_actor_id, 'event.request_venue_bookings', p_idempotency_key, v_response
  );
END;
$$;

REVOKE ALL ON FUNCTION public._venue_booking_room(integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._require_booking_coordinator(integer, public.event) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.begin_venue_booking_request(integer, integer, integer[], text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_venue_bookings(integer, integer, jsonb, jsonb, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_venue_booking_request(integer, integer, integer[], text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_venue_bookings(integer, integer, jsonb, jsonb, jsonb, text, text) TO service_role;
