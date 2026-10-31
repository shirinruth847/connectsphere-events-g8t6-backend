-- SPM-190: tentative venue holds (Master 5.4.3, 6.2, 7, 7.1, 7.4, 8; T27, T33,
-- T34). The assigned coordinator requests a hold on a venue for a window of an
-- event in PLANNING; Venue Staff place it (or decline with a reason). A hold is
-- a HOLD document in MongoDB venue_calendar; this table records the request
-- and its outcome, which is PostgreSQL workflow state.
--
-- Placing, extending and releasing a hold are venue calendar writes, so each
-- runs on the venue lock connection (role venue_calendar_writer):
--   BEGIN;
--   begin_venue_hold_placement / begin_venue_hold_change
--       -- role and state checks, idempotency claim (placement), event lock,
--       -- then venue lock (Master 7), and the active bookings that overlap
--   (backend reads the venue's holds and blocks from MongoDB under the lock,
--    computes the expiry, and refuses any overlap)
--   record_venue_hold_placement / record_venue_hold_change
--       -- request outcome, activity and notices
--   (backend writes the HOLD document in MongoDB)
--   COMMIT;          -- only if the MongoDB write succeeded
-- Requests, withdrawals, declines and expiry notices change no calendar, so
-- they run on the backend's normal connection (service_role).
--
-- Business errors are P0001/P0002 with a stable MESSAGE.
-- Applied to the development project on 2026-10-30 as version 20261030143144.

-- ---------- hold requests ----------

CREATE TABLE IF NOT EXISTS public.venue_hold_request (
  hold_request_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id integer NOT NULL REFERENCES public.event (event_id) ON DELETE RESTRICT,
  venue_id integer NOT NULL REFERENCES public.venue (venue_id) ON DELETE RESTRICT,
  label varchar(100) NOT NULL,
  start_datetime timestamptz NOT NULL,
  end_datetime timestamptz NOT NULL,
  expected_attendance integer,
  note text,
  status text NOT NULL DEFAULT 'PENDING',
  requested_by integer NOT NULL REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by integer REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  decided_at timestamptz,
  decline_reason text,
  calendar_hold_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venue_hold_request_status_check CHECK (status IN ('PENDING', 'PLACED', 'DECLINED', 'WITHDRAWN')),
  CONSTRAINT venue_hold_request_window_check CHECK (end_datetime > start_datetime),
  CONSTRAINT venue_hold_request_label_check CHECK (btrim(label) <> ''),
  CONSTRAINT venue_hold_request_attendance_check CHECK (expected_attendance IS NULL OR expected_attendance > 0),
  CONSTRAINT venue_hold_request_note_check CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT venue_hold_request_decided_check CHECK ((status = 'PENDING') = (decided_at IS NULL)),
  CONSTRAINT venue_hold_request_decline_check CHECK (
    status <> 'DECLINED' OR (decline_reason IS NOT NULL AND btrim(decline_reason) <> '' AND char_length(decline_reason) <= 1000)
  ),
  CONSTRAINT venue_hold_request_placed_check CHECK (
    (status = 'PLACED') = (calendar_hold_id IS NOT NULL) AND (calendar_hold_id IS NULL OR calendar_hold_id ~ '^[0-9a-f]{24}$')
  )
);

-- At most one open request per event and venue; one request per placed hold.
CREATE UNIQUE INDEX IF NOT EXISTS venue_hold_request_one_pending
  ON public.venue_hold_request (event_id, venue_id) WHERE status = 'PENDING';
CREATE UNIQUE INDEX IF NOT EXISTS venue_hold_request_hold_unique
  ON public.venue_hold_request (calendar_hold_id) WHERE calendar_hold_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS venue_hold_request_status_requested
  ON public.venue_hold_request (status, requested_at);
CREATE INDEX IF NOT EXISTS venue_hold_request_event
  ON public.venue_hold_request (event_id);

ALTER TABLE public.venue_hold_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.venue_hold_request FROM PUBLIC, anon, authenticated;
-- The backend reads through the service role; every write goes through the
-- functions below.
GRANT SELECT ON public.venue_hold_request TO service_role;

-- Allow the two idempotent operations, preserving operations added by other
-- branches (same pattern as 20261029140000_spm195_venue_blocks).
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
    v_existing_check, 'event.request_venue_hold', 'venue.place_hold'
  );
