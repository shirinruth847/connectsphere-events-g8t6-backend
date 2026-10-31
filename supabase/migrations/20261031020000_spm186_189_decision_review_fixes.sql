-- SPM-186/189 review fixes. Corrective migration; applied migrations stay intact.
-- 1. All active bookings block approval, using stored ranges with a legacy
--    fallback. NULL occupied ranges must not bypass the business recheck.
-- 2. Withdrawing an approved booking returns confirmed/preparing events to
--    PLANNING (current SPM-189 AC9), through the shared guarded transition.
-- Every existing transition row is retained. Review this additive lifecycle
-- action with the shared-lifecycle owners before deployment.
-- Registration rows, event details, other bookings and previously_confirmed
-- are preserved. Arrangement version bumps once; safety review supersession,
-- transition history, booking history and notifications are one transaction.
-- CREATE OR REPLACE retains existing execution grants.

-- Fail atomically instead of overwriting lifecycle rows added by another
-- branch since this baseline. Apply this file in one migration transaction.
CREATE TEMP TABLE spm186_189_transition_baseline AS SELECT * FROM public._lifecycle_transitions();

CREATE OR REPLACE FUNCTION public._lifecycle_transitions()
RETURNS TABLE (
  action text,
  from_states text[],
  to_state text,
  actor_role text,
  relationship text,
  allows_system boolean,
  activity_action text,
  audience text
)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  VALUES
    ('submit', ARRAY['DRAFT'], 'SUBMITTED', 'ORGANISER', 'OWNER', false, 'EVENT_SUBMITTED', 'ORGANISER_SAFE'),
    ('withdraw', ARRAY['SUBMITTED'], 'CANCELLED', 'ORGANISER', 'OWNER', false, 'EVENT_WITHDRAWN', 'ORGANISER_SAFE'),
    ('assign', ARRAY['SUBMITTED'], 'UNDER_REVIEW', 'COORDINATOR_LEAD', 'LEAD', false, 'COORDINATOR_ASSIGNED', 'STAFF_ONLY'),
    ('request_clarification', ARRAY['UNDER_REVIEW'], 'AWAITING_CLARIFICATION', 'COORDINATOR', 'ASSIGNED', false, 'CLARIFICATION_REQUESTED', 'ORGANISER_SAFE'),
    ('resubmit', ARRAY['AWAITING_CLARIFICATION'], 'UNDER_REVIEW', 'ORGANISER', 'OWNER', false, 'EVENT_RESUBMITTED', 'ORGANISER_SAFE'),
    ('complete_clarification', ARRAY['AWAITING_CLARIFICATION'], 'UNDER_REVIEW', 'COORDINATOR', 'ASSIGNED', false, 'CLARIFICATION_COMPLETED', 'ORGANISER_SAFE'),
    ('accept_feasibility', ARRAY['UNDER_REVIEW'], 'PLANNING', 'COORDINATOR', 'ASSIGNED', false, 'FEASIBILITY_ACCEPTED', 'ORGANISER_SAFE'),
    ('submit_for_safety_review', ARRAY['PLANNING'], 'SAFETY_REVIEW', 'COORDINATOR', 'ASSIGNED', false, 'SAFETY_REVIEW_SUBMITTED', 'STAFF_ONLY'),
    ('safety_changes_requested', ARRAY['SAFETY_REVIEW'], 'PLANNING', 'SAFETY_OFFICER', 'CLAIMANT', false, 'SAFETY_CHANGES_REQUESTED', 'ORGANISER_SAFE'),
    ('safety_rejected', ARRAY['SAFETY_REVIEW'], 'PLANNING', 'SAFETY_OFFICER', 'CLAIMANT', false, 'SAFETY_VENUES_REJECTED', 'ORGANISER_SAFE'),
    ('safety_superseded', ARRAY['SAFETY_REVIEW'], 'PLANNING', NULL, 'ANY', true, 'SAFETY_REVIEW_SUPERSEDED', 'STAFF_ONLY'),
    ('confirm', ARRAY['SAFETY_REVIEW'], 'CONFIRMED', 'COORDINATOR', 'ASSIGNED', false, 'EVENT_CONFIRMED', 'ORGANISER_SAFE'),
    ('start_preparation', ARRAY['CONFIRMED'], 'PREPARATION', 'COORDINATOR', 'ASSIGNED', false, 'PREPARATION_STARTED', 'STAFF_ONLY'),
    ('complete', ARRAY['CONFIRMED', 'PREPARATION'], 'COMPLETED', 'COORDINATOR', 'ASSIGNED', true, 'EVENT_COMPLETED', 'ORGANISER_SAFE'),
    ('reject', ARRAY['UNDER_REVIEW', 'AWAITING_CLARIFICATION', 'PLANNING', 'SAFETY_REVIEW'], 'REJECTED', 'COORDINATOR', 'ASSIGNED', false, 'EVENT_REJECTED', 'ORGANISER_SAFE'),
    ('accept_change', ARRAY['PLANNING', 'SAFETY_REVIEW', 'CONFIRMED', 'PREPARATION'], 'PLANNING', 'COORDINATOR', 'ASSIGNED', false, 'CHANGE_ACCEPTED', 'ORGANISER_SAFE'),
    ('cancel', ARRAY['UNDER_REVIEW', 'AWAITING_CLARIFICATION', 'PLANNING', 'SAFETY_REVIEW', 'CONFIRMED', 'PREPARATION'], 'CANCELLED', 'COORDINATOR', 'ASSIGNED', false, 'EVENT_CANCELLED', 'ORGANISER_SAFE'),
    ('venue_replacement', ARRAY['SAFETY_REVIEW', 'CONFIRMED', 'PREPARATION'], 'PLANNING', 'COORDINATOR', 'ASSIGNED', false, 'VENUE_REPLACEMENT_RAISED', 'ORGANISER_SAFE'),
    ('venue_approval_withdrawn', ARRAY['CONFIRMED', 'PREPARATION'], 'PLANNING', 'VENUE_STAFF', 'ANY', false, 'VENUE_APPROVAL_WITHDRAWN', 'ORGANISER_SAFE')
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT * FROM spm186_189_transition_baseline
    EXCEPT SELECT * FROM public._lifecycle_transitions()
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BASELINE_CHANGED: reconcile newer lifecycle rows before applying SPM-186/189';
  END IF;
END;
$$;
DROP TABLE spm186_189_transition_baseline;

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
         AND other.status IN ('PENDING', 'APPROVED')
         AND COALESCE(other.occupied_range,
               tstzrange(other.start_datetime - make_interval(mins => p_setup_minutes),
                         other.end_datetime + make_interval(mins => p_turnaround_minutes), '[)'))
          && COALESCE(v_booking.occupied_range,
               tstzrange(v_booking.start_datetime - make_interval(mins => p_setup_minutes),
                         v_booking.end_datetime + make_interval(mins => p_turnaround_minutes), '[)'))
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

  -- SPM-189 AC9: a withdrawn approval needs replanning even when the
  -- event was already confirmed/preparing. SAFETY_REVIEW was handled above
  -- by supersession. Keep all registration rows and previously_confirmed.
  IF v_status = 'REJECTED' AND v_previous = 'APPROVED'
     AND v_event.status::text IN ('CONFIRMED', 'PREPARATION') THEN
    PERFORM public._check_event_transition(v_event, 'venue_approval_withdrawn', p_actor_id, NULL);
    v_event := public._apply_event_transition(
      v_event, 'venue_approval_withdrawn', p_actor_id,
      format('Approval of %s was withdrawn; the event returns to planning.', v_booking_name)
    );
  END IF;

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
