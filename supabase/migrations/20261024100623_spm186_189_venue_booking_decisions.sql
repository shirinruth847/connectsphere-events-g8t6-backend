-- SPM-186 / SPM-189: Venue Staff approve and reject venue booking requests, and
-- taking a venue out of service alerts the affected events (Master 5.4, 5.4.4,
-- 7.1 "Venue decision", 8, T31).
--   * venue_booking.reviewed_at records when the decision was made; reviewed_by
--     (already present) records who made it.
--   * decide_venue_booking approves or rejects one booking. A pending booking
--     is approved or rejected; an approved, not yet started booking may still
--     be rejected when the venue can no longer host it (T31). The event is never
--     cancelled or rejected: its arrangement version increases, an open safety
--     review is superseded (the event returns to PLANNING) and the coordinator
--     and organiser are notified, all in one transaction.
--   * set_venue_status now takes the event locks before the venue lock (Master
--     7), lists the affected events in its warning, and on a confirmed change
--     out of service records the change on each affected event and notifies its
--     coordinator, its organiser and the other Venue Staff. Bookings are kept.
-- Checks apply only to decisions recorded from now on (reviewed_at set): seven
-- legacy rejected rows have no reason, and no reason is invented for them.
-- Applied to the development project on 2026-10-24 as version 20261024100623.

ALTER TABLE public.venue_booking
  ADD COLUMN reviewed_at timestamptz,
  ADD CONSTRAINT venue_booking_rejection_reason_length
    CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 1000),
  ADD CONSTRAINT venue_booking_pending_not_reviewed
    CHECK (status <> 'PENDING' OR reviewed_at IS NULL),
  ADD CONSTRAINT venue_booking_rejection_has_reason
    CHECK (reviewed_at IS NULL OR status <> 'REJECTED' OR btrim(coalesce(rejection_reason, '')) <> '');

COMMENT ON COLUMN public.venue_booking.reviewed_at IS
  'When Venue Staff last decided this booking (reviewed_by is who). Null for pending and legacy rows.';

