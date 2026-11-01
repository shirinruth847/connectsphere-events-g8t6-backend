-- SPM-190 (developer decision of 1 November 2026, Master 5.4.3): the booking
-- request is the venue hold.
--
--   * A new PENDING request gets hold_expires_at: 7 days after it is sent, or
--     24 hours before its occupied range starts, whichever is earlier; when
--     the range starts within 24 hours, the hold lasts until the range starts.
--   * Approval clears the expiry (an approved booking does not expire).
--   * expire_overdue_venue_bookings marks overdue PENDING requests EXPIRED,
--     which frees the venue (the no-overlap constraint covers only PENDING and
--     APPROVED), records it and tells the coordinator. The booking request
--     path calls it under the venue lock before saving, so an overdue request
--     never blocks a new one; the hold expiry job calls it for every venue.
--   * remind_expiring_venue_bookings tells the coordinator and Venue Staff
--     24 hours before a request's hold expires (Week 7 change 4).
--
-- Existing PENDING requests get an expiry counted from now. Nothing is
-- deleted; existing MongoDB holds keep expiring as before.

CREATE OR REPLACE FUNCTION public._venue_booking_hold_expiry(
  p_sent_at timestamptz,
  p_occupied_start timestamptz
)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_occupied_start - interval '24 hours' > p_sent_at
      THEN least(p_sent_at + interval '7 days', p_occupied_start - interval '24 hours')
    ELSE p_occupied_start
  END;
$$;

CREATE OR REPLACE FUNCTION public._set_venue_booking_hold_expiry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text = 'PENDING' AND NEW.hold_expires_at IS NULL THEN
      NEW.hold_expires_at := public._venue_booking_hold_expiry(
        clock_timestamp(), COALESCE(lower(NEW.occupied_range), NEW.start_datetime));
    END IF;
  ELSIF NEW.status::text = 'APPROVED' AND OLD.status::text <> 'APPROVED' THEN
    NEW.hold_expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS venue_booking_hold_expiry ON public.venue_booking;
CREATE TRIGGER venue_booking_hold_expiry
  BEFORE INSERT OR UPDATE OF status ON public.venue_booking
  FOR EACH ROW EXECUTE FUNCTION public._set_venue_booking_hold_expiry();

UPDATE public.venue_booking
   SET hold_expires_at = public._venue_booking_hold_expiry(now(), COALESCE(lower(occupied_range), start_datetime))
 WHERE status::text = 'PENDING' AND hold_expires_at IS NULL;

-- Marks overdue PENDING requests EXPIRED (all venues when p_venue_ids is
-- NULL) and returns how many. Rows another transaction has locked are left for
-- the next run; the request path holds the venue lock, so no decision on its
-- venues can be running.
CREATE OR REPLACE FUNCTION public.expire_overdue_venue_bookings(
  p_venue_ids integer[] DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row record;
  v_event public.event;
  v_count integer := 0;
BEGIN
  FOR v_row IN
    SELECT b.booking_id, b.event_id, b.hold_expires_at, v.name AS venue_name
      FROM public.venue_booking b
      JOIN public.venue v ON v.venue_id = b.venue_id
     WHERE b.status::text = 'PENDING'
       AND b.hold_expires_at <= clock_timestamp()
       AND (p_venue_ids IS NULL OR b.venue_id = ANY (p_venue_ids))
     ORDER BY b.hold_expires_at, b.booking_id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
     FOR UPDATE OF b SKIP LOCKED
  LOOP
    UPDATE public.venue_booking
       SET status = 'EXPIRED', updated_at = now()
     WHERE booking_id = v_row.booking_id;
    v_count := v_count + 1;

    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
    VALUES (NULL, 'event', v_row.event_id, 'VENUE_BOOKING_EXPIRED',
            format('Booking #%s for %s expired before Venue Staff decided it; the venue is free again.', v_row.booking_id, v_row.venue_name),
            'SYSTEM',
            jsonb_build_object('venueBooking', jsonb_build_object('before', 'Pending', 'after', 'Expired')),
            'STAFF_ONLY');

    SELECT * INTO v_event FROM public.event WHERE event_id = v_row.event_id;
    IF FOUND AND v_event.status::text NOT IN ('DRAFT', 'COMPLETED', 'CANCELLED', 'REJECTED') THEN
      PERFORM public._notify_event_users(
        v_row.event_id, 'Venue request expired',
        format('Venue Staff did not decide booking #%s for %s (REQ-%s "%s") by %s, so the venue is free again. Send a new request if you still need it.',
               v_row.booking_id, v_row.venue_name, lpad(v_row.event_id::text, 6, '0'), v_event.title,
               public._venue_local_time(v_row.hold_expires_at)),
        public._event_coordinator_recipients(v_event), 'BOOKING_UPDATE',
        format('BOOKING_HOLD_EXPIRED:%s', v_row.booking_id), NULL);
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Whether a pending request's hold has passed, by database time. Approval runs
-- on the venue lock connection, whose role reads no tables directly.
CREATE OR REPLACE FUNCTION public.venue_booking_hold_expired(p_booking_id integer)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    (SELECT status::text = 'PENDING' AND hold_expires_at <= clock_timestamp()
       FROM public.venue_booking WHERE booking_id = p_booking_id),
    false);
