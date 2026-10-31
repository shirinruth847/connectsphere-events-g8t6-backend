-- SPM-186: an approval re-checks holds and blocks under the venue lock
-- (Master 7.4, T33), like a booking request. The backend opens a transaction on
-- the venue lock connection (role venue_calendar_writer), calls
-- begin_venue_booking_decision to lock the event and then the venue (Master 7
-- lock order), reads the venue's setup/turnaround minutes and its holds and
-- blocks from MongoDB while those locks are held, and then calls
-- decide_venue_booking in the same transaction. decide_venue_booking takes the
-- same locks again, which the transaction already holds.
-- No table changes. The least-privilege role gains EXECUTE on these two
-- functions only; both run as their owner (SECURITY DEFINER).
-- Applied to the development project on 2026-10-30 as version 20261030070850.

CREATE OR REPLACE FUNCTION public.begin_venue_booking_decision(
  p_actor_id integer,
  p_booking_id integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_booking record;
BEGIN
  IF p_actor_id IS NULL OR p_booking_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'BOOKING_NOT_FOUND';
  END IF;
  PERFORM public._require_venue_staff(p_actor_id);

  SELECT b.booking_id,
         b.event_id,
         COALESCE(b.venue_id, r.venue_id) AS venue_id,
         b.status::text AS status,
         b.start_datetime,
         b.end_datetime
    INTO v_booking
    FROM public.venue_booking b
    LEFT JOIN public.room r ON r.room_id = b.room_id
   WHERE b.booking_id = p_booking_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'BOOKING_NOT_FOUND';
  END IF;

  -- Events, then venues (Master 7).
  PERFORM 1 FROM public.event WHERE event_id = v_booking.event_id FOR UPDATE;
  PERFORM 1 FROM public.venue WHERE venue_id = v_booking.venue_id FOR UPDATE;

  RETURN jsonb_build_object(
    'bookingId', v_booking.booking_id,
    'eventId', v_booking.event_id,
    'venueId', v_booking.venue_id,
    'status', v_booking.status,
    'start', v_booking.start_datetime,
    'end', v_booking.end_datetime
  );
END;
$$;

REVOKE ALL ON FUNCTION public.begin_venue_booking_decision(integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_venue_booking_decision(integer, integer) TO venue_calendar_writer;
GRANT EXECUTE ON FUNCTION public.decide_venue_booking(integer, integer, text, text, text, integer, integer) TO venue_calendar_writer;
