-- SPM-286: request_technical_support as applied in 20261031090000, with one
-- change: the temporary-table reset is DELETE ... WHERE true. Through
-- PostgREST (supabase.rpc) pg_safeupdate refuses an unqualified DELETE
-- ("DELETE requires a WHERE clause"), so every request failed with a 500.
-- Same signature, so existing grants are kept.

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

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', p_event_id, 'TECHNICAL_REQUEST_SENT',
    format('Technical request sent: %s.', (
      SELECT string_agg(format('%s x %s', i->>'name', i->>'quantity'), ', ') FROM jsonb_array_elements(v_items) AS i
    )),
    'COORDINATOR',
    jsonb_build_object(
      'technicalRequestId', v_request.technical_request_id,
      'technicalRequest', jsonb_build_object('before', NULL, 'after', 'PENDING')
    ),
    'STAFF_ONLY'
  );

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
