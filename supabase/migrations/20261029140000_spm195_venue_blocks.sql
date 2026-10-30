-- SPM-195: Venue Staff block a venue for a period, the bookings and holds it
-- covers get VENUE_BLOCK incidents, and Venue Staff restore a booking once the
-- venue is free again (Master 5.2, 5.3, 5.4.4, 6.2, 7, 7.1, 7.4, 8; Q3, T4, T7,
-- T27, T33).
--
-- Each operation is one transaction on the venue lock connection
-- (VENUE_LOCK_DATABASE_URL). Blocks start from a venue, so they follow the
-- Master 7 lock order: the backend reads the affected events first, then
--   BEGIN;
--   begin_venue_block / begin_venue_block_change
--       -- idempotency claim (create only), event locks, venue lock, and the
--       -- affected events re-read under the locks
--   (backend re-reads MongoDB holds under the lock; if an affected event is
--    not locked, it rolls back and starts again with the larger set)
--   record_venue_block / record_venue_block_change
--       -- incidents, arrangement versions, supersession, activity, notices
--   (backend writes the BLOCK document in MongoDB)
--   COMMIT;          -- only if the MongoDB write succeeded
-- Restoring a booking locks its event, then the venue:
--   BEGIN; begin_venue_incident_restore; (MongoDB block check);
--   restore_venue_incident; COMMIT;
--
-- Business errors are P0001/P0002 with a stable MESSAGE. Only
-- venue_calendar_writer may run these functions (SPM-179 lock hardening).
--
-- Privilege administration is an owner action (Master 10.3.1): run this file in
-- the Supabase SQL editor; the version is recorded afterwards.

-- Allow the two idempotent operations, preserving operations added by other
-- branches (same pattern as 20261028162013_spm179_request_venue_bookings).
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
       ADD CONSTRAINT idempotency_records_operation_check CHECK ((%s) OR operation = ANY (ARRAY[%L, %L]))',
    v_existing_check, 'venue.create_block', 'venue.restore_incident'
  );
END;
$idempotency_operations$;

-- Active bookings at a venue whose occupied range overlaps [p_start, p_end),
-- for events that can still be affected (AC3). A booking's stored occupied
-- range is used; an older row without one gets the venue's minutes, which
-- never change once set (Master 5.4.1).
CREATE OR REPLACE FUNCTION public._venue_block_affected_bookings(
  p_venue_id integer,
  p_start timestamptz,
  p_end timestamptz,
  p_setup integer,
  p_turnaround integer
)
RETURNS TABLE (booking_id integer, event_id integer, occupied_range tstzrange)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT b.booking_id, b.event_id, occupied.range
    FROM public.venue_booking AS b
    JOIN public.event AS e ON e.event_id = b.event_id
   CROSS JOIN LATERAL (
     SELECT COALESCE(
              b.occupied_range,
              tstzrange(b.start_datetime - make_interval(mins => COALESCE(p_setup, 0)),
                        b.end_datetime + make_interval(mins => COALESCE(p_turnaround, 0)), '[)')
            ) AS range
   ) AS occupied
   WHERE b.venue_id = p_venue_id
     AND b.status IN ('PENDING', 'APPROVED')
     AND e.status::text NOT IN ('DRAFT', 'COMPLETED', 'CANCELLED', 'REJECTED')
     AND occupied.range && tstzrange(p_start, p_end, '[)')
   ORDER BY b.booking_id;
$$;

