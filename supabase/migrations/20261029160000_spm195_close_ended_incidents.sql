-- SPM-195 review fixes.
--
-- 1. A VENUE_BLOCK incident warns the coordinator that a booking or hold needs
--    another arrangement (Week 7 change #2). Once that booking or hold has
--    ended, the warning no longer applies, and an open one would keep blocking
--    readiness (OPEN_BLOCKING_INCIDENT) for good. The system closes it in the
--    same transaction as the action that ended the arrangement:
--      - a booking rejected by Venue Staff or cancelled  -> RELEASED
--      - the event cancelled                              -> EVENT_CANCELLED
--      - the event rejected                               -> RELEASED
--    Holds live in MongoDB: the hold expiry job (SPM-190) and hold conversion
--    (SPM-188) call _close_venue_block_incidents for the hold when they run.
--    Each closure writes a staff-only history entry naming who ended the
--    arrangement (the Venue Staff member who rejected it, otherwise SYSTEM;
--    the action's own history entry records its actor).
-- 2. Restore refuses an incident that was closed without being restored,
--    instead of reporting it as already restored.
-- 3. A block is never refused because of the bookings it covers (Master 5.4.4):
--    the 1,000-event limit on the events locked first is removed.
--
-- Run in the Supabase SQL editor (Master 10.3.1); the version is recorded
-- afterwards. CREATE OR REPLACE keeps each entry point's grant to
-- venue_calendar_writer.

-- Closes the event's open VENUE_BLOCK incidents: all of them, or only those of
-- one booking or one hold. Returns how many were closed.
CREATE OR REPLACE FUNCTION public._close_venue_block_incidents(
  p_event_id integer,
  p_booking_id integer,
  p_hold_id text,
  p_resolution text,
  p_actor_id integer,
  p_reason text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor public."user";
  v_incident public.resource_incidents;
  v_closed integer := 0;
BEGIN
  IF p_event_id IS NULL OR p_resolution IS NULL OR p_reason IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_INCIDENT_CLOSURE';
  END IF;
  SELECT * INTO v_actor FROM public."user" WHERE user_id = p_actor_id;

  FOR v_incident IN
    UPDATE public.resource_incidents
       SET status = 'RESOLVED', resolution = p_resolution, resolved_at = now()
     WHERE event_id = p_event_id
       AND type = 'VENUE_BLOCK'
       AND status = 'OPEN'
       AND (p_booking_id IS NULL OR booking_id = p_booking_id)
       AND (p_hold_id IS NULL OR calendar_hold_id = p_hold_id)
    RETURNING *
  LOOP
    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
    VALUES (
      v_actor.user_id, 'event', p_event_id, 'VENUE_INCIDENT_CLOSED',
      format('Venue incident closed: %s', p_reason),
      COALESCE(v_actor.role::text, 'SYSTEM'),
      jsonb_build_object('incident', jsonb_build_object('before', 'OPEN', 'after', p_resolution)),
      'STAFF_ONLY'
    );
    v_closed := v_closed + 1;
  END LOOP;
  RETURN v_closed;
END;
$$;

-- A booking that stops being active (PENDING or APPROVED) no longer reserves
-- the venue. decide_venue_booking records the rejecting Venue Staff member in
-- reviewed_by; any other ending is recorded as SYSTEM.
CREATE OR REPLACE FUNCTION public._venue_booking_close_incidents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public._close_venue_block_incidents(
    NEW.event_id, NEW.booking_id, NULL, 'RELEASED',
    CASE WHEN NEW.status::text = 'REJECTED' THEN NEW.reviewed_by END,
    format('booking #%s was %s.', NEW.booking_id,
           CASE WHEN NEW.status::text = 'REJECTED' THEN 'rejected by Venue Staff' ELSE lower(NEW.status::text) END)
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS venue_booking_close_incidents ON public.venue_booking;
CREATE TRIGGER venue_booking_close_incidents
  AFTER UPDATE OF status ON public.venue_booking
  FOR EACH ROW
  WHEN (OLD.status::text IN ('PENDING', 'APPROVED') AND NEW.status::text NOT IN ('PENDING', 'APPROVED'))
  EXECUTE FUNCTION public._venue_booking_close_incidents();

-- A cancelled or rejected event keeps no venue arrangements (Master 5.4.3, 5.7).
CREATE OR REPLACE FUNCTION public._event_close_incidents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public._close_venue_block_incidents(
    NEW.event_id, NULL, NULL,
    CASE WHEN NEW.status::text = 'CANCELLED' THEN 'EVENT_CANCELLED' ELSE 'RELEASED' END,
    NULL,
    format('the event was %s.', lower(NEW.status::text))
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS event_close_incidents ON public.event;
CREATE TRIGGER event_close_incidents
  AFTER UPDATE OF status ON public.event
  FOR EACH ROW
  WHEN (NEW.status::text IN ('CANCELLED', 'REJECTED') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public._event_close_incidents();

-- Step 1 of recording a block, as in 20261029140000, without a limit on the
-- number of events locked first.
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

-- Step 1 of shortening or lifting a block, as in 20261029140000, without a
-- limit on the number of events locked first.
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

-- Step 1 of restoring a booking, as in 20261029140000, except that an incident
-- closed without being restored (its booking or event ended) is refused rather
-- than reported as already restored.
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
    IF v_incident.resolution IS DISTINCT FROM 'RESTORED' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INCIDENT_NOT_RESTORABLE';
    END IF;
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

-- Incidents left open before this migration whose booking or event already ended.
DO $close_ended$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT DISTINCT i.event_id, i.booking_id, e.status::text AS event_status, b.status::text AS booking_status
      FROM public.resource_incidents AS i
      JOIN public.event AS e ON e.event_id = i.event_id
      LEFT JOIN public.venue_booking AS b ON b.booking_id = i.booking_id
     WHERE i.type = 'VENUE_BLOCK' AND i.status = 'OPEN'
       AND (e.status::text IN ('CANCELLED', 'REJECTED')
            OR (i.booking_id IS NOT NULL AND b.status::text NOT IN ('PENDING', 'APPROVED')))
     ORDER BY i.event_id, i.booking_id
  LOOP
    IF v_row.event_status IN ('CANCELLED', 'REJECTED') THEN
      PERFORM public._close_venue_block_incidents(
        v_row.event_id, NULL, NULL,
        CASE WHEN v_row.event_status = 'CANCELLED' THEN 'EVENT_CANCELLED' ELSE 'RELEASED' END,
        NULL, format('the event was %s.', lower(v_row.event_status)));
    ELSE
      PERFORM public._close_venue_block_incidents(
        v_row.event_id, v_row.booking_id, NULL, 'RELEASED',
        NULL, format('booking #%s was %s.', v_row.booking_id, lower(v_row.booking_status)));
    END IF;
  END LOOP;
END;
$close_ended$;

-- The helpers run only inside triggers and SPM-195/190/188 database functions.
REVOKE ALL ON FUNCTION public._close_venue_block_incidents(integer, integer, text, text, integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._venue_booking_close_incidents() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_close_incidents() FROM PUBLIC, anon, authenticated, service_role;
