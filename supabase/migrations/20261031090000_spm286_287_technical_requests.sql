-- SPM-286 / SPM-287: technical requests for equipment.
--
-- A technical request is a header (technical_request) over the existing
-- equipment_request lines. Lines keep mirroring their header's status, so
-- _event_readiness and the safety review read them unchanged. The coordinator
-- sends one in PLANNING (SPM-286 AC5-AC7); Technical Support approve or reject
-- it whole (SPM-287 AC4-AC7, Master 5.5: no partial approval).
--
-- Availability (Master 5.5, 7.2) is usable stock minus the peak concurrent
-- use in the window: active unavailability plus other events' PENDING or
-- APPROVED lines, on half-open intervals and without venue buffers. Lines of
-- cancelled or rejected events hold nothing.
--
-- Backfill: per event, REJECTED lines get one REJECTED header; all other lines
-- get one active header, PENDING if any line is PENDING or
-- PARTIALLY_FULFILLED, otherwise APPROVED, and those lines take that status.
-- So every event has at most one active header.
--
-- technical_request_id stays nullable: seed and integration fixtures still
-- insert bare lines. Such lines hold stock but are not on the dashboard.

CREATE TABLE public.technical_request (
  technical_request_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id integer NOT NULL REFERENCES public.event (event_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  requested_by integer REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  decided_by integer REFERENCES public."user" (user_id) ON DELETE SET NULL,
  decided_at timestamptz,
  rejection_reason text CHECK (char_length(rejection_reason) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT technical_request_reason_state_check CHECK ((status = 'REJECTED') = (rejection_reason IS NOT NULL)),
  CONSTRAINT technical_request_pending_state_check CHECK (status <> 'PENDING' OR (decided_by IS NULL AND decided_at IS NULL))
);

-- One active canonical technical request per event (Master 6.3).
CREATE UNIQUE INDEX technical_request_one_active_idx
  ON public.technical_request (event_id) WHERE status IN ('PENDING', 'APPROVED');
CREATE INDEX technical_request_status_created_idx ON public.technical_request (status, created_at);

ALTER TABLE public.technical_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.technical_request FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.technical_request TO service_role;

ALTER TABLE public.equipment_request
  ADD COLUMN technical_request_id integer REFERENCES public.technical_request (technical_request_id) ON DELETE CASCADE;
CREATE INDEX equipment_request_technical_request_idx ON public.equipment_request (technical_request_id);
CREATE INDEX equipment_request_active_window_idx
  ON public.equipment_request (equipment_id, start_datetime, end_datetime) WHERE status IN ('PENDING', 'APPROVED');

-- Backfill (see header).
UPDATE public.equipment_request SET status = 'PENDING' WHERE status = 'PARTIALLY_FULFILLED';
UPDATE public.equipment_request AS line
   SET status = 'PENDING'
 WHERE line.status = 'APPROVED'
   AND EXISTS (SELECT 1 FROM public.equipment_request AS other WHERE other.event_id = line.event_id AND other.status = 'PENDING');

INSERT INTO public.technical_request (event_id, status, requested_by, decided_by, rejection_reason, created_at)
SELECT event_id,
       status::text,
       min(requested_by),
       CASE WHEN status::text <> 'PENDING' THEN max(reviewed_by) END,
       CASE WHEN status::text = 'REJECTED' THEN 'Recorded before technical requests kept a reason.' END,
       coalesce(min(request_datetime), now())
  FROM public.equipment_request
 GROUP BY event_id, status;

UPDATE public.equipment_request AS line
   SET technical_request_id = header.technical_request_id
  FROM public.technical_request AS header
 WHERE header.event_id = line.event_id AND header.status = line.status::text;

-- Quantity of one item free for [p_from, p_to), ignoring p_exclude_event_id's
-- own lines. Peak concurrent use: the used quantity is summed at every point
-- where a record starts (or the window starts) and the maximum is taken.
CREATE FUNCTION public._equipment_available(
  p_equipment_id integer,
  p_from timestamptz,
  p_to timestamptz,
  p_exclude_event_id integer
)
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH records AS (
    SELECT u.starts_at, u.ends_at, u.quantity
      FROM public.equipment_unavailability AS u
     WHERE u.equipment_id = p_equipment_id
       AND u.status = 'ACTIVE'
       AND u.starts_at < p_to
       AND u.ends_at > p_from
    UNION ALL
    SELECT line.start_datetime, line.end_datetime, line.quantity_requested
      FROM public.equipment_request AS line
      JOIN public.event AS e ON e.event_id = line.event_id
     WHERE line.equipment_id = p_equipment_id
       AND line.status IN ('PENDING', 'APPROVED')
       AND e.status::text NOT IN ('CANCELLED', 'REJECTED')
       AND line.event_id IS DISTINCT FROM p_exclude_event_id
       AND line.start_datetime < p_to
       AND line.end_datetime > p_from
  ),
  points AS (
    SELECT p_from AS at
    UNION SELECT starts_at FROM records WHERE starts_at > p_from
  ),
  peak AS (
    SELECT coalesce(max(used), 0) AS used
      FROM (
        SELECT (SELECT coalesce(sum(r.quantity), 0) FROM records AS r WHERE r.starts_at <= p.at AND r.ends_at > p.at) AS used
          FROM points AS p
      ) AS per_point
  )
  SELECT CASE WHEN q.is_active AND NOT q.details_pending THEN greatest(q.total_quantity - peak.used, 0) ELSE 0 END
    FROM public.equipment AS q, peak
   WHERE q.equipment_id = p_equipment_id;
$$;

-- Catalogue options for the event request form (SPM-286 AC1/AC2), or only
-- p_equipment_ids when given (the AC3 save check). Without a window, usable
-- stock is total stock minus what is unavailable now.
CREATE FUNCTION public.equipment_availability(p_from timestamptz, p_to timestamptz, p_equipment_ids integer[] DEFAULT NULL)
RETURNS TABLE (
  equipment_id integer,
  name text,
  category text,
  description text,
  total_quantity integer,
  available_quantity integer
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT q.equipment_id,
         q.name::text,
         q.category::text,
         q.description,
         q.total_quantity,
         CASE
           WHEN p_from IS NULL OR p_to IS NULL THEN greatest(q.total_quantity - coalesce((
             SELECT sum(u.quantity) FROM public.equipment_unavailability AS u
              WHERE u.equipment_id = q.equipment_id AND u.status = 'ACTIVE'
                AND u.starts_at <= now() AND u.ends_at > now()
           ), 0), 0)::integer
           ELSE public._equipment_available(q.equipment_id, p_from, p_to, NULL)
         END
    FROM public.equipment AS q
   WHERE q.is_active AND NOT q.details_pending
     AND (p_equipment_ids IS NULL OR q.equipment_id = ANY (p_equipment_ids))
   ORDER BY q.name, q.equipment_id;
$$;

-- Owner-only notice (SPM-192 rules) when Technical Support approve.
CREATE FUNCTION public._notify_technical_approved_owner(p_event_id integer, p_request_key text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request_key text := public._coordinator_notice_ref(p_request_key, 'INVALID_TECHNICAL_REQUEST');
  v_event public.event := public._owner_notice_event(p_event_id, 'PLANNING');
BEGIN
  RETURN public._notify_event_users(
    p_event_id,
    'Equipment approved',
    format('Technical Support approved the equipment for your event REQ-%s "%s".',
           lpad(p_event_id::text, 6, '0'), v_event.title),
    public._event_owner_recipients(v_event),
    'EQUIPMENT_UPDATE',
    format('TECHNICAL_REQUEST_APPROVED:%s:OWNER', v_request_key),
    NULL
  );
END;
$$;

-- Lines of one request as [{equipmentId, name, quantity}].
CREATE FUNCTION public._technical_request_items(p_request_id integer)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'equipmentId', line.equipment_id,
           'name', q.name,
           'category', q.category,
           'quantity', line.quantity_requested
         ) ORDER BY q.name, line.equipment_id), '[]'::jsonb)
    FROM public.equipment_request AS line
    JOIN public.equipment AS q ON q.equipment_id = line.equipment_id
   WHERE line.technical_request_id = p_request_id;
$$;

-- SPM-286 AC5-AC7: the assigned coordinator sends the event's technical
-- request while it is in PLANNING. Lock order (Master 7): event, then
-- equipment rows in ascending ID, so two requests for the last units are
-- serialised and the second sees the first's PENDING lines.
CREATE FUNCTION public.request_technical_support(
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
  DELETE FROM pg_temp.spm286_item;
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

-- SPM-287 AC4-AC7: approve or reject a PENDING request whole, in one
-- transaction. Lock order: event, equipment rows ascending, then the request.
CREATE FUNCTION public.decide_technical_request(
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

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', v_event_id,
    'TECHNICAL_REQUEST_' || v_status,
    format('Technical Support %s the technical request.', lower(v_status)),
    'TECH_SUPPORT',
    jsonb_build_object(
      'technicalRequestId', p_request_id,
      'technicalRequest', jsonb_build_object('before', 'PENDING', 'after', v_status)
    ),
    'ORGANISER_SAFE'
  );
  IF v_status = 'REJECTED' THEN
    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
    VALUES (
      p_actor_id, 'technical_request', p_request_id, 'TECHNICAL_REQUEST_REJECTED',
      'Rejection reason recorded.', 'TECH_SUPPORT',
      jsonb_build_object('rejectionReason', v_reason),
      'STAFF_ONLY'
    );
  END IF;

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

-- SPM-287 AC1/AC2: the dashboard list. Pending first, oldest first; decided
-- requests after, most recent decision first.
CREATE FUNCTION public.list_technical_requests(p_status text, p_search text, p_limit integer, p_offset integer)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH matching AS (
    SELECT t.*, e.title, e.start_datetime, e.end_datetime, e.status::text AS event_status, u.name AS requested_by_name
      FROM public.technical_request AS t
      JOIN public.event AS e ON e.event_id = t.event_id
      LEFT JOIN public."user" AS u ON u.user_id = t.requested_by
     WHERE (p_status IS NULL OR t.status = p_status)
       AND (p_search IS NULL OR e.title ILIKE '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%')
  ),
  page AS (
    SELECT * FROM matching
     ORDER BY (status <> 'PENDING'),
              CASE WHEN status = 'PENDING' THEN created_at END ASC,
              decided_at DESC NULLS LAST,
              technical_request_id
     LIMIT LEAST(GREATEST(coalesce(p_limit, 20), 1), 100)
    OFFSET GREATEST(coalesce(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM matching),
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'technicalRequestId', p.technical_request_id,
               'status', p.status,
               'createdAt', p.created_at,
               'decidedAt', p.decided_at,
               'event', jsonb_build_object(
                 'eventId', p.event_id,
                 'requestId', 'REQ-' || lpad(p.event_id::text, 6, '0'),
                 'title', p.title,
                 'status', p.event_status,
                 'start', p.start_datetime,
                 'end', p.end_datetime,
                 'venue', (SELECT jsonb_build_object('venueId', v.venue_id, 'name', v.name) FROM public._event_primary_venue(p.event_id) AS v LIMIT 1)
               ),
               'requestedBy', CASE WHEN p.requested_by IS NULL THEN NULL
                                   ELSE jsonb_build_object('userId', p.requested_by, 'name', p.requested_by_name) END,
               'items', public._technical_request_items(p.technical_request_id)
             ) ORDER BY (p.status <> 'PENDING'),
                        CASE WHEN p.status = 'PENDING' THEN p.created_at END ASC,
                        p.decided_at DESC NULLS LAST,
                        p.technical_request_id)
        FROM page AS p
    ), '[]'::jsonb)
  );
