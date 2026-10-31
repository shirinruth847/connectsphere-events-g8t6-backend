-- SPM-190: recheck capacity under the event -> venue placement locks.
-- Apply before deploying the backend error mapping. No backfill or business
-- row changes: existing holds and same-key committed replays stay intact.
-- Rollback of application code should retain this correctness guard.

CREATE OR REPLACE FUNCTION public.begin_venue_hold_placement(
  p_actor_id integer,
  p_request_id integer,
  p_occupied_start timestamptz,
  p_occupied_end timestamptz,
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
  v_request public.venue_hold_request;
  v_event public.event;
  v_venue public.venue;
BEGIN
  IF p_actor_id IS NULL OR p_request_id IS NULL OR p_occupied_start IS NULL OR p_occupied_end IS NULL
     OR p_occupied_end <= p_occupied_start THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_HOLD';
  END IF;
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  PERFORM public._require_venue_staff(p_actor_id);

  v_replay := public._claim_idempotency_key(p_actor_id, 'venue.place_hold', p_idempotency_key, p_request_hash);
  IF v_replay IS NOT NULL THEN
    RETURN jsonb_build_object('replay', v_replay);
  END IF;

  v_request := public._lock_venue_hold_request(p_request_id);
  SELECT * INTO v_venue FROM public.venue WHERE venue_id = v_request.venue_id FOR UPDATE;
  SELECT * INTO v_event FROM public.event WHERE event_id = v_request.event_id;

  IF v_request.status <> 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'HOLD_REQUEST_DECIDED',
      DETAIL = jsonb_build_object('status', v_request.status)::text;
  END IF;
  IF v_event.status::text <> 'PLANNING' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_IN_PLANNING';
  END IF;
  IF NOT v_venue.is_active OR v_venue.status <> 'ACTIVE' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_NOT_BOOKABLE';
  END IF;

  -- Attendance is optional, as in the advisory preview. For a new placement,
  -- enforce its explicit attendance against the current venue while locked.
  -- A committed same-key replay above remains a replay, not a new decision.
  IF v_request.expected_attendance IS NOT NULL
     AND v_request.expected_attendance > v_venue.max_capacity THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_CAPACITY_EXCEEDED';
  END IF;

  IF v_request.start_datetime < v_event.start_datetime OR v_request.end_datetime > v_event.end_datetime THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'HOLD_OUTSIDE_EVENT';
  END IF;
  -- The occupied bounds came from this venue's set-once minutes. Preserve
  -- those minutes for bookings whose stored occupied_range is still NULL.
  IF p_occupied_start > v_request.start_datetime OR p_occupied_end < v_request.end_datetime
     OR extract(epoch FROM (v_request.start_datetime - p_occupied_start)) NOT BETWEEN 0 AND 86400
     OR extract(epoch FROM (p_occupied_end - v_request.end_datetime)) NOT BETWEEN 0 AND 86400
     OR mod(extract(epoch FROM (v_request.start_datetime - p_occupied_start)), 60) <> 0
     OR mod(extract(epoch FROM (p_occupied_end - v_request.end_datetime)), 60) <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_HOLD';
  END IF;

  RETURN jsonb_build_object(
    'serverNow', clock_timestamp(),
    'replay', NULL,
    'request', jsonb_build_object(
      'holdRequestId', v_request.hold_request_id,
      'eventId', v_request.event_id,
      'venueId', v_request.venue_id,
      'label', v_request.label,
      'start', v_request.start_datetime,
      'end', v_request.end_datetime
    ),
    'bookingConflicts', public._venue_hold_booking_conflicts(v_request.venue_id, p_occupied_start, p_occupied_end,
      (extract(epoch FROM (v_request.start_datetime - p_occupied_start)) / 60)::integer,
      (extract(epoch FROM (p_occupied_end - v_request.end_datetime)) / 60)::integer)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.begin_venue_hold_placement(integer,integer,timestamptz,timestamptz,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_venue_hold_placement(integer,integer,timestamptz,timestamptz,text,text)
  TO venue_calendar_writer;