-- Events with an active booking at the venue that has not ended yet.
CREATE OR REPLACE FUNCTION public._venue_affected_event_ids(p_venue_id integer)
RETURNS integer[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(array_agg(DISTINCT b.event_id ORDER BY b.event_id), ARRAY[]::integer[])
    FROM public.venue_booking AS b
    JOIN public.room AS r ON r.room_id = b.room_id
    JOIN public.event AS e ON e.event_id = b.event_id
   WHERE r.venue_id = p_venue_id
     AND b.status IN ('PENDING', 'APPROVED')
     AND b.end_datetime > now()
     AND e.status::text NOT IN ('DRAFT', 'COMPLETED', 'CANCELLED', 'REJECTED');
$$;

-- What Venue Staff are shown before confirming: each affected event once,
-- soonest first, without participant or organiser details (Master 4.2).
CREATE OR REPLACE FUNCTION public._venue_affected_events(p_venue_id integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(jsonb_agg(item ORDER BY item->>'firstStart', (item->>'eventId')::integer), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
               'eventId', e.event_id,
               'requestId', 'REQ-' || lpad(e.event_id::text, 6, '0'),
               'title', e.title,
               'status', e.status,
               'firstStart', min(b.start_datetime),
               'bookings', count(*)
             ) AS item
        FROM public.venue_booking AS b
        JOIN public.room AS r ON r.room_id = b.room_id
        JOIN public.event AS e ON e.event_id = b.event_id
       WHERE r.venue_id = p_venue_id
         AND b.status IN ('PENDING', 'APPROVED')
         AND b.end_datetime > now()
         AND e.status::text NOT IN ('DRAFT', 'COMPLETED', 'CANCELLED', 'REJECTED')
       GROUP BY e.event_id, e.title, e.status
    ) AS affected;
$$;

CREATE OR REPLACE FUNCTION public._venue_local_time(p_at timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT to_char(p_at AT TIME ZONE 'Asia/Singapore', 'DD Mon YYYY HH24:MI');
$$;

CREATE OR REPLACE FUNCTION public.decide_venue_booking(
  p_actor_id integer,
  p_booking_id integer,
  p_decision text,
  p_expected_status text,
  p_reason text,
  p_setup_minutes integer,
  p_turnaround_minutes integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event_id integer;
  v_event public.event;
  v_venue public.venue;
  v_booking public.venue_booking;
  v_previous text;
  v_status text;
  v_reason text := nullif(btrim(p_reason), '');
  v_request_id text;
  v_booking_name text;
  v_when text;
  v_coordinator_message text;
  v_owner_message text;
  v_title text;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('APPROVE', 'REJECT') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_BOOKING_DECISION';
  END IF;
  PERFORM public._require_venue_staff(p_actor_id);

  SELECT event_id INTO v_event_id FROM public.venue_booking WHERE booking_id = p_booking_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'BOOKING_NOT_FOUND';
  END IF;

  -- Lock order (Master 7): the event, then the venue, then the booking. The
  -- venue lock serialises approvals that could overlap at the same venue.
  SELECT * INTO v_event FROM public.event WHERE event_id = v_event_id FOR UPDATE;
  IF NOT FOUND OR v_event.status::text = 'DRAFT' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'BOOKING_NOT_FOUND';
  END IF;
  SELECT v.* INTO v_venue
    FROM public.venue AS v
    JOIN public.room AS r ON r.venue_id = v.venue_id
    JOIN public.venue_booking AS b ON b.room_id = r.room_id
   WHERE b.booking_id = p_booking_id
     FOR UPDATE OF v;
  SELECT * INTO v_booking FROM public.venue_booking WHERE booking_id = p_booking_id FOR UPDATE;

  v_previous := v_booking.status::text;
  -- The status the user saw is the booking's version: decisions only move
  -- forward, so a second decision made from the same screen is refused (SPM-186 AC5).
  IF p_expected_status IS NOT NULL AND v_previous <> p_expected_status THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BOOKING_ALREADY_DECIDED',
      DETAIL = jsonb_build_object('status', v_previous)::text;
  END IF;

  IF p_decision = 'APPROVE' THEN
    IF v_previous <> 'PENDING' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BOOKING_ALREADY_DECIDED',
        DETAIL = jsonb_build_object('status', v_previous)::text;
    END IF;
    IF v_event.status::text <> 'PLANNING' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_IN_PLANNING';
    END IF;
    IF NOT v_venue.is_active OR v_venue.status <> 'ACTIVE' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_NOT_AVAILABLE';
    END IF;
    IF coalesce(v_booking.expected_attendance, v_event.expected_attendance, 0) > v_venue.max_capacity THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_CAPACITY_EXCEEDED';
    END IF;
    IF p_setup_minutes IS NULL OR p_turnaround_minutes IS NULL
       OR p_setup_minutes < 0 OR p_turnaround_minutes < 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_BUFFERS_NOT_SET';
    END IF;
    -- Both bookings are at this venue, so both occupied ranges use its minutes
    -- (set once, Master 5.4.1). Ranges are half-open.
    IF EXISTS (
      SELECT 1
        FROM public.venue_booking AS other
        JOIN public.room AS r ON r.room_id = other.room_id
       WHERE r.venue_id = v_venue.venue_id
         AND other.booking_id <> v_booking.booking_id
         AND other.status = 'APPROVED'
         AND tstzrange(other.start_datetime - make_interval(mins => p_setup_minutes),
                       other.end_datetime + make_interval(mins => p_turnaround_minutes), '[)')
          && tstzrange(v_booking.start_datetime - make_interval(mins => p_setup_minutes),
                       v_booking.end_datetime + make_interval(mins => p_turnaround_minutes), '[)')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_BOOKING_CONFLICT';
    END IF;

    UPDATE public.venue_booking
       SET status = 'APPROVED', reviewed_by = p_actor_id, reviewed_at = now(), rejection_reason = NULL
     WHERE booking_id = p_booking_id;
    v_status := 'APPROVED';
  ELSE
    IF v_reason IS NULL OR char_length(v_reason) > 1000 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REJECTION_REASON_INVALID';
    END IF;
    IF v_previous NOT IN ('PENDING', 'APPROVED') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BOOKING_ALREADY_DECIDED',
        DETAIL = jsonb_build_object('status', v_previous)::text;
    END IF;
    IF v_event.status::text IN ('COMPLETED', 'CANCELLED', 'REJECTED') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_ACTIVE';
    END IF;
    -- Changes on the day are coordinated offline (Master 5.4.4).
    IF v_previous = 'APPROVED' AND v_booking.start_datetime <= now() THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BOOKING_ALREADY_STARTED';
    END IF;

    UPDATE public.venue_booking
       SET status = 'REJECTED', reviewed_by = p_actor_id, reviewed_at = now(), rejection_reason = v_reason
     WHERE booking_id = p_booking_id;
    v_status := 'REJECTED';
  END IF;

  v_request_id := 'REQ-' || lpad(v_event.event_id::text, 6, '0');
  v_booking_name := format('booking #%s at %s', v_booking.booking_id, v_venue.name);
  v_when := public._venue_local_time(v_booking.start_datetime);

  -- Arrangement version and safety-review supersession (Master 5.2, 5.4.4).
  PERFORM public._supersede_safety_review(
    v_event.event_id, p_actor_id,
    format('Venue Staff %s %s.', CASE WHEN v_status = 'APPROVED' THEN 'approved' ELSE 'rejected' END, v_booking_name)
  );

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', v_event.event_id,
    CASE WHEN v_status = 'APPROVED' THEN 'VENUE_BOOKING_APPROVED' ELSE 'VENUE_BOOKING_REJECTED' END,
    format('Venue Staff %s the venue %s from %s.',
           CASE WHEN v_status = 'APPROVED' THEN 'approved' ELSE 'rejected' END, v_venue.name, v_when),
    'VENUE_STAFF',
    jsonb_build_object('bookingId', v_booking.booking_id,
                       'venueBooking', jsonb_build_object('before', v_previous, 'after', v_status)),
    'ORGANISER_SAFE'
  );
  IF v_status = 'REJECTED' THEN
    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
    VALUES (
      p_actor_id, 'venue_booking', v_booking.booking_id, 'VENUE_BOOKING_REJECTED',
      'Rejection reason recorded.', 'VENUE_STAFF',
      jsonb_build_object('rejectionReason', v_reason, 'previousStatus', v_previous),
      'STAFF_ONLY'
    );
  END IF;

  IF v_status = 'APPROVED' THEN
    v_title := 'Venue booking approved';
    v_coordinator_message := format('Venue Staff approved %s for event %s "%s" (%s).',
      v_booking_name, v_request_id, v_event.title, v_when);
    v_owner_message := format('%s was approved as a venue for your event %s "%s".',
      v_venue.name, v_request_id, v_event.title);
  ELSIF v_previous = 'APPROVED' THEN
    v_title := 'Venue no longer available';
    v_coordinator_message := format(
      'Venue Staff withdrew the approval of %s for event %s "%s" (%s). Reason: %s. The event is not cancelled and its details are kept; arrange an alternative venue with the organiser.',
      v_booking_name, v_request_id, v_event.title, v_when, v_reason);
    v_owner_message := format(
      '%s is no longer available for your event %s "%s". Your event is not cancelled; your coordinator will contact you about an alternative venue.',
      v_venue.name, v_request_id, v_event.title);
  ELSE
    v_title := 'Venue booking rejected';
    v_coordinator_message := format(
      'Venue Staff rejected %s for event %s "%s" (%s). Reason: %s. The event stays in planning; choose an alternative venue.',
      v_booking_name, v_request_id, v_event.title, v_when, v_reason);
    v_owner_message := format(
      '%s could not be booked for your event %s "%s". Your coordinator will arrange an alternative venue.',
      v_venue.name, v_request_id, v_event.title);
  END IF;

  PERFORM public._notify_event_users(
    v_event.event_id, v_title, v_coordinator_message, ARRAY[v_event.coordinator_id],
    'BOOKING_UPDATE', format('VENUE_BOOKING_%s:%s:%s:COORDINATOR', v_status, v_booking.booking_id, v_previous), NULL
  );
  PERFORM public._notify_event_users(
    v_event.event_id, v_title, v_owner_message, ARRAY[v_event.organiser_id],
    'BOOKING_UPDATE', format('VENUE_BOOKING_%s:%s:%s:OWNER', v_status, v_booking.booking_id, v_previous), NULL
  );

  RETURN jsonb_build_object(
    'bookingId', v_booking.booking_id,
    'eventId', v_event.event_id,
    'status', v_status,
    'previousStatus', v_previous
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_venue_status(
  p_actor_id integer,
  p_venue_id integer,
  p_expected_version integer,
  p_status text,
  p_reason text,
  p_confirm_upcoming boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_venue public.venue;
  v_previous public.venue;
  v_upcoming integer := 0;
  v_first_start timestamptz;
  v_reason text := CASE WHEN p_status = 'ACTIVE' THEN NULL ELSE nullif(btrim(p_reason), '') END;
  v_locked integer[] := ARRAY[]::integer[];
  v_events integer[] := ARRAY[]::integer[];
  v_affected jsonb := '[]'::jsonb;
  v_event record;
  v_status_label text := CASE p_status WHEN 'UNDER_MAINTENANCE' THEN 'under maintenance' ELSE 'inactive' END;
  v_staff integer[];
  v_request_id text;
BEGIN
  PERFORM public._require_venue_staff(p_actor_id);

  -- Lock order (Master 7): an operation that starts from a venue reads the
  -- affected events, locks them, then locks the venue and re-reads the set.
  IF p_status <> 'ACTIVE' THEN
    v_locked := public._venue_affected_event_ids(p_venue_id);
    PERFORM 1 FROM public.event WHERE event_id = ANY (v_locked) ORDER BY event_id FOR UPDATE;
  END IF;
  v_previous := public._lock_venue_for_change(p_venue_id, p_expected_version);

  IF p_status = v_previous.status AND v_reason IS NOT DISTINCT FROM v_previous.status_reason THEN
    RETURN jsonb_build_object('venue', to_jsonb(v_previous), 'changed', false, 'upcoming_bookings', 0,
                              'affected_events', '[]'::jsonb);
  END IF;

  IF p_status <> 'ACTIVE' THEN
    v_events := public._venue_affected_event_ids(p_venue_id);
    IF NOT (v_events <@ v_locked) THEN
      -- A booking was added while the events were being locked; the model retries.
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'VENUE_AFFECTED_EVENTS_CHANGED';
    END IF;
    SELECT count(*), min(b.start_datetime)
      INTO v_upcoming, v_first_start
      FROM public.venue_booking AS b
      JOIN public.room AS r ON r.room_id = b.room_id
     WHERE r.venue_id = p_venue_id
       AND b.event_id = ANY (v_events)
       AND b.status IN ('PENDING', 'APPROVED')
       AND b.end_datetime > now();
    v_affected := public._venue_affected_events(p_venue_id);
    IF v_upcoming > 0 AND NOT coalesce(p_confirm_upcoming, false) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'VENUE_HAS_UPCOMING_BOOKINGS',
        DETAIL = jsonb_build_object('upcomingBookings', v_upcoming, 'firstStart', v_first_start,
                                    'affectedEvents', v_affected)::text;
    END IF;
  END IF;

  UPDATE public.venue
     SET status = p_status,
         status_reason = v_reason,
         version = version + 1,
         updated_at = now(),
         updated_by = p_actor_id
   WHERE venue_id = p_venue_id
  RETURNING * INTO v_venue;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, changes, audience)
  VALUES (
    p_actor_id, 'venue', p_venue_id, 'VENUE_STATUS_CHANGED',
    'Venue status changed to ' || p_status
      || CASE WHEN v_upcoming > 0 THEN format(' with %s upcoming booking(s) kept', v_upcoming) ELSE '' END,
    jsonb_build_object(
      'status', jsonb_build_object('before', v_previous.status, 'after', v_venue.status),
      'statusReason', jsonb_build_object('before', v_previous.status_reason, 'after', v_venue.status_reason)
    ),
    'STAFF_ONLY'
  );

  -- Taken out of service with bookings still ahead (Master 5.4.4, T31): keep
  -- every booking and event, record the change and tell those affected.
  -- Moving between INACTIVE and UNDER_MAINTENANCE notified them already.
  IF p_status <> 'ACTIVE' AND v_previous.status = 'ACTIVE' AND v_upcoming > 0 THEN
    FOR v_event IN
      SELECT e.event_id, e.title, e.coordinator_id, e.organiser_id,
             min(b.start_datetime) AS first_start
        FROM public.event AS e
        JOIN public.venue_booking AS b ON b.event_id = e.event_id
        JOIN public.room AS r ON r.room_id = b.room_id
       WHERE e.event_id = ANY (v_events)
         AND r.venue_id = p_venue_id
         AND b.status IN ('PENDING', 'APPROVED')
         AND b.end_datetime > now()
       GROUP BY e.event_id, e.title, e.coordinator_id, e.organiser_id
       ORDER BY e.event_id
    LOOP
      v_request_id := 'REQ-' || lpad(v_event.event_id::text, 6, '0');
      PERFORM public._supersede_safety_review(
        v_event.event_id, p_actor_id, format('Venue %s is %s.', v_venue.name, v_status_label)
      );
      INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
      VALUES (
        p_actor_id, 'event', v_event.event_id, 'VENUE_UNAVAILABLE',
        format('%s became unavailable. The venue booking is kept and the coordinator will arrange an alternative venue.', v_venue.name),
        'VENUE_STAFF',
        jsonb_build_object('venueId', p_venue_id,
                           'venueStatus', jsonb_build_object('before', v_previous.status, 'after', v_venue.status)),
        'ORGANISER_SAFE'
      );
      PERFORM public._notify_event_users(
        v_event.event_id, 'Venue unavailable',
        format(
          '%s is now %s%s. Event %s "%s" has a booking there from %s. The booking and the event are kept; liaise with the organiser to arrange an alternative venue.',
          v_venue.name, v_status_label,
          CASE WHEN v_reason IS NULL THEN '' ELSE ' (' || v_reason || ')' END,
          v_request_id, v_event.title, public._venue_local_time(v_event.first_start)
        ),
        ARRAY[v_event.coordinator_id],
        'BOOKING_UPDATE',
        format('VENUE_UNAVAILABLE:%s:%s:%s:COORDINATOR', p_venue_id, v_venue.version, v_event.event_id),
        NULL
      );
      PERFORM public._notify_event_users(
        v_event.event_id, 'Venue unavailable',
        format(
          '%s is temporarily unavailable for your event %s "%s". Your event is not cancelled; your coordinator will contact you about an alternative venue.',
          v_venue.name, v_request_id, v_event.title
        ),
        ARRAY[v_event.organiser_id],
        'BOOKING_UPDATE',
        format('VENUE_UNAVAILABLE:%s:%s:%s:OWNER', p_venue_id, v_venue.version, v_event.event_id),
        NULL
      );
    END LOOP;

    SELECT array_agg(user_id ORDER BY user_id) INTO v_staff
      FROM public."user"
     WHERE role = 'VENUE_STAFF' AND is_active AND user_id <> p_actor_id;
    PERFORM public._notify_event_users(
      NULL, 'Venue unavailable',
      format('%s was marked %s with %s upcoming booking(s) for %s event(s). The coordinators have been notified.',
             v_venue.name, v_status_label, v_upcoming, cardinality(v_events)),
      v_staff,
      'BOOKING_UPDATE',
      format('VENUE_UNAVAILABLE:%s:%s:STAFF', p_venue_id, v_venue.version),
      NULL
    );
  END IF;

  RETURN jsonb_build_object('venue', to_jsonb(v_venue), 'changed', true, 'upcoming_bookings', v_upcoming,
                            'affected_events', v_affected);
END;
$$;

REVOKE ALL ON FUNCTION public._venue_affected_event_ids(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._venue_affected_events(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._venue_local_time(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.decide_venue_booking(integer, integer, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_venue_status(integer, integer, integer, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_venue_booking(integer, integer, text, text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_venue_status(integer, integer, integer, text, text, boolean) TO service_role;