$$;

-- The 24-hour reminder, once per request: to the coordinator, and to Venue
-- Staff so they decide before the venue is released.
CREATE OR REPLACE FUNCTION public.remind_expiring_venue_bookings(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row record;
  v_event public.event;
  v_count integer := 0;
BEGIN
  FOR v_row IN
    SELECT b.booking_id, b.event_id, b.hold_expires_at, v.name AS venue_name
      FROM public.venue_booking b
      JOIN public.venue v ON v.venue_id = b.venue_id
     WHERE b.status::text = 'PENDING'
       AND b.hold_reminded_at IS NULL
       AND b.hold_expires_at > clock_timestamp()
       AND b.hold_expires_at <= clock_timestamp() + interval '24 hours'
     ORDER BY b.hold_expires_at, b.booking_id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
     FOR UPDATE OF b SKIP LOCKED
  LOOP
    UPDATE public.venue_booking SET hold_reminded_at = clock_timestamp() WHERE booking_id = v_row.booking_id;
    SELECT * INTO v_event FROM public.event WHERE event_id = v_row.event_id;
    IF NOT FOUND OR v_event.status::text IN ('DRAFT', 'COMPLETED', 'CANCELLED', 'REJECTED') THEN
      CONTINUE;
    END IF;
    PERFORM public._notify_event_users(
      v_row.event_id, 'Venue request awaiting decision',
      format('Booking #%s for %s (REQ-%s "%s") is still waiting for Venue Staff. If it is not decided by %s, the venue is released.',
             v_row.booking_id, v_row.venue_name, lpad(v_row.event_id::text, 6, '0'), v_event.title,
             public._venue_local_time(v_row.hold_expires_at)),
      public._event_coordinator_recipients(v_event), 'BOOKING_UPDATE',
      format('BOOKING_HOLD_EXPIRING:%s', v_row.booking_id), NULL);
    PERFORM public._notify_event_users(
      v_row.event_id, 'Venue request needs a decision',
      format('Booking #%s for %s (REQ-%s "%s") needs your decision by %s; after that the venue is released.',
             v_row.booking_id, v_row.venue_name, lpad(v_row.event_id::text, 6, '0'), v_event.title,
             public._venue_local_time(v_row.hold_expires_at)),
      public._venue_staff_recipients(NULL), 'BOOKING_UPDATE',
      format('BOOKING_HOLD_EXPIRING:%s:VENUE_STAFF', v_row.booking_id), NULL);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public._venue_booking_hold_expiry(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._set_venue_booking_hold_expiry() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_overdue_venue_bookings(integer[], integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remind_expiring_venue_bookings(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.venue_booking_hold_expired(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.expire_overdue_venue_bookings(integer[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.remind_expiring_venue_bookings(integer) TO service_role;
-- The booking request path runs on the venue lock connection (Master 7.4).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'venue_calendar_writer') THEN
    GRANT EXECUTE ON FUNCTION public.expire_overdue_venue_bookings(integer[], integer) TO venue_calendar_writer;
    GRANT EXECUTE ON FUNCTION public.venue_booking_hold_expired(integer) TO venue_calendar_writer;
  END IF;
END;
$$;