-- "29 Oct 2026 13:00" in venue local time (Master 5.4: venues are in Singapore).
CREATE OR REPLACE FUNCTION public._venue_local_time(p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT to_char(p_at AT TIME ZONE 'Asia/Singapore', 'FMDD Mon YYYY HH24:MI');
$$;

CREATE OR REPLACE FUNCTION public._venue_block_reason_label(p_reason text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE p_reason
           WHEN 'MAINTENANCE' THEN 'Maintenance'
           WHEN 'EQUIPMENT_FAILURE' THEN 'Equipment failure'
           WHEN 'RENOVATION' THEN 'Renovation'
           WHEN 'SAFETY' THEN 'Safety'
           WHEN 'OTHER' THEN 'Other'
         END;
$$;

-- Locks the given events (ascending), then the venue, as Master 7 orders them.
-- A deleted venue is "not found"; a venue out of service can still be blocked.
CREATE OR REPLACE FUNCTION public._lock_events_then_venue(p_event_ids integer[], p_venue_id integer)
RETURNS public.venue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_venue public.venue;
BEGIN
  PERFORM 1 FROM public.event
   WHERE event_id = ANY (COALESCE(p_event_ids, ARRAY[]::integer[]))
   ORDER BY event_id
   FOR UPDATE;

  SELECT * INTO v_venue FROM public.venue WHERE venue_id = p_venue_id FOR UPDATE;
  IF NOT FOUND OR NOT v_venue.is_active THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'VENUE_NOT_FOUND';
  END IF;
  RETURN v_venue;
END;
$$;

-- Step 1 of recording a block (AC1, AC12, AC13). p_event_ids are the events the
-- backend read as affected before taking any lock: bookings here and MongoDB
-- holds. The response lists the booking events affected now, under the locks;
-- the backend restarts when one of them, or a hold's event, is not locked.
CREATE OR REPLACE FUNCTION public.begin_venue_block(
  p_actor_id integer,
  p_venue_id integer,
  p_start timestamptz,
  p_end timestamptz,
  p_setup integer,
  p_turnaround integer,
  p_event_ids integer[],
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_replay jsonb;
  v_venue public.venue;
  v_affected integer[];
BEGIN
  IF p_actor_id IS NULL OR p_venue_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start
     OR cardinality(COALESCE(p_event_ids, ARRAY[]::integer[])) > 1000
     OR array_position(p_event_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_BLOCK';
  END IF;
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  PERFORM public._require_venue_staff(p_actor_id);

  v_replay := public._claim_idempotency_key(p_actor_id, 'venue.create_block', p_idempotency_key, p_request_hash);
  IF v_replay IS NOT NULL THEN
    RETURN jsonb_build_object('replay', v_replay);
  END IF;

  v_venue := public._lock_events_then_venue(p_event_ids, p_venue_id);

  SELECT COALESCE(array_agg(DISTINCT affected.event_id ORDER BY affected.event_id), ARRAY[]::integer[])
    INTO v_affected
    FROM public._venue_block_affected_bookings(p_venue_id, p_start, p_end, p_setup, p_turnaround) AS affected;

  RETURN jsonb_build_object(
    'replay', NULL,
    'venue', jsonb_build_object('venueId', v_venue.venue_id, 'name', v_venue.name, 'status', v_venue.status),
    'affectedEventIds', to_jsonb(v_affected)
  );
END;
$$;

-- Step 2: under the same locks, one OPEN incident per affected booking and hold,
-- then per affected event the arrangement version, safety-review supersession,
-- activity and notices; one venue activity entry (AC3–AC5, AC13, AC14).
-- p_block: { blockId, reason, start, end, note }. p_holds: [{ holdId, eventId }],
-- the active holds the backend read from MongoDB under the lock.
CREATE OR REPLACE FUNCTION public.record_venue_block(
  p_actor_id integer,
  p_venue_id integer,
  p_block jsonb,
  p_holds jsonb,
  p_setup integer,
  p_turnaround integer,
  p_event_ids integer[],
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_venue public.venue;
  v_block_id text := p_block ->> 'blockId';
  v_reason text := p_block ->> 'reason';
  v_note text := btrim(p_block ->> 'note');
  v_start timestamptz;
  v_end timestamptz;
  v_period text;
  v_event public.event;
  v_event_id integer;
  v_request_id text;
  v_incidents jsonb := '[]'::jsonb;
  v_events jsonb := '[]'::jsonb;
  v_affected_event_ids integer[] := ARRAY[]::integer[];
  v_hold jsonb;
  v_hold_event_id integer;
  v_incident_id integer;
  v_row record;
  v_response jsonb;
BEGIN
  PERFORM public._require_venue_staff(p_actor_id);
  BEGIN
    v_start := (p_block ->> 'start')::timestamptz;
    v_end := (p_block ->> 'end')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    v_start := NULL;
  END;
  IF v_block_id IS NULL OR v_block_id !~ '^[0-9a-f]{24}$'
     OR v_reason IS NULL OR v_reason NOT IN ('MAINTENANCE', 'EQUIPMENT_FAILURE', 'RENOVATION', 'SAFETY', 'OTHER')
     OR v_note IS NULL OR v_note = '' OR char_length(v_note) > 1000
     OR v_start IS NULL OR v_end IS NULL OR v_end <= v_start OR v_end <= now()
     OR jsonb_typeof(COALESCE(p_holds, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_BLOCK';
  END IF;

  -- Already locked by begin_venue_block in this transaction.
  SELECT * INTO v_venue FROM public.venue WHERE venue_id = p_venue_id FOR UPDATE;
  IF NOT FOUND OR NOT v_venue.is_active THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'VENUE_NOT_FOUND';
  END IF;
  v_period := format('%s to %s', public._venue_local_time(v_start), public._venue_local_time(v_end));

  FOR v_row IN
    SELECT * FROM public._venue_block_affected_bookings(p_venue_id, v_start, v_end, p_setup, p_turnaround)
  LOOP
    IF NOT (v_row.event_id = ANY (COALESCE(p_event_ids, ARRAY[]::integer[]))) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AFFECTED_SET_CHANGED';
    END IF;
    INSERT INTO public.resource_incidents (event_id, type, booking_id, calendar_block_id)
    VALUES (v_row.event_id, 'VENUE_BLOCK', v_row.booking_id, v_block_id)
    ON CONFLICT (calendar_block_id, booking_id) WHERE type = 'VENUE_BLOCK' AND booking_id IS NOT NULL
    DO NOTHING
    RETURNING incident_id INTO v_incident_id;
    IF v_incident_id IS NOT NULL THEN
      v_incidents := v_incidents || jsonb_build_array(jsonb_build_object(
        'incidentId', v_incident_id, 'eventId', v_row.event_id, 'bookingId', v_row.booking_id, 'calendarHoldId', NULL
      ));
    END IF;
    v_affected_event_ids := v_affected_event_ids || v_row.event_id;
  END LOOP;

  FOR v_hold IN SELECT value FROM jsonb_array_elements(COALESCE(p_holds, '[]'::jsonb))
  LOOP
    BEGIN
      v_hold_event_id := (v_hold ->> 'eventId')::integer;
    EXCEPTION WHEN OTHERS THEN
      v_hold_event_id := NULL;
    END;
    IF v_hold_event_id IS NULL OR (v_hold ->> 'holdId') IS NULL OR (v_hold ->> 'holdId') !~ '^[0-9a-f]{24}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_BLOCK';
    END IF;
    IF NOT (v_hold_event_id = ANY (COALESCE(p_event_ids, ARRAY[]::integer[]))) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AFFECTED_SET_CHANGED';
    END IF;
    -- A hold of a closed event no longer occupies anything worth an incident (AC3).
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM public.event
       WHERE event_id = v_hold_event_id
         AND status::text NOT IN ('DRAFT', 'COMPLETED', 'CANCELLED', 'REJECTED')
    );
    v_incident_id := NULL;
    INSERT INTO public.resource_incidents (event_id, type, calendar_hold_id, calendar_block_id)
    VALUES (v_hold_event_id, 'VENUE_BLOCK', v_hold ->> 'holdId', v_block_id)
    ON CONFLICT (calendar_block_id, calendar_hold_id) WHERE type = 'VENUE_BLOCK' AND calendar_hold_id IS NOT NULL
    DO NOTHING
    RETURNING incident_id INTO v_incident_id;
    IF v_incident_id IS NOT NULL THEN
      v_incidents := v_incidents || jsonb_build_array(jsonb_build_object(
        'incidentId', v_incident_id, 'eventId', v_hold_event_id, 'bookingId', NULL, 'calendarHoldId', v_hold ->> 'holdId'
      ));
    END IF;
    v_affected_event_ids := v_affected_event_ids || v_hold_event_id;
  END LOOP;

  FOR v_event_id IN SELECT DISTINCT unnest(v_affected_event_ids) ORDER BY 1
  LOOP
    -- Arrangement version + 1, and an open safety review closed as SUPERSEDED
    -- with the event back in PLANNING (Master 5.2, 5.4.4, T7). Otherwise the
    -- event keeps its state (AC4).
    PERFORM public._supersede_safety_review(
      v_event_id, p_actor_id,
      format('%s is blocked (%s) from %s.', v_venue.name, public._venue_block_reason_label(v_reason), v_period)
    );
    SELECT * INTO v_event FROM public.event WHERE event_id = v_event_id;
    v_request_id := 'REQ-' || lpad(v_event_id::text, 6, '0');

    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
    VALUES (
      p_actor_id, 'event', v_event_id, 'VENUE_BLOCK_AFFECTED_EVENT',
      format('%s is blocked (%s) from %s. The venue arrangement is affected.',
             v_venue.name, public._venue_block_reason_label(v_reason), v_period),
      'VENUE_STAFF',
      jsonb_build_object('venueAvailability', jsonb_build_object(
        'before', format('%s available', v_venue.name),
        'after', format('%s blocked %s (%s)', v_venue.name, v_period, public._venue_block_reason_label(v_reason))
      )),
      'STAFF_ONLY'
    );

    -- Coordinator: "Alternative venue required" (SPM-193/SPM-264).
    PERFORM public._notify_coordinator_venue_blocked(v_event_id, v_block_id, p_venue_id, v_reason);
    -- Organiser: affected and what happens next, without the internal reason (AC5, Master 8).
    PERFORM public._notify_event_users(
      v_event_id,
      'Venue arrangement affected',
      format('%s is unavailable during your booking for %s "%s". Your event is not cancelled; your coordinator will decide the next step.',
             v_venue.name, v_request_id, v_event.title),
      public._event_owner_recipients(v_event),
      'BOOKING_UPDATE',
      format('VENUE_BLOCKED:%s:%s:OWNER', v_block_id, v_event_id),
      NULL
    );
    -- The other Venue Staff: the venue, the period and the event reference.
    PERFORM public._notify_event_users(
      v_event_id,
      'Venue blocked',
      format('%s is blocked (%s) from %s. Affected: %s "%s".',
             v_venue.name, public._venue_block_reason_label(v_reason), v_period, v_request_id, v_event.title),
      ARRAY(SELECT user_id FROM public."user"
             WHERE role = 'VENUE_STAFF' AND is_active AND user_id <> p_actor_id ORDER BY user_id),
      'BOOKING_UPDATE',
      format('VENUE_BLOCKED:%s:%s:VENUE_STAFF', v_block_id, v_event_id),
      NULL
    );

    v_events := v_events || jsonb_build_array(jsonb_build_object(
      'eventId', v_event_id,
      'requestId', v_request_id,
      'title', v_event.title,
      'status', v_event.status,
      'arrangementVersion', v_event.arrangement_version
    ));
  END LOOP;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'venue', p_venue_id, 'VENUE_BLOCK_CREATED',
    format('%s blocked (%s) from %s. %s event(s) affected.',
           v_venue.name, public._venue_block_reason_label(v_reason), v_period, jsonb_array_length(v_events)),
    'VENUE_STAFF',
    jsonb_build_object('block', jsonb_build_object(
      'before', NULL,
      'after', format('%s (%s): %s', v_period, public._venue_block_reason_label(v_reason), v_note)
    )),
    'STAFF_ONLY'
  );

  v_response := jsonb_build_object(
    'block', jsonb_build_object(
      'blockId', v_block_id,
      'venueId', p_venue_id,
      'venueName', v_venue.name,
      'reason', v_reason,
      'start', v_start,
      'end', v_end,
      'note', v_note,
      'status', 'ACTIVE'
    ),
    'incidents', v_incidents,
    'affectedEvents', v_events
  );
  RETURN public._store_idempotent_response(p_actor_id, 'venue.create_block', p_idempotency_key, v_response);
END;
$$;

-- Step 1 of shortening or lifting a block (AC9): the events with an open
-- incident for this block (read first by the backend) are locked, then the venue.
CREATE OR REPLACE FUNCTION public.begin_venue_block_change(
  p_actor_id integer,
  p_venue_id integer,
  p_block_id text,
  p_event_ids integer[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_venue public.venue;
  v_affected integer[];
BEGIN
  IF p_actor_id IS NULL OR p_venue_id IS NULL OR p_block_id IS NULL OR p_block_id !~ '^[0-9a-f]{24}$'
     OR cardinality(COALESCE(p_event_ids, ARRAY[]::integer[])) > 1000
     OR array_position(p_event_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_BLOCK';
  END IF;
  PERFORM public._require_venue_staff(p_actor_id);
  v_venue := public._lock_events_then_venue(p_event_ids, p_venue_id);

  SELECT COALESCE(array_agg(DISTINCT event_id ORDER BY event_id), ARRAY[]::integer[])
    INTO v_affected
    FROM public.resource_incidents
   WHERE calendar_block_id = p_block_id AND type = 'VENUE_BLOCK' AND status = 'OPEN';

  RETURN jsonb_build_object(
    'venue', jsonb_build_object('venueId', v_venue.venue_id, 'name', v_venue.name, 'status', v_venue.status),
    'affectedEventIds', to_jsonb(v_affected)
  );
END;
$$;

-- Step 2: one venue activity entry and one per affected event (AC14). Open
-- incidents stay open: Venue Staff restore each booking separately (Q3, AC10).
-- p_action is SHORTENED or LIFTED; p_before/p_after are { start, end }.
-- Returns the block's open incidents with each booking's occupied range, so
-- the backend can show which ones can now be restored.
CREATE OR REPLACE FUNCTION public.record_venue_block_change(
  p_actor_id integer,
  p_venue_id integer,
  p_block_id text,
  p_action text,
  p_before jsonb,
  p_after jsonb,
  p_setup integer,
  p_turnaround integer,
  p_event_ids integer[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_venue public.venue;
  v_before text;
  v_after text;
  v_event_id integer;
  v_open jsonb;
BEGIN
  PERFORM public._require_venue_staff(p_actor_id);
  IF p_action IS NULL OR p_action NOT IN ('SHORTENED', 'LIFTED') OR p_block_id IS NULL OR p_block_id !~ '^[0-9a-f]{24}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_BLOCK';
  END IF;
  SELECT * INTO v_venue FROM public.venue WHERE venue_id = p_venue_id FOR UPDATE;
  IF NOT FOUND OR NOT v_venue.is_active THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'VENUE_NOT_FOUND';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.resource_incidents
     WHERE calendar_block_id = p_block_id AND type = 'VENUE_BLOCK' AND status = 'OPEN'
       AND NOT (event_id = ANY (COALESCE(p_event_ids, ARRAY[]::integer[])))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AFFECTED_SET_CHANGED';
  END IF;

  BEGIN
    v_before := format('%s to %s', public._venue_local_time((p_before ->> 'start')::timestamptz),
                       public._venue_local_time((p_before ->> 'end')::timestamptz));
    v_after := CASE WHEN p_action = 'LIFTED' THEN 'Lifted'
                    ELSE format('%s to %s', public._venue_local_time((p_after ->> 'start')::timestamptz),
                                public._venue_local_time((p_after ->> 'end')::timestamptz)) END;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_BLOCK';
  END;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'venue', p_venue_id, 'VENUE_BLOCK_' || p_action,
    format('Block on %s %s.', v_venue.name, CASE WHEN p_action = 'LIFTED' THEN 'lifted' ELSE 'shortened' END),
    'VENUE_STAFF',
    jsonb_build_object('block', jsonb_build_object('before', v_before, 'after', v_after)),
    'STAFF_ONLY'
  );

  FOR v_event_id IN
    SELECT DISTINCT event_id FROM public.resource_incidents
     WHERE calendar_block_id = p_block_id AND type = 'VENUE_BLOCK' AND status = 'OPEN'
     ORDER BY event_id
  LOOP
    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
    VALUES (
      p_actor_id, 'event', v_event_id, 'VENUE_BLOCK_' || p_action,
      format('The block on %s was %s. Venue Staff confirm whether the booking can be restored.',
             v_venue.name, CASE WHEN p_action = 'LIFTED' THEN 'lifted' ELSE 'shortened' END),
      'VENUE_STAFF',
      jsonb_build_object('venueBlock', jsonb_build_object('before', v_before, 'after', v_after)),
      'STAFF_ONLY'
    );
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'incidentId', i.incident_id,
           'eventId', i.event_id,
           'bookingId', i.booking_id,
           'calendarHoldId', i.calendar_hold_id,
           'occupiedStart', lower(occupied.range),
           'occupiedEnd', upper(occupied.range)
         ) ORDER BY i.incident_id), '[]'::jsonb)
    INTO v_open
    FROM public.resource_incidents AS i
    LEFT JOIN public.venue_booking AS b ON b.booking_id = i.booking_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(
               b.occupied_range,
               tstzrange(b.start_datetime - make_interval(mins => COALESCE(p_setup, 0)),
                         b.end_datetime + make_interval(mins => COALESCE(p_turnaround, 0)), '[)')
             ) AS range
    ) AS occupied ON b.booking_id IS NOT NULL
   WHERE i.calendar_block_id = p_block_id AND i.type = 'VENUE_BLOCK' AND i.status = 'OPEN';

  RETURN jsonb_build_object('openIncidents', v_open);
END;
$$;

-- Step 1 of restoring a booking (AC10, AC13): idempotency claim, then the
-- incident's event and the venue are locked in Master 7 order. A resolved
-- incident returns its final state and changes nothing. p_venue_id is the
-- venue the backend read for the incident (the booking's venue, or the hold's
-- in MongoDB); a booking at another venue is "not found".
CREATE OR REPLACE FUNCTION public.begin_venue_incident_restore(
  p_actor_id integer,
  p_incident_id integer,
  p_venue_id integer,
  p_setup integer,
  p_turnaround integer,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_replay jsonb;
  v_event_id integer;
  v_venue public.venue;
  v_incident public.resource_incidents;
  v_event public.event;
  v_booking public.venue_booking;
  v_range tstzrange;
BEGIN
  IF p_actor_id IS NULL OR p_incident_id IS NULL OR p_venue_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'INCIDENT_NOT_FOUND';
  END IF;
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  PERFORM public._require_venue_staff(p_actor_id);

  v_replay := public._claim_idempotency_key(p_actor_id, 'venue.restore_incident', p_idempotency_key, p_request_hash);
  IF v_replay IS NOT NULL THEN
    RETURN jsonb_build_object('replay', v_replay);
  END IF;

  SELECT event_id INTO v_event_id
    FROM public.resource_incidents WHERE incident_id = p_incident_id AND type = 'VENUE_BLOCK';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'INCIDENT_NOT_FOUND';
  END IF;
  v_venue := public._lock_events_then_venue(ARRAY[v_event_id], p_venue_id);
  SELECT * INTO v_event FROM public.event WHERE event_id = v_event_id;
  SELECT * INTO v_incident FROM public.resource_incidents WHERE incident_id = p_incident_id FOR UPDATE;

  IF v_incident.booking_id IS NOT NULL THEN
    SELECT * INTO v_booking FROM public.venue_booking WHERE booking_id = v_incident.booking_id;
    IF v_booking.venue_id IS DISTINCT FROM p_venue_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'INCIDENT_NOT_FOUND';
    END IF;
    v_range := COALESCE(
      v_booking.occupied_range,
      tstzrange(v_booking.start_datetime - make_interval(mins => COALESCE(p_setup, 0)),
                v_booking.end_datetime + make_interval(mins => COALESCE(p_turnaround, 0)), '[)')
    );
  END IF;

  IF v_incident.status = 'RESOLVED' THEN
    RETURN jsonb_build_object('replay', public._store_idempotent_response(
      p_actor_id, 'venue.restore_incident', p_idempotency_key,
      jsonb_build_object(
        'incidentId', v_incident.incident_id,
        'eventId', v_incident.event_id,
        'bookingId', v_incident.booking_id,
        'calendarHoldId', v_incident.calendar_hold_id,
        'status', v_incident.status,
        'resolution', v_incident.resolution,
        'resolvedAt', v_incident.resolved_at,
        'arrangementVersion', v_event.arrangement_version,
        'changed', false
      )
    ));
  END IF;

  IF v_event.status::text IN ('DRAFT', 'COMPLETED', 'CANCELLED', 'REJECTED')
     OR (v_incident.booking_id IS NOT NULL AND v_booking.status::text NOT IN ('PENDING', 'APPROVED')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INCIDENT_NOT_RESTORABLE';
  END IF;
  IF v_venue.status <> 'ACTIVE' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_OUT_OF_SERVICE';
  END IF;

  RETURN jsonb_build_object(
    'replay', NULL,
    'incident', jsonb_build_object(
      'incidentId', v_incident.incident_id,
      'eventId', v_incident.event_id,
      'bookingId', v_incident.booking_id,
      'calendarHoldId', v_incident.calendar_hold_id,
      'calendarBlockId', v_incident.calendar_block_id,
      'occupiedStart', lower(v_range),
      'occupiedEnd', upper(v_range),
      'start', v_booking.start_datetime
    )
  );
END;
$$;

-- Step 2, once the backend has found no active block over the occupied range
-- under the lock: the incident is RESOLVED / RESTORED, the arrangement version
-- increases, the event keeps its state, history is written and the
-- coordinator and organiser are told (AC10, AC14, Master 7.1).
-- p_start is the booking's (or hold's) start, for the notice.
CREATE OR REPLACE FUNCTION public.restore_venue_incident(
  p_actor_id integer,
  p_incident_id integer,
  p_venue_id integer,
  p_start timestamptz,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_incident public.resource_incidents;
  v_event public.event;
  v_venue public.venue;
  v_request_id text;
  v_subject text;
  v_response jsonb;
BEGIN
  PERFORM public._require_venue_staff(p_actor_id);
  SELECT * INTO v_incident FROM public.resource_incidents WHERE incident_id = p_incident_id FOR UPDATE;
  IF NOT FOUND OR v_incident.type <> 'VENUE_BLOCK' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'INCIDENT_NOT_FOUND';
  END IF;
  IF v_incident.status <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INCIDENT_NOT_RESTORABLE';
  END IF;
  SELECT * INTO v_venue FROM public.venue WHERE venue_id = p_venue_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'INCIDENT_NOT_FOUND';
  END IF;

  UPDATE public.resource_incidents
     SET status = 'RESOLVED', resolution = 'RESTORED', resolved_at = now()
   WHERE incident_id = p_incident_id
  RETURNING * INTO v_incident;

  UPDATE public.event
     SET arrangement_version = arrangement_version + 1, updated_at = now()
   WHERE event_id = v_incident.event_id
  RETURNING * INTO v_event;

  v_request_id := 'REQ-' || lpad(v_event.event_id::text, 6, '0');
  v_subject := CASE WHEN v_incident.booking_id IS NOT NULL
                    THEN format('Booking #%s', v_incident.booking_id) ELSE 'Tentative hold' END;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES
    (p_actor_id, 'event', v_event.event_id, 'VENUE_BOOKING_RESTORED',
     format('%s at %s restored after the venue block.', v_subject, v_venue.name),
     'VENUE_STAFF',
     jsonb_build_object('venueAvailability', jsonb_build_object(
       'before', format('%s blocked', v_venue.name), 'after', format('%s available again', v_venue.name))),
     'STAFF_ONLY'),
    (p_actor_id, 'venue', p_venue_id, 'VENUE_BOOKING_RESTORED',
     format('%s for %s restored.', v_subject, v_request_id),
     'VENUE_STAFF',
     jsonb_build_object('incident', jsonb_build_object('before', 'OPEN', 'after', 'RESTORED')),
     'STAFF_ONLY');

  PERFORM public._notify_event_users(
    v_event.event_id,
    'Venue available again',
    CASE WHEN p_start IS NULL
         THEN format('%s is available again for your booking for %s "%s".', v_venue.name, v_request_id, v_event.title)
         ELSE format('%s is available again for your booking on %s.', v_venue.name, public._venue_local_time(p_start)) END,
    public._event_coordinator_recipients(v_event) || public._event_owner_recipients(v_event),
    'BOOKING_UPDATE',
    format('VENUE_RESTORED:%s', v_incident.incident_id),
    NULL
  );

  v_response := jsonb_build_object(
    'incidentId', v_incident.incident_id,
    'eventId', v_incident.event_id,
    'bookingId', v_incident.booking_id,
    'calendarHoldId', v_incident.calendar_hold_id,
    'status', v_incident.status,
    'resolution', v_incident.resolution,
    'resolvedAt', v_incident.resolved_at,
    'arrangementVersion', v_event.arrangement_version,
    'changed', true
  );
  RETURN public._store_idempotent_response(p_actor_id, 'venue.restore_incident', p_idempotency_key, v_response);
END;
$$;

-- Only the venue lock connection runs the entry points (SPM-179 lock hardening):
-- through the Data API each call would be its own transaction, skipping the
-- MongoDB checks and writes made under the lock. Helpers run inside them only.
REVOKE ALL ON FUNCTION public._venue_block_affected_bookings(integer, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._venue_local_time(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._venue_block_reason_label(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._lock_events_then_venue(integer[], integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.begin_venue_block(integer, integer, timestamptz, timestamptz, integer, integer, integer[], text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_venue_block(integer, integer, jsonb, jsonb, integer, integer, integer[], text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.begin_venue_block_change(integer, integer, text, integer[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_venue_block_change(integer, integer, text, text, jsonb, jsonb, integer, integer, integer[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.begin_venue_incident_restore(integer, integer, integer, integer, integer, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.restore_venue_incident(integer, integer, integer, timestamptz, text, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.begin_venue_block(integer, integer, timestamptz, timestamptz, integer, integer, integer[], text, text) TO venue_calendar_writer;
GRANT EXECUTE ON FUNCTION public.record_venue_block(integer, integer, jsonb, jsonb, integer, integer, integer[], text, text) TO venue_calendar_writer;
GRANT EXECUTE ON FUNCTION public.begin_venue_block_change(integer, integer, text, integer[]) TO venue_calendar_writer;
GRANT EXECUTE ON FUNCTION public.record_venue_block_change(integer, integer, text, text, jsonb, jsonb, integer, integer, integer[]) TO venue_calendar_writer;
GRANT EXECUTE ON FUNCTION public.begin_venue_incident_restore(integer, integer, integer, integer, integer, text, text) TO venue_calendar_writer;
GRANT EXECUTE ON FUNCTION public.restore_venue_incident(integer, integer, integer, timestamptz, text, text) TO venue_calendar_writer;
