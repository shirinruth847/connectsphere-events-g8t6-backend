-- SPM-286 / SPM-287 review fixes. Rebuilt from the applied definitions
-- (request_technical_support from 20261031090200, the others from
-- 20261031090000); only the parts named here change.
--
-- 1. History: event entries record only the status change, under
--    technicalRequestStatus { before, after }; the request id is no longer a
--    bare key (it showed as "technicalRequestId —→—"). Each action also writes a
--    STAFF_ONLY technical_request entry (status, and the reason on rejection).
--    get_technical_request is unchanged: it already reads technical_request
--    entries and the earlier event entries that carry technicalRequestId.
--    Existing history is not changed.
-- 2. list_equipment_schedule for the Technical Support calendar.

-- (1)
CREATE OR REPLACE FUNCTION public.request_technical_support(
  p_actor_id integer,
  p_event_id integer,
  p_items jsonb,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_operation constant text := 'event.request_technical_support';
  v_replay jsonb;
  v_event public.event;
  v_ids integer[];
  v_unknown jsonb;
  v_conflicts jsonb;
  v_request public.technical_request;
  v_items jsonb;
  v_arrangement_version integer;
  v_request_id text;
  v_details text;
BEGIN
  IF p_actor_id IS NULL OR p_event_id IS NULL
     OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 50
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_items) AS i (item)
        WHERE jsonb_typeof(i.item) IS DISTINCT FROM 'object'
           OR jsonb_typeof(i.item->'equipmentId') IS DISTINCT FROM 'number'
           OR jsonb_typeof(i.item->'quantity') IS DISTINCT FROM 'number'
           OR (i.item->>'equipmentId') !~ '^[1-9][0-9]{0,8}$'
           OR (i.item->>'quantity') !~ '^[1-9][0-9]{0,5}$'
     )
     OR (SELECT count(DISTINCT i.item->>'equipmentId') FROM jsonb_array_elements(p_items) AS i (item))
        <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_TECHNICAL_REQUEST';
  END IF;
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  v_replay := public._claim_idempotency_key(p_actor_id, v_operation, p_idempotency_key, p_request_hash);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;

  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id AND status::text <> 'DRAFT' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  PERFORM public._require_booking_coordinator(p_actor_id, v_event);
  IF v_event.status::text <> 'PLANNING' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_IN_PLANNING';
  END IF;
  IF v_event.start_datetime IS NULL OR v_event.end_datetime IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_TIME_NOT_SET';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.technical_request
     WHERE event_id = p_event_id AND status IN ('PENDING', 'APPROVED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TECHNICAL_REQUEST_EXISTS';
  END IF;

  CREATE TEMPORARY TABLE IF NOT EXISTS pg_temp.spm286_item (
    equipment_id integer PRIMARY KEY,
    quantity integer NOT NULL
  ) ON COMMIT DROP;
  -- WHERE true: pg_safeupdate refuses an unqualified DELETE in PostgREST calls.
  DELETE FROM pg_temp.spm286_item WHERE true;
  INSERT INTO pg_temp.spm286_item
  SELECT (i.item->>'equipmentId')::integer, (i.item->>'quantity')::integer
    FROM jsonb_array_elements(p_items) AS i (item);
  v_ids := ARRAY(SELECT equipment_id FROM pg_temp.spm286_item ORDER BY equipment_id);

  PERFORM 1 FROM public.equipment WHERE equipment_id = ANY (v_ids) ORDER BY equipment_id FOR UPDATE;

  SELECT jsonb_agg(item.equipment_id ORDER BY item.equipment_id) INTO v_unknown
    FROM pg_temp.spm286_item AS item
    LEFT JOIN public.equipment AS q ON q.equipment_id = item.equipment_id
   WHERE q.equipment_id IS NULL OR NOT q.is_active OR q.details_pending;
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNKNOWN_EQUIPMENT',
      DETAIL = jsonb_build_object('equipmentIds', v_unknown)::text;
  END IF;

  -- SPM-286 AC6: refused with the quantity still available for the window.
  SELECT jsonb_agg(jsonb_build_object(
           'equipmentId', checked.equipment_id, 'name', checked.name,
           'requested', checked.quantity, 'available', checked.available
         ) ORDER BY checked.equipment_id)
    INTO v_conflicts
    FROM (
      SELECT item.equipment_id, item.quantity, q.name,
             public._equipment_available(item.equipment_id, v_event.start_datetime, v_event.end_datetime, p_event_id) AS available
        FROM pg_temp.spm286_item AS item
        JOIN public.equipment AS q ON q.equipment_id = item.equipment_id
    ) AS checked
   WHERE checked.quantity > checked.available;
  IF v_conflicts IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EQUIPMENT_NOT_AVAILABLE',
      DETAIL = jsonb_build_object('items', v_conflicts)::text;
  END IF;

  INSERT INTO public.technical_request (event_id, status, requested_by)
  VALUES (p_event_id, 'PENDING', p_actor_id)
  RETURNING * INTO v_request;

  INSERT INTO public.equipment_request (
    equipment_id, event_id, requested_by, quantity_requested,
    start_datetime, end_datetime, status, technical_request_id
  )
  SELECT item.equipment_id, p_event_id, p_actor_id, item.quantity,
         v_event.start_datetime, v_event.end_datetime, 'PENDING', v_request.technical_request_id
    FROM pg_temp.spm286_item AS item
   ORDER BY item.equipment_id;

  UPDATE public.event
     SET arrangement_version = arrangement_version + 1
   WHERE event_id = p_event_id
  RETURNING arrangement_version INTO v_arrangement_version;

  v_items := public._technical_request_items(v_request.technical_request_id);
  v_request_id := 'REQ-' || lpad(p_event_id::text, 6, '0');

  v_details := format('Technical request sent: %s.', (
    SELECT string_agg(format('%s x %s', i->>'name', i->>'quantity'), ', ') FROM jsonb_array_elements(v_items) AS i
  ));
  -- The event history shows the status change only; the request's own history
  -- is the technical_request entry.
  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES
    (p_actor_id, 'event', p_event_id, 'TECHNICAL_REQUEST_SENT', v_details, 'COORDINATOR',
     jsonb_build_object('technicalRequestStatus', jsonb_build_object('before', NULL, 'after', 'PENDING')), 'STAFF_ONLY'),
    (p_actor_id, 'technical_request', v_request.technical_request_id, 'TECHNICAL_REQUEST_SENT', v_details, 'COORDINATOR',
     jsonb_build_object('status', jsonb_build_object('before', NULL, 'after', 'PENDING')), 'STAFF_ONLY');

  -- Every active Technical Support member decides technical requests.
  PERFORM public._notify_event_users(
    p_event_id,
    'New technical request',
    format('%s "%s" requests %s equipment item%s.', v_request_id, v_event.title,
           jsonb_array_length(v_items), CASE WHEN jsonb_array_length(v_items) = 1 THEN '' ELSE 's' END),
    ARRAY(SELECT user_id FROM public."user" WHERE role = 'TECH_SUPPORT' AND is_active ORDER BY user_id),
    'EQUIPMENT_UPDATE',
    format('TECHNICAL_REQUEST_SENT:%s', v_request.technical_request_id),
    NULL
  );

  RETURN public._store_idempotent_response(p_actor_id, v_operation, p_idempotency_key, jsonb_build_object(
    'technicalRequestId', v_request.technical_request_id,
    'eventId', p_event_id,
    'requestId', v_request_id,
    'status', v_request.status,
    'items', v_items,
    'arrangementVersion', v_arrangement_version,
    'createdAt', v_request.created_at
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.decide_technical_request(
  p_actor_id integer,
  p_request_id integer,
  p_decision text,
  p_reason text,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_operation constant text := 'technical_request.decide';
  v_reason text := nullif(btrim(p_reason), '');
  v_replay jsonb;
  v_event_id integer;
  v_event public.event;
  v_request public.technical_request;
  v_conflicts jsonb;
  v_status text;
  v_arrangement_version integer;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('APPROVE', 'REJECT') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_TECHNICAL_DECISION';
  END IF;
  IF p_decision = 'REJECT' AND (v_reason IS NULL OR char_length(v_reason) > 1000) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REJECTION_REASON_INVALID';
  END IF;
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."user" WHERE user_id = p_actor_id AND role = 'TECH_SUPPORT' AND is_active) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FORBIDDEN';
  END IF;

  v_replay := public._claim_idempotency_key(p_actor_id, v_operation, p_idempotency_key, p_request_hash);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;

  SELECT event_id INTO v_event_id FROM public.technical_request WHERE technical_request_id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'TECHNICAL_REQUEST_NOT_FOUND';
  END IF;

  SELECT * INTO v_event FROM public.event WHERE event_id = v_event_id FOR UPDATE;
  PERFORM 1 FROM public.equipment
   WHERE equipment_id IN (SELECT equipment_id FROM public.equipment_request WHERE technical_request_id = p_request_id)
   ORDER BY equipment_id
     FOR UPDATE;
  SELECT * INTO v_request FROM public.technical_request WHERE technical_request_id = p_request_id FOR UPDATE;

  -- SPM-287 AC6/AC7: decided requests are read-only; the second of two
  -- concurrent decisions lands here after the first commits.
  IF v_request.status <> 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TECHNICAL_REQUEST_ALREADY_DECIDED',
      DETAIL = jsonb_build_object('status', v_request.status)::text;
  END IF;
  IF v_event.status::text <> 'PLANNING' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_IN_PLANNING';
  END IF;

  IF p_decision = 'APPROVE' THEN
    -- Stock recorded unavailable since the request was sent can make a line
    -- unfillable; all lines approve or none do (Master 5.5).
    SELECT jsonb_agg(jsonb_build_object(
             'equipmentId', checked.equipment_id, 'name', checked.name,
             'requested', checked.quantity_requested, 'available', checked.available
           ) ORDER BY checked.equipment_id)
      INTO v_conflicts
      FROM (
        SELECT line.equipment_id, line.quantity_requested, q.name,
               public._equipment_available(line.equipment_id, line.start_datetime, line.end_datetime, v_event_id) AS available
          FROM public.equipment_request AS line
          JOIN public.equipment AS q ON q.equipment_id = line.equipment_id
         WHERE line.technical_request_id = p_request_id
      ) AS checked
     WHERE checked.quantity_requested > checked.available;
    IF v_conflicts IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EQUIPMENT_NOT_AVAILABLE',
        DETAIL = jsonb_build_object('items', v_conflicts)::text;
    END IF;
    v_status := 'APPROVED';
  ELSE
    v_status := 'REJECTED';
  END IF;

  UPDATE public.technical_request
     SET status = v_status, decided_by = p_actor_id, decided_at = now(),
         rejection_reason = CASE WHEN v_status = 'REJECTED' THEN v_reason END
   WHERE technical_request_id = p_request_id
  RETURNING * INTO v_request;
  -- Rejected lines stop counting in _equipment_available: quantities released.
  UPDATE public.equipment_request
     SET status = v_status::public.equipment_request_status, reviewed_by = p_actor_id
   WHERE technical_request_id = p_request_id;

  UPDATE public.event
     SET arrangement_version = arrangement_version + 1
   WHERE event_id = v_event_id
  RETURNING arrangement_version INTO v_arrangement_version;

  -- Event history: the status change only (the reason stays staff-only on
  -- the request's own entry).
  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES
    (p_actor_id, 'event', v_event_id, 'TECHNICAL_REQUEST_' || v_status,
     format('Technical Support %s the technical request.', lower(v_status)), 'TECH_SUPPORT',
     jsonb_build_object('technicalRequestStatus', jsonb_build_object('before', 'PENDING', 'after', v_status)), 'ORGANISER_SAFE'),
    (p_actor_id, 'technical_request', p_request_id, 'TECHNICAL_REQUEST_' || v_status,
     format('Technical Support %s the technical request.', lower(v_status)), 'TECH_SUPPORT',
     jsonb_build_object('status', jsonb_build_object('before', 'PENDING', 'after', v_status))
       || CASE WHEN v_status = 'REJECTED' THEN jsonb_build_object('rejectionReason', v_reason) ELSE '{}'::jsonb END,
     'STAFF_ONLY');

  PERFORM public._notify_coordinator_technical_decision(v_event_id, p_request_id::text, v_status, v_reason);
  IF v_status = 'APPROVED' THEN
    PERFORM public._notify_technical_approved_owner(v_event_id, p_request_id::text);
  END IF;

  RETURN public._store_idempotent_response(p_actor_id, v_operation, p_idempotency_key, jsonb_build_object(
    'technicalRequestId', p_request_id,
    'eventId', v_event_id,
    'status', v_request.status,
    'rejectionReason', v_request.rejection_reason,
    'decidedAt', v_request.decided_at,
    'arrangementVersion', v_arrangement_version
  ));
END;
$$;

-- (2) SPM-287: the Technical Support calendar. Each Singapore date from p_from
-- to p_to (inclusive, at most 62) that has an event with PENDING or APPROVED
-- equipment, listing each such event under every date it touches.
CREATE FUNCTION public.list_equipment_schedule(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH bounds AS (
    SELECT (p_from::timestamp AT TIME ZONE 'Asia/Singapore') AS lo,
           ((p_to + 1)::timestamp AT TIME ZONE 'Asia/Singapore') AS hi
  ),
  events AS (
    SELECT e.event_id, e.title, e.status::text AS event_status, e.start_datetime, e.end_datetime,
           (e.start_datetime AT TIME ZONE 'Asia/Singapore')::date AS first_day,
           ((e.end_datetime - interval '1 microsecond') AT TIME ZONE 'Asia/Singapore')::date AS last_day,
           jsonb_agg(jsonb_build_object(
             'equipmentId', line.equipment_id,
             'name', q.name,
             'quantity', line.quantity_requested,
             'status', line.status::text,
             'technicalRequestId', line.technical_request_id
           ) ORDER BY q.name, line.equipment_id) AS equipment
      FROM public.equipment_request AS line
      JOIN public.event AS e ON e.event_id = line.event_id
      JOIN public.equipment AS q ON q.equipment_id = line.equipment_id
      CROSS JOIN bounds
     WHERE line.status IN ('PENDING', 'APPROVED')
       AND e.status::text NOT IN ('CANCELLED', 'REJECTED')
       AND e.start_datetime < bounds.hi
       AND e.end_datetime > bounds.lo
     GROUP BY e.event_id
  ),
  days AS (
    SELECT d::date AS day FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') AS d
  ),
  per_day AS (
    SELECT days.day, jsonb_agg(jsonb_build_object(
             'eventId', ev.event_id,
             'requestId', 'REQ-' || lpad(ev.event_id::text, 6, '0'),
             'title', ev.title,
             'status', ev.event_status,
             'start', ev.start_datetime,
             'end', ev.end_datetime,
             'venue', (SELECT jsonb_build_object('venueId', v.venue_id, 'name', v.name) FROM public._event_primary_venue(ev.event_id) AS v LIMIT 1),
             'equipment', ev.equipment
           ) ORDER BY ev.start_datetime, ev.event_id) AS events
      FROM days
      JOIN events AS ev ON ev.first_day <= days.day AND ev.last_day >= days.day
     GROUP BY days.day
  )
  SELECT jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'days', coalesce((SELECT jsonb_agg(jsonb_build_object('date', day, 'events', events) ORDER BY day) FROM per_day), '[]'::jsonb)
  )
   WHERE p_from IS NOT NULL AND p_to IS NOT NULL AND p_to >= p_from AND p_to - p_from < 62;
$$;

REVOKE ALL ON FUNCTION public.list_equipment_schedule(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_equipment_schedule(date, date) TO service_role;
