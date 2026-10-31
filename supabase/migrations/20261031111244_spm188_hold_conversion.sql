-- SPM-188 AC9/AC10: the coordinator confirms an active tentative hold, which
-- submits it as a booking request (Master 5.4.3). The booking is created by
-- request_venue_bookings in the same venue lock transaction; this function
-- then links the booking to the hold it came from and records the conversion.
-- The backend marks the MongoDB hold CONVERTED before COMMIT, only while it is
-- still active and unexpired, so a conversion and the hold's expiry can never
-- both happen.
--
-- venue_booking.calendar_hold_id is the converted hold's MongoDB ID (Master
-- 6.2); it is unique, so one hold becomes at most one booking.

ALTER TABLE public.venue_booking
  ADD COLUMN IF NOT EXISTS calendar_hold_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.venue_booking'::regclass AND conname = 'venue_booking_calendar_hold_id_check'
  ) THEN
    ALTER TABLE public.venue_booking
      ADD CONSTRAINT venue_booking_calendar_hold_id_check CHECK (calendar_hold_id IS NULL OR calendar_hold_id ~ '^[0-9a-f]{24}$');
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS venue_booking_calendar_hold_id_key
  ON public.venue_booking (calendar_hold_id)
  WHERE calendar_hold_id IS NOT NULL;

-- Runs after request_venue_bookings, which has locked the event and the venue
-- and created the PENDING booking. Only the assigned coordinator converts their
-- event's placed hold, into a booking at the same venue for the same window.
CREATE OR REPLACE FUNCTION public.record_venue_hold_conversion(
  p_actor_id integer,
  p_event_id integer,
  p_booking_id integer,
  p_hold_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_request public.venue_hold_request;
  v_booking public.venue_booking;
  v_venue_name text;
BEGIN
  IF p_actor_id IS NULL OR p_event_id IS NULL OR p_booking_id IS NULL
     OR p_hold_id IS NULL OR p_hold_id !~ '^[0-9a-f]{24}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_HOLD';
  END IF;

  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  IF v_event.coordinator_id IS DISTINCT FROM p_actor_id OR NOT EXISTS (
    SELECT 1 FROM public."user" WHERE user_id = p_actor_id AND role::text = 'COORDINATOR' AND is_active
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FORBIDDEN';
  END IF;

  SELECT * INTO v_request
    FROM public.venue_hold_request
   WHERE calendar_hold_id = p_hold_id AND event_id = p_event_id AND status = 'PLACED'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'HOLD_NOT_FOUND';
  END IF;

  SELECT * INTO v_booking
    FROM public.venue_booking
   WHERE booking_id = p_booking_id AND event_id = p_event_id
   FOR UPDATE;
  IF NOT FOUND OR v_booking.status::text <> 'PENDING' OR v_booking.venue_id IS DISTINCT FROM v_request.venue_id
     OR v_booking.start_datetime <> v_request.start_datetime OR v_booking.end_datetime <> v_request.end_datetime THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'HOLD_WINDOW_CHANGED';
  END IF;

  IF v_booking.label <> v_request.label
     OR (v_request.expected_attendance IS NOT NULL AND v_booking.expected_attendance <> v_request.expected_attendance) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'HOLD_DETAILS_CHANGED';
  END IF;

  BEGIN
    UPDATE public.venue_booking SET calendar_hold_id = p_hold_id WHERE booking_id = p_booking_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'HOLD_ALREADY_CONVERTED';
  END;

  SELECT name INTO v_venue_name FROM public.venue WHERE venue_id = v_request.venue_id;
  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (p_actor_id, 'event', p_event_id, 'VENUE_HOLD_CONVERTED',
          format('The hold on %s was confirmed as Booking #%s.', v_venue_name, p_booking_id), 'COORDINATOR',
          jsonb_build_object('venueHold', jsonb_build_object('before', 'On hold', 'after', format('Booking #%s requested', p_booking_id))),
          'STAFF_ONLY');

  RETURN jsonb_build_object('holdId', p_hold_id, 'bookingId', p_booking_id, 'holdRequestId', v_request.hold_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.record_venue_hold_conversion(integer, integer, integer, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_venue_hold_conversion(integer, integer, integer, text) TO venue_calendar_writer;
