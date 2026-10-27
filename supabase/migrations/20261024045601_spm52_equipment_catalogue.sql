-- SPM-52: equipment catalogue maintenance by Technical Support (Master 5.5,
-- 6.2, 6.3, 6.5, 7.1-7.3).
--   * equipment gains storage location (reference only, Master 5.5), an active
--     flag, details_pending, a version (Master 6.1), who created and last
--     changed it, a case-insensitive unique name and total_quantity >= 0.
--     storage_location stays nullable for the rows that existed before; the
--     backend requires it on create.
--   * details_pending is true from create until the item's equipment_details
--     document has been applied (Master 6.5 "New records"). It defaults to false
--     so rows inserted outside create_equipment (seeds, test fixtures) remain
--     selectable. An item can be chosen for an event only when is_active AND NOT
--     details_pending.
--   * equipment_unavailability holds time-bounded DAMAGED/MAINTENANCE/OTHER
--     quantities. Per time segment (Master 7.2) the unavailable total never
--     exceeds total stock; every write locks the equipment row first.
--   * outbox_entries is the MongoDB write queue (Master 7.3). Each entry is a
--     full snapshot of the document at one PostgreSQL version, so skipping a
--     stale entry never loses a field. Entries are never deleted by the runtime.
--   * Every change writes the equipment row, its STAFF_ONLY activity entry and,
--     where the document changes, its outbox entry in one transaction.
--   * Each existing row gets one pending entry (description -> specifications).

-- ---------- equipment ----------

ALTER TABLE public.equipment
  ADD COLUMN storage_location varchar(150)
    CONSTRAINT equipment_storage_location_check CHECK (btrim(storage_location) <> ''),
  ADD COLUMN is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN details_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CONSTRAINT equipment_version_positive_check CHECK (version > 0),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  -- Profiles that changed equipment are deactivated, never deleted (Master 6.1).
  ADD COLUMN created_by integer REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  ADD COLUMN updated_by integer REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT equipment_total_quantity_nonnegative_check CHECK (total_quantity >= 0),
  ADD CONSTRAINT equipment_name_not_blank_check CHECK (btrim(name) <> ''),
  ADD CONSTRAINT equipment_category_not_blank_check CHECK (btrim(category) <> '');

CREATE UNIQUE INDEX equipment_name_unique ON public.equipment (lower(name));

COMMENT ON COLUMN public.equipment.details_pending IS
  'true from create_equipment until the equipment_details document is applied; the item cannot be chosen for an event meanwhile.';
COMMENT ON COLUMN public.equipment.description IS
  'Legacy. Copied into equipment_details.specifications by SPM-52 and no longer written.';

-- ---------- unavailable stock ----------

