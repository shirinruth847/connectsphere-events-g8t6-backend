-- Corrective SPM-190 migration: existing applied migrations stay intact.
-- Apply in one transaction before deploying the backend/job. Adds workflow
-- claims only; retains all requests, calendar documents, history and notices.

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

CREATE OR REPLACE FUNCTION public.begin_venue_hold_change(
  p_actor_id integer,
  p_event_id integer,
  p_venue_id integer,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_role text;
BEGIN
  IF p_actor_id IS NULL OR p_event_id IS NULL OR p_venue_id IS NULL OR p_action NOT IN ('EXTEND', 'RELEASE') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_HOLD';
  END IF;
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'HOLD_NOT_FOUND';
  END IF;
  SELECT role::text INTO v_role FROM public."user" WHERE user_id = p_actor_id AND is_active;
  IF v_role = 'VENUE_STAFF' THEN
    NULL;
  ELSIF p_action = 'RELEASE' AND v_role = 'COORDINATOR' AND v_event.coordinator_id = p_actor_id THEN
    NULL;
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FORBIDDEN';
  END IF;
  PERFORM 1 FROM public.venue WHERE venue_id = p_venue_id FOR UPDATE;
  RETURN jsonb_build_object('role', v_role, 'serverNow', clock_timestamp());
END;
$$;

-- Durable claims share the transaction containing notifications and history.
-- A crash before COMMIT rolls the claim back; a lost COMMIT response is safe
-- to replay. Row/venue locks serialize processing with extension and release.
CREATE TABLE public.venue_hold_notice_claim (
  hold_id text NOT NULL CHECK (hold_id ~ '^[0-9a-f]{24}$'),
  event_id integer NOT NULL REFERENCES public.event(event_id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('EXPIRING', 'EXPIRED')),
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (hold_id, expires_at, kind)
);
CREATE INDEX venue_hold_notice_claim_event ON public.venue_hold_notice_claim(event_id);
ALTER TABLE public.venue_hold_notice_claim ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.venue_hold_notice_claim FROM PUBLIC, anon, authenticated, service_role, venue_calendar_writer;

CREATE FUNCTION public.venue_hold_clock()
RETURNS timestamptz LANGUAGE sql VOLATILE
SET search_path = pg_catalog, public
AS $$ SELECT clock_timestamp() $$;
REVOKE ALL ON FUNCTION public.venue_hold_clock() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venue_hold_clock() TO service_role;

CREATE FUNCTION public.begin_venue_hold_expiry(p_event_id integer, p_venue_id integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1 FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.venue WHERE venue_id = p_venue_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('serverNow', clock_timestamp());
END;
$$;
REVOKE ALL ON FUNCTION public.begin_venue_hold_expiry(integer,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_venue_hold_expiry(integer,integer) TO venue_calendar_writer;

-- Caller has re-read the MongoDB hold under the event/venue locks. This
-- function checks database time again and atomically claims and records work.
CREATE FUNCTION public.record_venue_hold_expiry(
  p_kind text, p_event_id integer, p_hold_id text, p_venue_id integer, p_expires_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('EXPIRING','EXPIRED') OR p_expires_at IS NULL
     OR p_hold_id IS NULL OR p_hold_id !~ '^[0-9a-f]{24}$' THEN
    RAISE EXCEPTION 'INVALID_HOLD';
  END IF;
  IF (p_kind = 'EXPIRED' AND p_expires_at > v_now)
     OR (p_kind = 'EXPIRING' AND (p_expires_at <= v_now OR p_expires_at > v_now + interval '24 hours')) THEN
    RETURN false;
  END IF;
  INSERT INTO public.venue_hold_notice_claim(hold_id, event_id, expires_at, kind)
    VALUES(p_hold_id, p_event_id, p_expires_at, p_kind) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.notify_venue_hold_expiry(p_kind, p_event_id, p_hold_id, p_venue_id, p_expires_at);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.record_venue_hold_expiry(text,integer,text,integer,timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_venue_hold_expiry(text,integer,text,integer,timestamptz) TO venue_calendar_writer;