$$;

-- SPM-287 AC3: one request with availability per line (excluding this
-- request's event), the event's schedule and venue, and its history.
CREATE FUNCTION public.get_technical_request(p_request_id integer)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'technicalRequestId', t.technical_request_id,
    'status', t.status,
    'rejectionReason', t.rejection_reason,
    'createdAt', t.created_at,
    'decidedAt', t.decided_at,
    'requestedBy', (SELECT jsonb_build_object('userId', u.user_id, 'name', u.name) FROM public."user" AS u WHERE u.user_id = t.requested_by),
    'decidedBy', (SELECT jsonb_build_object('userId', u.user_id, 'name', u.name) FROM public."user" AS u WHERE u.user_id = t.decided_by),
    'event', jsonb_build_object(
      'eventId', e.event_id,
      'requestId', 'REQ-' || lpad(e.event_id::text, 6, '0'),
      'title', e.title,
      'status', e.status::text,
      'start', e.start_datetime,
      'end', e.end_datetime,
      'venue', (SELECT jsonb_build_object('venueId', v.venue_id, 'name', v.name, 'address', v.address) FROM public._event_primary_venue(e.event_id) AS v LIMIT 1)
    ),
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'equipmentId', line.equipment_id,
               'name', q.name,
               'category', q.category,
               'quantity', line.quantity_requested,
               'availableQuantity', public._equipment_available(line.equipment_id, line.start_datetime, line.end_datetime, t.event_id)
             ) ORDER BY q.name, line.equipment_id)
        FROM public.equipment_request AS line
        JOIN public.equipment AS q ON q.equipment_id = line.equipment_id
       WHERE line.technical_request_id = t.technical_request_id
    ), '[]'::jsonb),
    'history', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'action', a.action,
               'details', a.details,
               'actorRole', a.actor_role,
               'actor', CASE WHEN a.user_id IS NULL THEN NULL ELSE jsonb_build_object('userId', a.user_id, 'name', u.name) END,
               'rejectionReason', a.changes->>'rejectionReason',
               'at', a."timestamp"
             ) ORDER BY a."timestamp", a.log_id)
        FROM public.activity_log AS a
        LEFT JOIN public."user" AS u ON u.user_id = a.user_id
       WHERE (a.entity_name = 'technical_request' AND a.entity_id = t.technical_request_id)
          OR (a.entity_name = 'event' AND a.entity_id = t.event_id
              AND a.action LIKE 'TECHNICAL\_REQUEST\_%'
              AND a.changes->>'technicalRequestId' = t.technical_request_id::text)
    ), '[]'::jsonb)
  )
    FROM public.technical_request AS t
    JOIN public.event AS e ON e.event_id = t.event_id
   WHERE t.technical_request_id = p_request_id;
$$;

REVOKE ALL ON FUNCTION public._equipment_available(integer, timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_technical_approved_owner(integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._technical_request_items(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.equipment_availability(timestamptz, timestamptz, integer[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_technical_support(integer, integer, jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decide_technical_request(integer, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_technical_requests(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_technical_request(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.equipment_availability(timestamptz, timestamptz, integer[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_technical_support(integer, integer, jsonb, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decide_technical_request(integer, integer, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_technical_requests(text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_technical_request(integer) TO service_role;