END;
$idempotency_operations$;

-- The request with its event, locked: event first (Master 7). "Not found" for a
-- missing request, so other events' requests are not confirmed to exist.
CREATE OR REPLACE FUNCTION public._lock_venue_hold_request(p_request_id integer)
RETURNS public.venue_hold_request
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event_id integer;
  v_request public.venue_hold_request;
BEGIN
  SELECT event_id INTO v_event_id FROM public.venue_hold_request WHERE hold_request_id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'HOLD_REQUEST_NOT_FOUND';
  END IF;
  PERFORM 1 FROM public.event WHERE event_id = v_event_id FOR UPDATE;
  SELECT * INTO v_request FROM public.venue_hold_request WHERE hold_request_id = p_request_id FOR UPDATE;
  RETURN v_request;
END;
$$;

CREATE OR REPLACE FUNCTION public._venue_staff_recipients(p_except integer)
RETURNS integer[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(array_agg(user_id ORDER BY user_id), ARRAY[]::integer[])
    FROM public."user"
   WHERE role = 'VENUE_STAFF' AND is_active AND user_id IS DISTINCT FROM p_except;
$$;

-- POST /api/events/:id/venue-holds/requests (SPM-190 AC1): the assigned
-- coordinator asks for a hold on one venue for a window inside the event.
CREATE OR REPLACE FUNCTION public.request_venue_hold(
  p_actor_id integer,
  p_event_id integer,
  p_venue_id integer,
  p_label text,
  p_start timestamptz,
  p_end timestamptz,
  p_expected_attendance integer,
  p_note text,
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
  v_replay jsonb;
  v_request public.venue_hold_request;
  v_request_id text := 'REQ-' || lpad(p_event_id::text, 6, '0');
  v_response jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_event_id IS NULL OR p_venue_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start
     OR p_label IS NULL OR btrim(p_label) = '' OR char_length(p_label) > 100
     OR (p_expected_attendance IS NOT NULL AND p_expected_attendance < 1)
     OR (p_note IS NOT NULL AND char_length(p_note) > 500) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_HOLD_REQUEST';
  END IF;
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id AND status::text <> 'DRAFT' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  PERFORM public._require_booking_coordinator(p_actor_id, v_event);

  v_replay := public._claim_idempotency_key(p_actor_id, 'event.request_venue_hold', p_idempotency_key, p_request_hash);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;

  -- New holds only while the event is in PLANNING (Master 5.2, 5.4.3).
  IF v_event.status::text <> 'PLANNING' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_IN_PLANNING';
  END IF;
  IF p_start < v_event.start_datetime OR p_end > v_event.end_datetime THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'HOLD_OUTSIDE_EVENT';
  END IF;
  IF p_start <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'HOLD_TOO_LATE';
  END IF;

  SELECT * INTO v_venue FROM public.venue WHERE venue_id = p_venue_id;
  IF NOT FOUND OR NOT v_venue.is_active THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'VENUE_NOT_FOUND';
  END IF;
  IF v_venue.status <> 'ACTIVE' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_NOT_BOOKABLE';
  END IF;

  BEGIN
    INSERT INTO public.venue_hold_request (
      event_id, venue_id, label, start_datetime, end_datetime, expected_attendance, note, requested_by
    ) VALUES (
      p_event_id, p_venue_id, btrim(p_label), p_start, p_end, p_expected_attendance, NULLIF(btrim(p_note), ''), p_actor_id
    ) RETURNING * INTO v_request;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'HOLD_REQUEST_EXISTS';
  END;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', p_event_id, 'VENUE_HOLD_REQUESTED',
    format('Hold requested on %s for %s to %s.', v_venue.name,
           public._venue_local_time(p_start), public._venue_local_time(p_end)),
    'COORDINATOR',
    jsonb_build_object('venueHold', jsonb_build_object(
      'before', NULL,
      'after', format('%s requested, %s to %s', v_venue.name, public._venue_local_time(p_start), public._venue_local_time(p_end))
    )),
    'STAFF_ONLY'
  );

  PERFORM public._notify_event_users(
    p_event_id,
    'Hold requested',
    format('The coordinator of %s "%s" asks for a tentative hold on %s from %s to %s.',
           v_request_id, v_event.title, v_venue.name, public._venue_local_time(p_start), public._venue_local_time(p_end)),
    public._venue_staff_recipients(NULL),
    'BOOKING_UPDATE',
    format('HOLD_REQUESTED:%s', v_request.hold_request_id),
    NULL
  );

  v_response := jsonb_build_object('holdRequestId', v_request.hold_request_id, 'status', v_request.status);
  RETURN public._store_idempotent_response(p_actor_id, 'event.request_venue_hold', p_idempotency_key, v_response);
END;
$$;

-- The coordinator withdraws a request Venue Staff have not acted on.
CREATE OR REPLACE FUNCTION public.withdraw_venue_hold_request(p_actor_id integer, p_request_id integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.venue_hold_request := public._lock_venue_hold_request(p_request_id);
  v_event public.event;
BEGIN
  SELECT * INTO v_event FROM public.event WHERE event_id = v_request.event_id;
  PERFORM public._require_booking_coordinator(p_actor_id, v_event);
  IF v_request.status <> 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'HOLD_REQUEST_DECIDED',
      DETAIL = jsonb_build_object('status', v_request.status)::text;
  END IF;

  UPDATE public.venue_hold_request
     SET status = 'WITHDRAWN', decided_by = p_actor_id, decided_at = now(), updated_at = now()
   WHERE hold_request_id = p_request_id;
  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (p_actor_id, 'event', v_request.event_id, 'VENUE_HOLD_REQUEST_WITHDRAWN',
          'Hold request withdrawn by the coordinator.', 'COORDINATOR',
          jsonb_build_object('venueHold', jsonb_build_object('before', 'Requested', 'after', 'Withdrawn')), 'STAFF_ONLY');
  RETURN jsonb_build_object('holdRequestId', p_request_id, 'status', 'WITHDRAWN');
END;
$$;

-- Venue Staff decline a request with a reason; the coordinator is told why.
CREATE OR REPLACE FUNCTION public.decline_venue_hold_request(p_actor_id integer, p_request_id integer, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.venue_hold_request;
  v_event public.event;
  v_venue_name text;
BEGIN
  PERFORM public._require_venue_staff(p_actor_id);
  IF p_reason IS NULL OR btrim(p_reason) = '' OR char_length(p_reason) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'DECLINE_REASON_INVALID';
  END IF;
  v_request := public._lock_venue_hold_request(p_request_id);
  IF v_request.status <> 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'HOLD_REQUEST_DECIDED',
      DETAIL = jsonb_build_object('status', v_request.status)::text;
  END IF;
  SELECT * INTO v_event FROM public.event WHERE event_id = v_request.event_id;
  SELECT name INTO v_venue_name FROM public.venue WHERE venue_id = v_request.venue_id;

  UPDATE public.venue_hold_request
     SET status = 'DECLINED', decided_by = p_actor_id, decided_at = now(), decline_reason = btrim(p_reason), updated_at = now()
   WHERE hold_request_id = p_request_id;
  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (p_actor_id, 'event', v_request.event_id, 'VENUE_HOLD_REQUEST_DECLINED',
          format('Hold request on %s declined: %s', v_venue_name, btrim(p_reason)), 'VENUE_STAFF',
          jsonb_build_object('venueHold', jsonb_build_object('before', 'Requested', 'after', 'Declined')), 'STAFF_ONLY');
  PERFORM public._notify_event_users(
    v_request.event_id,
    'Hold request declined',
    format('Venue Staff declined the hold on %s for REQ-%s "%s": %s',
           v_venue_name, lpad(v_request.event_id::text, 6, '0'), v_event.title, btrim(p_reason)),
    public._event_coordinator_recipients(v_event),
    'BOOKING_UPDATE',
    format('HOLD_REQUEST_DECLINED:%s', p_request_id),
    NULL
  );
  RETURN jsonb_build_object('holdRequestId', p_request_id, 'status', 'DECLINED');
END;
$$;

-- ---------- placing a hold (venue lock connection) ----------

-- Active bookings at the venue whose occupied range overlaps [p_start, p_end).
CREATE OR REPLACE FUNCTION public._venue_hold_booking_conflicts(p_venue_id integer, p_start timestamptz, p_end timestamptz, p_setup integer, p_turnaround integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'bookingId', affected.booking_id,
           'eventId', affected.event_id,
           'occupiedStart', lower(affected.occupied_range),
           'occupiedEnd', upper(affected.occupied_range)
         ) ORDER BY affected.booking_id), '[]'::jsonb)
    FROM public._venue_block_affected_bookings(p_venue_id, p_start, p_end, p_setup, p_turnaround) AS affected;
$$;

-- Step 1 of placing (AC1–AC3): Venue Staff, idempotency claim, then the event
-- and the venue locked in order, and the request, event and venue rechecked.
-- p_occupied_start/end come from the venue's set-once minutes (Master 5.4.1);
-- the response lists the active bookings that overlap them.
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

  RETURN jsonb_build_object(
    'replay', NULL,
    'request', jsonb_build_object(
      'holdRequestId', v_request.hold_request_id,
      'eventId', v_request.event_id,
      'venueId', v_request.venue_id,
      'label', v_request.label,
      'start', v_request.start_datetime,
      'end', v_request.end_datetime
    ),
    'bookingConflicts', public._venue_hold_booking_conflicts(v_request.venue_id, p_occupied_start, p_occupied_end, NULL, NULL)
  );
END;
$$;

-- Step 2 (AC4): under the same locks, the request is PLACED with the MongoDB
-- hold ID, and the history and the coordinator's notice are written.
-- p_hold: { holdId, occupiedStart, occupiedEnd, expiresAt }.
CREATE OR REPLACE FUNCTION public.record_venue_hold_placement(
  p_actor_id integer,
  p_request_id integer,
  p_hold jsonb,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.venue_hold_request;
  v_event public.event;
  v_venue public.venue;
  v_hold_id text := p_hold ->> 'holdId';
  v_expires timestamptz;
  v_response jsonb;
BEGIN
  PERFORM public._require_venue_staff(p_actor_id);
  BEGIN
    v_expires := (p_hold ->> 'expiresAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    v_expires := NULL;
  END;
  IF v_hold_id IS NULL OR v_hold_id !~ '^[0-9a-f]{24}$' OR v_expires IS NULL OR v_expires <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_HOLD';
  END IF;
  -- Already locked by begin_venue_hold_placement in this transaction.
  v_request := public._lock_venue_hold_request(p_request_id);
  IF v_request.status <> 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'HOLD_REQUEST_DECIDED',
      DETAIL = jsonb_build_object('status', v_request.status)::text;
  END IF;
  SELECT * INTO v_event FROM public.event WHERE event_id = v_request.event_id;
  SELECT * INTO v_venue FROM public.venue WHERE venue_id = v_request.venue_id;

  UPDATE public.venue_hold_request
     SET status = 'PLACED', decided_by = p_actor_id, decided_at = now(), calendar_hold_id = v_hold_id, updated_at = now()
   WHERE hold_request_id = p_request_id;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', v_request.event_id, 'VENUE_HOLD_PLACED',
    format('%s is on tentative hold from %s to %s until %s.', v_venue.name,
           public._venue_local_time(v_request.start_datetime), public._venue_local_time(v_request.end_datetime),
           public._venue_local_time(v_expires)),
    'VENUE_STAFF',
    jsonb_build_object('venueHold', jsonb_build_object('before', 'Requested', 'after', format('On hold until %s', public._venue_local_time(v_expires)))),
    'STAFF_ONLY'
  );
  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'venue', v_request.venue_id, 'VENUE_HOLD_PLACED',
    format('Tentative hold for REQ-%s from %s to %s, until %s.', lpad(v_request.event_id::text, 6, '0'),
           public._venue_local_time(v_request.start_datetime), public._venue_local_time(v_request.end_datetime),
           public._venue_local_time(v_expires)),
    'VENUE_STAFF',
    jsonb_build_object('hold', jsonb_build_object('before', NULL, 'after', format('Until %s', public._venue_local_time(v_expires)))),
    'STAFF_ONLY'
  );

  PERFORM public._notify_event_users(
    v_request.event_id,
    'Venue on hold',
    format('%s is on tentative hold for REQ-%s "%s" from %s to %s. The hold expires on %s; request the booking before then.',
           v_venue.name, lpad(v_request.event_id::text, 6, '0'), v_event.title,
           public._venue_local_time(v_request.start_datetime), public._venue_local_time(v_request.end_datetime),
           public._venue_local_time(v_expires)),
    public._event_coordinator_recipients(v_event),
    'BOOKING_UPDATE',
    format('HOLD_PLACED:%s', v_hold_id),
    NULL
  );

  v_response := jsonb_build_object(
    'holdRequestId', p_request_id,
    'status', 'PLACED',
    'holdId', v_hold_id,
    'eventId', v_request.event_id,
    'venueId', v_request.venue_id,
    'start', v_request.start_datetime,
    'end', v_request.end_datetime,
    'occupiedStart', p_hold ->> 'occupiedStart',
    'occupiedEnd', p_hold ->> 'occupiedEnd',
    'expiresAt', v_expires
  );
  RETURN public._store_idempotent_response(p_actor_id, 'venue.place_hold', p_idempotency_key, v_response);
END;
$$;

-- ---------- extending and releasing a hold (venue lock connection) ----------

-- Step 1: the actor may make this change (extend: Venue Staff; release: Venue
-- Staff or the event's assigned coordinator), then the event and venue locks.
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
  RETURN jsonb_build_object('role', v_role);
END;
$$;

-- Step 2: history and notices for an extension or a release (Master 5.4.3).
-- The coordinator hears of Venue Staff changes; Venue Staff hear of releases
-- by the coordinator.
CREATE OR REPLACE FUNCTION public.record_venue_hold_change(
  p_actor_id integer,
  p_event_id integer,
  p_venue_id integer,
  p_hold_id text,
  p_action text,
  p_expires_before timestamptz,
  p_expires_after timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_venue_name text;
  v_role text;
  v_request_ref text := 'REQ-' || lpad(p_event_id::text, 6, '0');
BEGIN
  IF p_hold_id IS NULL OR p_hold_id !~ '^[0-9a-f]{24}$' OR p_action NOT IN ('EXTEND', 'RELEASE')
     OR (p_action = 'EXTEND' AND (p_expires_after IS NULL OR p_expires_after <= p_expires_before)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_HOLD';
  END IF;
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id;
  SELECT name INTO v_venue_name FROM public.venue WHERE venue_id = p_venue_id;
  SELECT role::text INTO v_role FROM public."user" WHERE user_id = p_actor_id;

  IF p_action = 'EXTEND' THEN
    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
    VALUES (p_actor_id, 'event', p_event_id, 'VENUE_HOLD_EXTENDED',
            format('The hold on %s was extended to %s.', v_venue_name, public._venue_local_time(p_expires_after)), v_role,
            jsonb_build_object('venueHold', jsonb_build_object(
              'before', format('On hold until %s', public._venue_local_time(p_expires_before)),
              'after', format('On hold until %s', public._venue_local_time(p_expires_after)))),
            'STAFF_ONLY');
    PERFORM public._notify_event_users(
      p_event_id, 'Venue hold extended',
      format('The tentative hold on %s for %s "%s" now expires on %s.', v_venue_name, v_request_ref, v_event.title,
             public._venue_local_time(p_expires_after)),
      public._event_coordinator_recipients(v_event), 'BOOKING_UPDATE', format('HOLD_EXTENDED:%s', p_hold_id), NULL);
  ELSE
    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
    VALUES (p_actor_id, 'event', p_event_id, 'VENUE_HOLD_RELEASED',
            format('The hold on %s was released.', v_venue_name), v_role,
            jsonb_build_object('venueHold', jsonb_build_object('before', 'On hold', 'after', 'Released')),
            'STAFF_ONLY');
    PERFORM public._notify_event_users(
      p_event_id, 'Venue hold released',
      format('The tentative hold on %s for %s "%s" was released, so the venue is no longer held.', v_venue_name, v_request_ref, v_event.title),
      CASE WHEN v_role = 'VENUE_STAFF' THEN public._event_coordinator_recipients(v_event) ELSE public._venue_staff_recipients(p_actor_id) END,
      'BOOKING_UPDATE', format('HOLD_RELEASED:%s', p_hold_id), NULL);
  END IF;
  RETURN jsonb_build_object('holdId', p_hold_id, 'action', p_action);
END;
$$;

-- ---------- expiry notices (hold expiry job, service_role) ----------

-- 24 hours before expiry (or at once for a shorter hold), and at expiry: the
-- coordinator (SPM-193 notices) and Venue Staff (Master 5.4.3, 8). Each notice
-- has a unique key, so a repeated run sends nothing twice.
CREATE OR REPLACE FUNCTION public.notify_venue_hold_expiry(
  p_kind text,
  p_event_id integer,
  p_hold_id text,
  p_venue_id integer,
  p_expires_at timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_venue_name text;
  v_sent integer := 0;
BEGIN
  IF p_kind NOT IN ('EXPIRING', 'EXPIRED') OR p_hold_id IS NULL OR p_hold_id !~ '^[0-9a-f]{24}$' OR p_expires_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_HOLD';
  END IF;
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id;
  -- A closed event's hold needs no notice.
  IF NOT FOUND OR v_event.status::text IN ('DRAFT', 'COMPLETED', 'CANCELLED', 'REJECTED') THEN
    RETURN 0;
  END IF;
  SELECT name INTO v_venue_name FROM public.venue WHERE venue_id = p_venue_id;

  IF p_kind = 'EXPIRING' THEN
    v_sent := v_sent + COALESCE(public._notify_coordinator_hold_expiring(p_event_id, p_hold_id, p_venue_id, p_expires_at), 0);
    v_sent := v_sent + COALESCE(public._notify_event_users(
      p_event_id, 'Venue hold expiring',
      format('The tentative hold on %s for REQ-%s "%s" expires on %s.', v_venue_name, lpad(p_event_id::text, 6, '0'), v_event.title,
             public._venue_local_time(p_expires_at)),
      public._venue_staff_recipients(NULL), 'BOOKING_UPDATE',
      format('HOLD_EXPIRING:%s:%s:VENUE_STAFF', p_hold_id, public._notification_key_time(p_expires_at)), NULL), 0);
  ELSE
    v_sent := v_sent + COALESCE(public._notify_coordinator_hold_expired(p_event_id, p_hold_id, p_venue_id), 0);
    v_sent := v_sent + COALESCE(public._notify_event_users(
      p_event_id, 'Venue hold expired',
      format('The tentative hold on %s for REQ-%s "%s" has expired; the venue is free again.', v_venue_name,
             lpad(p_event_id::text, 6, '0'), v_event.title),
      public._venue_staff_recipients(NULL), 'BOOKING_UPDATE', format('HOLD_EXPIRED:%s:VENUE_STAFF', p_hold_id), NULL), 0);
    -- Recorded once: the notice key above guards the job's repeats.
    IF v_sent > 0 THEN
      INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
      VALUES (NULL, 'event', p_event_id, 'VENUE_HOLD_EXPIRED',
              format('The hold on %s expired.', v_venue_name), 'SYSTEM',
              jsonb_build_object('venueHold', jsonb_build_object('before', 'On hold', 'after', 'Expired')), 'STAFF_ONLY');
    END IF;
  END IF;
  RETURN v_sent;
END;
$$;

-- ---------- privileges ----------

REVOKE ALL ON FUNCTION public._lock_venue_hold_request(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._venue_staff_recipients(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._venue_hold_booking_conflicts(integer, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.request_venue_hold(integer, integer, integer, text, timestamptz, timestamptz, integer, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.withdraw_venue_hold_request(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decline_venue_hold_request(integer, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_venue_hold_expiry(text, integer, text, integer, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_venue_hold_placement(integer, integer, timestamptz, timestamptz, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_venue_hold_placement(integer, integer, jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.begin_venue_hold_change(integer, integer, integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_venue_hold_change(integer, integer, integer, text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.request_venue_hold(integer, integer, integer, text, timestamptz, timestamptz, integer, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.withdraw_venue_hold_request(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.decline_venue_hold_request(integer, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.notify_venue_hold_expiry(text, integer, text, integer, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_venue_hold_placement(integer, integer, timestamptz, timestamptz, text, text) TO venue_calendar_writer;
GRANT EXECUTE ON FUNCTION public.record_venue_hold_placement(integer, integer, jsonb, text, text) TO venue_calendar_writer;
GRANT EXECUTE ON FUNCTION public.begin_venue_hold_change(integer, integer, integer, text) TO venue_calendar_writer;
GRANT EXECUTE ON FUNCTION public.record_venue_hold_change(integer, integer, integer, text, text, timestamptz, timestamptz) TO venue_calendar_writer;