CREATE TABLE public.equipment_unavailability (
  unavailability_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  equipment_id integer NOT NULL REFERENCES public.equipment (equipment_id) ON DELETE RESTRICT,
  quantity integer NOT NULL CONSTRAINT equipment_unavailability_quantity_check CHECK (quantity > 0),
  reason text NOT NULL
    CONSTRAINT equipment_unavailability_reason_check CHECK (reason IN ('DAMAGED', 'MAINTENANCE', 'OTHER')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  note text NOT NULL CONSTRAINT equipment_unavailability_note_check CHECK (char_length(btrim(note)) BETWEEN 1 AND 500),
  -- CANCELLED: ended before it started. A started record is ended by moving ends_at.
  status text NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT equipment_unavailability_status_check CHECK (status IN ('ACTIVE', 'CANCELLED')),
  version integer NOT NULL DEFAULT 1 CONSTRAINT equipment_unavailability_version_check CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  updated_by integer NOT NULL REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  CONSTRAINT equipment_unavailability_period_check CHECK (ends_at > starts_at)
);

CREATE INDEX equipment_unavailability_active_idx
  ON public.equipment_unavailability (equipment_id, ends_at)
  WHERE status = 'ACTIVE';

ALTER TABLE public.equipment_unavailability ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.equipment_unavailability FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.equipment_unavailability TO service_role;

-- ---------- outbox ----------

CREATE TABLE public.outbox_entries (
  entry_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_collection text NOT NULL
    CONSTRAINT outbox_entries_target_check CHECK (target_collection IN ('equipment_details')),
  document_id text NOT NULL CONSTRAINT outbox_entries_document_id_check CHECK (char_length(document_id) BETWEEN 1 AND 64),
  pg_version integer NOT NULL CONSTRAINT outbox_entries_pg_version_check CHECK (pg_version > 0),
  payload jsonb NOT NULL
    CONSTRAINT outbox_entries_payload_check CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 16384),
  state text NOT NULL DEFAULT 'PENDING'
    CONSTRAINT outbox_entries_state_check CHECK (state IN ('PENDING', 'APPLIED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT outbox_entries_attempts_check CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  last_error text CONSTRAINT outbox_entries_last_error_check CHECK (char_length(last_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  -- Master 6.3: one entry per document and version.
  CONSTRAINT outbox_entries_document_version_unique UNIQUE (target_collection, document_id, pg_version)
);

CREATE INDEX outbox_entries_pending_due_idx ON public.outbox_entries (next_attempt_at) WHERE state = 'PENDING';

ALTER TABLE public.outbox_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbox_entries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.outbox_entries TO service_role;

-- ---------- helpers ----------

CREATE FUNCTION public._require_tech_support(p_actor_id integer)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
    FROM public."user"
   WHERE user_id = p_actor_id
     AND role = 'TECH_SUPPORT'
     AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FORBIDDEN';
  END IF;
END;
$$;

-- Locks the item and, when p_expected_version is given, checks the version the
-- caller loaded. Every equipment write takes this lock first (Master 7 lock
-- order: equipment after events and venues).
CREATE FUNCTION public._lock_equipment(p_equipment_id integer, p_expected_version integer)
RETURNS public.equipment
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_equipment public.equipment;
BEGIN
  SELECT * INTO v_equipment
    FROM public.equipment
   WHERE equipment_id = p_equipment_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EQUIPMENT_NOT_FOUND';
  END IF;
  IF p_expected_version IS NOT NULL AND v_equipment.version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EQUIPMENT_VERSION_CONFLICT';
  END IF;
  RETURN v_equipment;
END;
$$;

-- The largest unavailable total in any segment of [p_from, p_to) and that
-- segment (Master 7.2). Segments are split at every start and end inside the
-- range, so periods that do not overlap are never added together.
CREATE FUNCTION public._equipment_peak_unavailable(
  p_equipment_id integer,
  p_from timestamptz,
  p_to timestamptz,
  p_exclude_id integer
)
RETURNS TABLE (peak integer, segment_start timestamptz, segment_end timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH records AS (
    SELECT u.starts_at, u.ends_at, u.quantity
      FROM public.equipment_unavailability AS u
     WHERE u.equipment_id = p_equipment_id
       AND u.status = 'ACTIVE'
       AND (p_exclude_id IS NULL OR u.unavailability_id <> p_exclude_id)
       AND u.starts_at < p_to
       AND u.ends_at > p_from
  ),
  points AS (
    SELECT p_from AS at
    UNION SELECT starts_at FROM records WHERE starts_at > p_from
    UNION SELECT ends_at FROM records WHERE ends_at < p_to
  ),
  segments AS (
    SELECT at AS segment_start, lead(at, 1, p_to) OVER (ORDER BY at) AS segment_end FROM points
  )
  SELECT coalesce(sum(r.quantity), 0)::integer, s.segment_start, s.segment_end
    FROM segments AS s
    LEFT JOIN records AS r ON r.starts_at <= s.segment_start AND r.ends_at > s.segment_start
   GROUP BY s.segment_start, s.segment_end
   ORDER BY 1 DESC, s.segment_start
   LIMIT 1;
$$;

-- The item's current detail document as the latest outbox entry describes it,
-- or, for rows without an entry, what the backfill would have written.
CREATE FUNCTION public._equipment_detail_snapshot(p_equipment public.equipment)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_payload jsonb;
BEGIN
  SELECT payload INTO v_payload
    FROM public.outbox_entries
   WHERE target_collection = 'equipment_details'
     AND document_id = p_equipment.equipment_id::text
   ORDER BY pg_version DESC
   LIMIT 1;
  RETURN coalesce(v_payload, jsonb_build_object(
    'name', p_equipment.name,
    'category', p_equipment.category,
    'specifications', nullif(btrim(p_equipment.description), ''),
    'technicalNotes', NULL,
    'handlingNotes', NULL
  ));
END;
$$;

CREATE FUNCTION public._raise_equipment_conflict(p_code text, p_detail jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = p_code, DETAIL = p_detail::text;
END;
$$;

-- ---------- create ----------

-- p_equipment keys: name, category, storage_location, total_quantity (columns)
-- and specifications, technicalNotes, handlingNotes (document fields). The
-- backend validates and trims the values.
CREATE FUNCTION public.create_equipment(p_actor_id integer, p_equipment jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_equipment public.equipment;
  v_payload jsonb;
  v_entry_id bigint;
BEGIN
  PERFORM public._require_tech_support(p_actor_id);

  BEGIN
    INSERT INTO public.equipment (
      name, category, storage_location, total_quantity, is_active, details_pending, created_by, updated_by
    )
    VALUES (
      p_equipment->>'name',
      p_equipment->>'category',
      p_equipment->>'storage_location',
      (p_equipment->>'total_quantity')::integer,
      true,
      true,
      p_actor_id,
      p_actor_id
    )
    RETURNING * INTO v_equipment;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EQUIPMENT_NAME_TAKEN';
  END;

  v_payload := jsonb_build_object(
    'name', v_equipment.name,
    'category', v_equipment.category,
    'specifications', p_equipment->'specifications',
    'technicalNotes', p_equipment->'technicalNotes',
    'handlingNotes', p_equipment->'handlingNotes'
  );
  INSERT INTO public.outbox_entries (target_collection, document_id, pg_version, payload)
  VALUES ('equipment_details', v_equipment.equipment_id::text, v_equipment.version, v_payload)
  RETURNING entry_id INTO v_entry_id;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, changes, audience)
  VALUES (
    p_actor_id, 'equipment', v_equipment.equipment_id, 'EQUIPMENT_CREATED', 'Equipment created',
    jsonb_build_object(
      'name', jsonb_build_object('before', NULL, 'after', v_equipment.name),
      'category', jsonb_build_object('before', NULL, 'after', v_equipment.category),
      'storageLocation', jsonb_build_object('before', NULL, 'after', v_equipment.storage_location),
      'totalQuantity', jsonb_build_object('before', NULL, 'after', v_equipment.total_quantity),
      'specifications', jsonb_build_object('before', NULL, 'after', v_payload->'specifications'),
      'technicalNotes', jsonb_build_object('before', NULL, 'after', v_payload->'technicalNotes'),
      'handlingNotes', jsonb_build_object('before', NULL, 'after', v_payload->'handlingNotes')
    ),
    'STAFF_ONLY'
  );

  RETURN jsonb_build_object('equipment', to_jsonb(v_equipment), 'changed', true, 'entry_id', v_entry_id);
END;
$$;

-- ---------- update ----------

-- p_changes holds only the fields the caller wants to change, with the keys of
-- create_equipment. Unchanged saves keep the version and write no history.
-- Lowering the total below the largest future unavailable total is refused
-- (SPM-52 AC7). Detail, name or category changes write a new outbox entry.
CREATE FUNCTION public.update_equipment(
  p_actor_id integer,
  p_equipment_id integer,
  p_expected_version integer,
  p_changes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before public.equipment;
  v_equipment public.equipment;
  v_row jsonb;
  v_detail jsonb;
  v_next_detail jsonb;
  v_diff jsonb := '{}'::jsonb;
  v_detail_changed boolean := false;
  v_field record;
  v_new_total integer;
  v_peak record;
  v_entry_id bigint;
BEGIN
  PERFORM public._require_tech_support(p_actor_id);
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR p_expected_version IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EQUIPMENT_CHANGES';
  END IF;

  v_before := public._lock_equipment(p_equipment_id, p_expected_version);
  v_row := to_jsonb(v_before);
  v_detail := public._equipment_detail_snapshot(v_before);
  v_next_detail := v_detail;

  FOR v_field IN
    SELECT * FROM (VALUES
      ('name', 'name'),
      ('category', 'category'),
      ('storage_location', 'storageLocation'),
      ('total_quantity', 'totalQuantity')
    ) AS f (column_name, api_name)
  LOOP
    IF p_changes ? v_field.column_name
       AND (p_changes->v_field.column_name) IS DISTINCT FROM (v_row->v_field.column_name) THEN
      v_diff := v_diff || jsonb_build_object(
        v_field.api_name,
        jsonb_build_object('before', v_row->v_field.column_name, 'after', p_changes->v_field.column_name)
      );
      v_row := jsonb_set(v_row, ARRAY[v_field.column_name], p_changes->v_field.column_name);
    END IF;
  END LOOP;

  FOR v_field IN
    SELECT * FROM (VALUES ('specifications'), ('technicalNotes'), ('handlingNotes')) AS f (key)
  LOOP
    IF p_changes ? v_field.key
       AND (p_changes->v_field.key) IS DISTINCT FROM coalesce(v_detail->v_field.key, 'null'::jsonb) THEN
      v_diff := v_diff || jsonb_build_object(
        v_field.key,
        jsonb_build_object('before', v_detail->v_field.key, 'after', p_changes->v_field.key)
      );
      v_next_detail := jsonb_set(v_next_detail, ARRAY[v_field.key], p_changes->v_field.key);
      v_detail_changed := true;
    END IF;
  END LOOP;

  IF v_diff = '{}'::jsonb THEN
    RETURN jsonb_build_object('equipment', to_jsonb(v_before), 'changed', false, 'entry_id', NULL);
  END IF;

  v_new_total := (v_row->>'total_quantity')::integer;
  IF v_new_total < v_before.total_quantity THEN
    SELECT * INTO v_peak FROM public._equipment_peak_unavailable(p_equipment_id, now(), 'infinity', NULL);
    IF v_new_total < v_peak.peak THEN
      PERFORM public._raise_equipment_conflict('EQUIPMENT_QUANTITY_COMMITTED', jsonb_build_object(
        'committedQuantity', v_peak.peak,
        'periodStart', v_peak.segment_start,
        'periodEnd', v_peak.segment_end
      ));
    END IF;
  END IF;

  BEGIN
    UPDATE public.equipment
       SET name = v_row->>'name',
           category = v_row->>'category',
           storage_location = v_row->>'storage_location',
           total_quantity = v_new_total,
           version = version + 1,
           updated_at = now(),
           updated_by = p_actor_id
     WHERE equipment_id = p_equipment_id
    RETURNING * INTO v_equipment;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EQUIPMENT_NAME_TAKEN';
  END;

  IF v_detail_changed OR v_diff ? 'name' OR v_diff ? 'category' THEN
    v_next_detail := v_next_detail || jsonb_build_object('name', v_equipment.name, 'category', v_equipment.category);
    INSERT INTO public.outbox_entries (target_collection, document_id, pg_version, payload)
    VALUES ('equipment_details', p_equipment_id::text, v_equipment.version, v_next_detail)
    RETURNING entry_id INTO v_entry_id;
  END IF;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, changes, audience)
  VALUES (
    p_actor_id, 'equipment', p_equipment_id, 'EQUIPMENT_UPDATED',
    'Equipment updated: ' || (SELECT string_agg(key, ', ' ORDER BY key) FROM jsonb_object_keys(v_diff) AS key),
    v_diff,
    'STAFF_ONLY'
  );

  RETURN jsonb_build_object('equipment', to_jsonb(v_equipment), 'changed', true, 'entry_id', v_entry_id);
END;
$$;

-- ---------- deactivate / reactivate ----------

-- Deactivating an item that upcoming events have requested needs
-- p_confirm_upcoming; without it the call fails with those events so the
-- client can warn (SPM-52 AC9). Drafts are private to their owner (Master 4.2)
-- and are never listed. Requests are never changed here.
CREATE FUNCTION public.set_equipment_active(
  p_actor_id integer,
  p_equipment_id integer,
  p_expected_version integer,
  p_active boolean,
  p_confirm_upcoming boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before public.equipment;
  v_equipment public.equipment;
  v_upcoming jsonb := '[]'::jsonb;
  v_upcoming_count integer := 0;
BEGIN
  PERFORM public._require_tech_support(p_actor_id);
  IF p_active IS NULL OR p_expected_version IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EQUIPMENT_CHANGES';
  END IF;
  v_before := public._lock_equipment(p_equipment_id, p_expected_version);

  IF v_before.is_active = p_active THEN
    RETURN jsonb_build_object('equipment', to_jsonb(v_before), 'changed', false, 'upcoming_requests', 0);
  END IF;

  IF NOT p_active THEN
    SELECT count(*), coalesce(jsonb_agg(item ORDER BY rn) FILTER (WHERE rn <= 20), '[]'::jsonb)
      INTO v_upcoming_count, v_upcoming
      FROM (
        SELECT jsonb_build_object('eventId', e.event_id, 'title', e.title, 'startDatetime', e.start_datetime) AS item,
               row_number() OVER (ORDER BY e.start_datetime, e.event_id) AS rn
          FROM public.event_equipment_requirement AS r
          JOIN public.event AS e ON e.event_id = r.event_id
         WHERE r.equipment_id = p_equipment_id
           AND e.end_datetime > now()
           AND e.status NOT IN ('DRAFT', 'CANCELLED', 'REJECTED', 'COMPLETED')
      ) AS upcoming;
    IF v_upcoming_count > 0 AND NOT coalesce(p_confirm_upcoming, false) THEN
      PERFORM public._raise_equipment_conflict('EQUIPMENT_HAS_UPCOMING_REQUESTS', jsonb_build_object(
        'upcomingCount', v_upcoming_count,
        'upcomingEvents', v_upcoming
      ));
    END IF;
  END IF;

  UPDATE public.equipment
     SET is_active = p_active,
         version = version + 1,
         updated_at = now(),
         updated_by = p_actor_id
   WHERE equipment_id = p_equipment_id
  RETURNING * INTO v_equipment;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, changes, audience)
  VALUES (
    p_actor_id, 'equipment', p_equipment_id,
    CASE WHEN p_active THEN 'EQUIPMENT_REACTIVATED' ELSE 'EQUIPMENT_DEACTIVATED' END,
    CASE WHEN p_active THEN 'Equipment reactivated' ELSE 'Equipment deactivated' END
      || CASE WHEN v_upcoming_count > 0 THEN format(' with %s upcoming request(s) kept', v_upcoming_count) ELSE '' END,
    jsonb_build_object('isActive', jsonb_build_object('before', v_before.is_active, 'after', v_equipment.is_active)),
    'STAFF_ONLY'
  );

  RETURN jsonb_build_object('equipment', to_jsonb(v_equipment), 'changed', true, 'upcoming_requests', v_upcoming_count);
END;
$$;

-- ---------- unavailable stock ----------

CREATE FUNCTION public._unavailability_changes(p_before public.equipment_unavailability, p_after public.equipment_unavailability)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(jsonb_object_agg(f.api_name, jsonb_build_object('before', f.before_value, 'after', f.after_value)), '{}'::jsonb)
    FROM (VALUES
      ('quantity', to_jsonb(p_before.quantity), to_jsonb(p_after.quantity)),
      ('reason', to_jsonb(p_before.reason), to_jsonb(p_after.reason)),
      ('startsAt', to_jsonb(p_before.starts_at), to_jsonb(p_after.starts_at)),
      ('endsAt', to_jsonb(p_before.ends_at), to_jsonb(p_after.ends_at)),
      ('note', to_jsonb(p_before.note), to_jsonb(p_after.note)),
      ('status', to_jsonb(p_before.status), to_jsonb(p_after.status))
    ) AS f (api_name, before_value, after_value)
   WHERE f.before_value IS DISTINCT FROM f.after_value;
$$;

-- Refuses when p_quantity more units in [p_from, p_to) would exceed total stock
-- in any segment (Master 7.2). The caller holds the equipment lock.
CREATE FUNCTION public._check_unavailability_fits(
  p_equipment public.equipment,
  p_quantity integer,
  p_from timestamptz,
  p_to timestamptz,
  p_exclude_id integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_peak record;
BEGIN
  IF p_to <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNAVAILABILITY_END_IN_PAST';
  END IF;
  SELECT * INTO v_peak FROM public._equipment_peak_unavailable(p_equipment.equipment_id, p_from, p_to, p_exclude_id);
  IF v_peak.peak + p_quantity > p_equipment.total_quantity THEN
    PERFORM public._raise_equipment_conflict('EQUIPMENT_STOCK_EXCEEDED', jsonb_build_object(
      'availableQuantity', greatest(p_equipment.total_quantity - v_peak.peak, 0),
      'periodStart', v_peak.segment_start,
      'periodEnd', v_peak.segment_end
    ));
  END IF;
END;
$$;

-- p_record keys: quantity, reason, starts_at, ends_at, note.
CREATE FUNCTION public.record_equipment_unavailability(p_actor_id integer, p_equipment_id integer, p_record jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_equipment public.equipment;
  v_record public.equipment_unavailability;
BEGIN
  PERFORM public._require_tech_support(p_actor_id);
  v_equipment := public._lock_equipment(p_equipment_id, NULL);

  PERFORM public._check_unavailability_fits(
    v_equipment,
    (p_record->>'quantity')::integer,
    (p_record->>'starts_at')::timestamptz,
    (p_record->>'ends_at')::timestamptz,
    NULL
  );

  INSERT INTO public.equipment_unavailability (
    equipment_id, quantity, reason, starts_at, ends_at, note, created_by, updated_by
  )
  VALUES (
    p_equipment_id,
    (p_record->>'quantity')::integer,
    p_record->>'reason',
    (p_record->>'starts_at')::timestamptz,
    (p_record->>'ends_at')::timestamptz,
    p_record->>'note',
    p_actor_id,
    p_actor_id
  )
  RETURNING * INTO v_record;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, changes, audience)
  VALUES (
    p_actor_id, 'equipment', p_equipment_id, 'EQUIPMENT_UNAVAILABILITY_RECORDED',
    format('%s unit(s) recorded unavailable (%s)', v_record.quantity, v_record.reason),
    jsonb_build_object(
      'unavailabilityId', jsonb_build_object('before', NULL, 'after', v_record.unavailability_id),
      'quantity', jsonb_build_object('before', NULL, 'after', v_record.quantity),
      'reason', jsonb_build_object('before', NULL, 'after', v_record.reason),
      'startsAt', jsonb_build_object('before', NULL, 'after', v_record.starts_at),
      'endsAt', jsonb_build_object('before', NULL, 'after', v_record.ends_at),
      'note', jsonb_build_object('before', NULL, 'after', v_record.note)
    ),
    'STAFF_ONLY'
  );

  RETURN jsonb_build_object('unavailability', to_jsonb(v_record), 'equipment', to_jsonb(v_equipment), 'changed', true);
END;
$$;

-- Locks the item, then the record, and checks the record's version. Records
-- that have ended or were cancelled are history and cannot change.
CREATE FUNCTION public._lock_unavailability(p_equipment_id integer, p_unavailability_id integer, p_expected_version integer)
RETURNS public.equipment_unavailability
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_record public.equipment_unavailability;
BEGIN
  SELECT * INTO v_record
    FROM public.equipment_unavailability
   WHERE unavailability_id = p_unavailability_id
     AND equipment_id = p_equipment_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'UNAVAILABILITY_NOT_FOUND';
  END IF;
  IF p_expected_version IS NULL OR v_record.version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNAVAILABILITY_VERSION_CONFLICT';
  END IF;
  IF v_record.status <> 'ACTIVE' OR v_record.ends_at <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNAVAILABILITY_ENDED';
  END IF;
  RETURN v_record;
END;
$$;

-- p_changes holds only the fields the caller wants to change (keys as in
-- record_equipment_unavailability).
CREATE FUNCTION public.update_equipment_unavailability(
  p_actor_id integer,
  p_equipment_id integer,
  p_unavailability_id integer,
  p_expected_version integer,
  p_changes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_equipment public.equipment;
  v_before public.equipment_unavailability;
  v_after public.equipment_unavailability;
  v_record public.equipment_unavailability;
  v_diff jsonb;
BEGIN
  PERFORM public._require_tech_support(p_actor_id);
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EQUIPMENT_CHANGES';
  END IF;
  v_equipment := public._lock_equipment(p_equipment_id, NULL);
  v_before := public._lock_unavailability(p_equipment_id, p_unavailability_id, p_expected_version);

  v_after := v_before;
  IF p_changes ? 'quantity' THEN v_after.quantity := (p_changes->>'quantity')::integer; END IF;
  IF p_changes ? 'reason' THEN v_after.reason := p_changes->>'reason'; END IF;
  IF p_changes ? 'starts_at' THEN v_after.starts_at := (p_changes->>'starts_at')::timestamptz; END IF;
  IF p_changes ? 'ends_at' THEN v_after.ends_at := (p_changes->>'ends_at')::timestamptz; END IF;
  IF p_changes ? 'note' THEN v_after.note := p_changes->>'note'; END IF;

  v_diff := public._unavailability_changes(v_before, v_after);
  IF v_diff = '{}'::jsonb THEN
    RETURN jsonb_build_object('unavailability', to_jsonb(v_before), 'equipment', to_jsonb(v_equipment), 'changed', false);
  END IF;

  PERFORM public._check_unavailability_fits(
    v_equipment, v_after.quantity, v_after.starts_at, v_after.ends_at, p_unavailability_id
  );

  UPDATE public.equipment_unavailability
     SET quantity = v_after.quantity,
         reason = v_after.reason,
         starts_at = v_after.starts_at,
         ends_at = v_after.ends_at,
         note = v_after.note,
         version = version + 1,
         updated_at = now(),
         updated_by = p_actor_id
   WHERE unavailability_id = p_unavailability_id
  RETURNING * INTO v_record;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, changes, audience)
  VALUES (
    p_actor_id, 'equipment', p_equipment_id, 'EQUIPMENT_UNAVAILABILITY_UPDATED',
    'Unavailable stock updated: ' || (SELECT string_agg(key, ', ' ORDER BY key) FROM jsonb_object_keys(v_diff) AS key),
    v_diff || jsonb_build_object('unavailabilityId', jsonb_build_object('before', p_unavailability_id, 'after', p_unavailability_id)),
    'STAFF_ONLY'
  );

  RETURN jsonb_build_object('unavailability', to_jsonb(v_record), 'equipment', to_jsonb(v_equipment), 'changed', true);
END;
$$;

-- Ends a record early: one that has started ends now; one that has not started
-- is cancelled. Either way it stops counting from now on.
CREATE FUNCTION public.end_equipment_unavailability(
  p_actor_id integer,
  p_equipment_id integer,
  p_unavailability_id integer,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_equipment public.equipment;
  v_before public.equipment_unavailability;
  v_record public.equipment_unavailability;
  v_now timestamptz := now();
BEGIN
  PERFORM public._require_tech_support(p_actor_id);
  v_equipment := public._lock_equipment(p_equipment_id, NULL);
  v_before := public._lock_unavailability(p_equipment_id, p_unavailability_id, p_expected_version);

  UPDATE public.equipment_unavailability
     SET status = CASE WHEN starts_at >= v_now THEN 'CANCELLED' ELSE status END,
         ends_at = CASE WHEN starts_at >= v_now THEN ends_at ELSE v_now END,
         version = version + 1,
         updated_at = v_now,
         updated_by = p_actor_id
   WHERE unavailability_id = p_unavailability_id
  RETURNING * INTO v_record;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, changes, audience)
  VALUES (
    p_actor_id, 'equipment', p_equipment_id, 'EQUIPMENT_UNAVAILABILITY_ENDED',
    CASE WHEN v_record.status = 'CANCELLED' THEN 'Unavailable stock cancelled before it started'
         ELSE 'Unavailable stock ended early' END,
    public._unavailability_changes(v_before, v_record)
      || jsonb_build_object('unavailabilityId', jsonb_build_object('before', p_unavailability_id, 'after', p_unavailability_id)),
    'STAFF_ONLY'
  );

  RETURN jsonb_build_object('unavailability', to_jsonb(v_record), 'equipment', to_jsonb(v_equipment), 'changed', true);
END;
$$;

-- ---------- outbox processing (Master 7.3) ----------

-- Leases up to p_limit due entries. SKIP LOCKED and the lease keep two workers
-- from applying the same entry at once; an expired lease is claimable again.
CREATE FUNCTION public.claim_outbox_entries(p_limit integer, p_lease_seconds integer)
RETURNS SETOF public.outbox_entries
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.outbox_entries AS o
     SET lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 1))
   WHERE o.entry_id IN (
     SELECT entry_id
       FROM public.outbox_entries
      WHERE state = 'PENDING'
        AND next_attempt_at <= now()
        AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      ORDER BY next_attempt_at, entry_id
      LIMIT least(greatest(p_limit, 1), 100)
        FOR UPDATE SKIP LOCKED
   )
  RETURNING o.*;
$$;

-- The request handler's single attempt right after commit. Returns nothing when
-- the entry is already leased, applied or failed.
CREATE FUNCTION public.claim_outbox_entry(p_entry_id bigint, p_lease_seconds integer)
RETURNS SETOF public.outbox_entries
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.outbox_entries AS o
     SET lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 1))
   WHERE o.entry_id IN (
     SELECT entry_id
       FROM public.outbox_entries
      WHERE entry_id = p_entry_id
        AND state = 'PENDING'
        AND (lease_expires_at IS NULL OR lease_expires_at <= now())
        FOR UPDATE SKIP LOCKED
   )
  RETURNING o.*;
$$;

-- Marks an entry applied (a stale entry the document ignored counts as applied)
-- and, once an equipment document exists, clears details_pending.
CREATE FUNCTION public.complete_outbox_entry(p_entry_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_entry public.outbox_entries;
BEGIN
  UPDATE public.outbox_entries
     SET state = 'APPLIED',
         applied_at = now(),
         lease_expires_at = NULL,
         last_error = NULL
   WHERE entry_id = p_entry_id
     AND state = 'PENDING'
  RETURNING * INTO v_entry;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_entry.target_collection = 'equipment_details' THEN
    UPDATE public.equipment
       SET details_pending = false
     WHERE equipment_id = v_entry.document_id::integer
       AND details_pending;
  END IF;
  RETURN true;
END;
$$;

-- Records a failed attempt: retried after 30 s, 60 s, 120 s ... (at most an
-- hour) and marked FAILED after p_max_attempts. Failed entries stay for the
-- developer (Master 7.3 step 4).
CREATE FUNCTION public.fail_outbox_entry(p_entry_id bigint, p_error text, p_max_attempts integer DEFAULT 8)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state text;
BEGIN
  UPDATE public.outbox_entries
     SET attempts = attempts + 1,
         state = CASE WHEN attempts + 1 >= greatest(p_max_attempts, 1) THEN 'FAILED' ELSE 'PENDING' END,
         next_attempt_at = now() + least(interval '1 hour', interval '30 seconds' * power(2, least(attempts, 10))),
         lease_expires_at = NULL,
         last_error = left(coalesce(p_error, 'Unknown error'), 500)
   WHERE entry_id = p_entry_id
     AND state = 'PENDING'
  RETURNING state INTO v_state;
  RETURN v_state;
END;
$$;

-- ---------- backfill ----------

INSERT INTO public.outbox_entries (target_collection, document_id, pg_version, payload)
SELECT 'equipment_details',
       equipment_id::text,
       version,
       jsonb_build_object(
         'name', name,
         'category', category,
         'specifications', nullif(btrim(description), ''),
         'technicalNotes', NULL,
         'handlingNotes', NULL
       )
  FROM public.equipment;

-- ---------- privileges ----------

REVOKE ALL ON FUNCTION public._require_tech_support(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._lock_equipment(integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._equipment_peak_unavailable(integer, timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._equipment_detail_snapshot(public.equipment) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._raise_equipment_conflict(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._unavailability_changes(public.equipment_unavailability, public.equipment_unavailability) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._check_unavailability_fits(public.equipment, integer, timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._lock_unavailability(integer, integer, integer) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_equipment(integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_equipment(integer, integer, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_equipment_active(integer, integer, integer, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_equipment_unavailability(integer, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_equipment_unavailability(integer, integer, integer, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.end_equipment_unavailability(integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_outbox_entries(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_outbox_entry(bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_outbox_entry(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_outbox_entry(bigint, text, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_equipment(integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_equipment(integer, integer, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_equipment_active(integer, integer, integer, boolean, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_equipment_unavailability(integer, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_equipment_unavailability(integer, integer, integer, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.end_equipment_unavailability(integer, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_outbox_entries(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_outbox_entry(bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_outbox_entry(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_outbox_entry(bigint, text, integer) TO service_role;
