-- SPM-33: role-scoped direct edits, stale-save detection, idempotent update
-- retries and audience-filtered change history.
--
-- Additive for existing callers: save_event_draft keeps its named arguments
-- (the new one is optional), and writers that do not set the new history
-- columns get them filled by trigger.

-- ---------- 1. Event version (stale-save detection, AC7) ----------

ALTER TABLE public.event
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT event_version_positive_check CHECK (version > 0);

-- A trigger rather than arithmetic in each function, so every writer moves the
-- version, including the assignment and review functions owned by other tickets.
CREATE FUNCTION public._bump_event_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_bump_version
  BEFORE UPDATE ON public.event
  FOR EACH ROW EXECUTE FUNCTION public._bump_event_version();

-- ---------- 2. Change history format (AC8) ----------
-- Shared with SPM-39 and SPM-177: actor role, changed attributes with safe
-- before/after values, and the audience allowed to read the entry.

ALTER TABLE public.activity_log
  ADD COLUMN actor_role text,
  ADD COLUMN changes jsonb,
  ADD COLUMN audience text,
  ADD CONSTRAINT activity_log_changes_object_check
    CHECK (changes IS NULL OR jsonb_typeof(changes) = 'object'),
  ADD CONSTRAINT activity_log_audience_check
    CHECK (audience IN ('ORGANISER_SAFE', 'STAFF_ONLY'));

-- Existing rows: the role is the actor's current one (roles were not recorded
-- before), and only the organiser's own draft and submission entries are
-- organiser-safe. Everything else, including reassignment records, is staff-only.
UPDATE public.activity_log AS a
   SET actor_role = (SELECT u.role::text FROM public."user" AS u WHERE u.user_id = a.user_id),
       audience = CASE
         WHEN a.entity_name = 'event'
          AND a.action IN ('DRAFT_CREATED', 'DRAFT_UPDATED', 'EVENT_SUBMITTED')
         THEN 'ORGANISER_SAFE'
         ELSE 'STAFF_ONLY'
       END;

ALTER TABLE public.activity_log ALTER COLUMN audience SET NOT NULL;

-- Fills what a writer leaves out. An entry is staff-only unless its writer says
-- otherwise or its action is a known organiser-safe one, so a new kind of entry
-- can never reach organisers by default.
CREATE FUNCTION public._activity_log_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.actor_role IS NULL THEN
    NEW.actor_role := (SELECT u.role::text FROM public."user" AS u WHERE u.user_id = NEW.user_id);
  END IF;
  IF NEW.audience IS NULL THEN
    NEW.audience := CASE
      WHEN NEW.entity_name = 'event'
       AND NEW.action IN ('DRAFT_CREATED', 'DRAFT_UPDATED', 'EVENT_SUBMITTED', 'EVENT_DETAILS_UPDATED')
      THEN 'ORGANISER_SAFE'
      ELSE 'STAFF_ONLY'
    END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER activity_log_defaults
  BEFORE INSERT ON public.activity_log
  FOR EACH ROW EXECUTE FUNCTION public._activity_log_defaults();

CREATE INDEX activity_log_entity_history_idx
  ON public.activity_log (entity_name, entity_id, log_id DESC);

-- History is append-only for the runtime: it already has no UPDATE or DELETE.
REVOKE TRUNCATE ON public.activity_log FROM anon, authenticated, service_role;

-- ---------- 3. Idempotent update retries (AC7) ----------

ALTER TABLE public.idempotency_records
  DROP CONSTRAINT idempotency_records_operation_check,
  ADD CONSTRAINT idempotency_records_operation_check CHECK (
    operation IN (
      'event.create_draft',
      'event.create_and_submit',
      'event.update_draft',
      'event.update_details'
    )
  );

-- ---------- 4. Before/after values for a history entry ----------

-- Keys are the API field names so history reads the same for every writer.
CREATE FUNCTION public._event_field_changes(p_before public.event, p_after public.event)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    jsonb_object_agg(
      f.api_name,
      jsonb_build_object('before', to_jsonb(p_before) -> f.column_name, 'after', to_jsonb(p_after) -> f.column_name)
    ),
    '{}'::jsonb
  )
    FROM (VALUES
      ('title', 'title'),
      ('purpose', 'purpose'),
      ('description', 'description'),
      ('start_datetime', 'startDatetime'),
      ('end_datetime', 'endDatetime'),
      ('expected_attendance', 'expectedAttendance'),
      ('preferred_layout_type', 'preferredLayoutType'),
      ('accessibility_needs', 'accessibilityNeeds'),
      ('is_registration_enabled', 'isRegistrationEnabled'),
      ('registration_capacity', 'registrationCapacity')
    ) AS f(column_name, api_name)
   WHERE (to_jsonb(p_before) -> f.column_name) IS DISTINCT FROM (to_jsonb(p_after) -> f.column_name);
$$;

-- ---------- 5. Draft saves: optional version check, retries, before/after ----------

DROP FUNCTION public.save_event_draft(integer, integer, jsonb, jsonb, jsonb, boolean, text, text);

CREATE FUNCTION public.save_event_draft(
  p_organiser_id integer,
  p_event_id integer,
  p_event jsonb,
  p_venue_preferences jsonb,
  p_equipment_requirements jsonb,
  p_is_auto_save boolean,
  p_idempotency_key text,
  p_request_hash text,
  p_expected_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_before public.event;
  v_before_requirements jsonb;
  v_after_requirements jsonb;
  v_operation text;
  v_action text;
  v_details text;
  v_changes jsonb;
  v_replay jsonb;
BEGIN
  IF jsonb_typeof(p_event) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_PATCH';
  END IF;

  PERFORM 1
    FROM public."user"
   WHERE user_id = p_organiser_id
     AND role = 'ORGANISER'
     AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  IF p_event_id IS NULL THEN
    v_operation := 'event.create_draft';
    IF p_idempotency_key IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
    END IF;
    v_replay := public._claim_idempotency_key(
      p_organiser_id, v_operation, p_idempotency_key, p_request_hash
    );
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;

    IF NULLIF(BTRIM(p_event->>'title'), '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'DRAFT_TITLE_REQUIRED';
    END IF;
    INSERT INTO public.event (
      organiser_id, title, purpose, description, start_datetime, end_datetime,
      expected_attendance, preferred_layout_type, accessibility_needs,
      is_registration_enabled, registration_capacity, status, updated_at
    ) VALUES (
      p_organiser_id,
      NULLIF(BTRIM(p_event->>'title'), ''),
      NULLIF(BTRIM(p_event->>'purpose'), ''),
      NULLIF(BTRIM(p_event->>'description'), ''),
      NULLIF(p_event->>'start_datetime', '')::timestamptz,
      NULLIF(p_event->>'end_datetime', '')::timestamptz,
      NULLIF(p_event->>'expected_attendance', '')::integer,
      NULLIF(BTRIM(p_event->>'preferred_layout_type'), ''),
      p_event->>'accessibility_needs',
      COALESCE(NULLIF(p_event->>'is_registration_enabled', '')::boolean, false),
      NULLIF(p_event->>'registration_capacity', '')::integer,
      'DRAFT', now()
    ) RETURNING * INTO v_event;
    v_action := 'DRAFT_CREATED';
    v_details := 'Event request saved as draft.';
  ELSE
    v_operation := 'event.update_draft';
    SELECT * INTO v_event
      FROM public.event
     WHERE event_id = p_event_id
       AND organiser_id = p_organiser_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
    END IF;

    -- A retry is answered after the ownership check but before the status and
    -- version checks, which the first attempt passed and has itself changed.
    IF p_idempotency_key IS NOT NULL THEN
      v_replay := public._claim_idempotency_key(
        p_organiser_id, v_operation, p_idempotency_key, p_request_hash
      );
      IF v_replay IS NOT NULL THEN
        RETURN v_replay;
      END IF;
    END IF;

    IF v_event.status <> 'DRAFT' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_DRAFT';
    END IF;
    IF p_expected_version IS NOT NULL AND v_event.version <> p_expected_version THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_VERSION_CONFLICT';
    END IF;

    v_before := v_event;
    v_before_requirements := public._event_response(v_event);

    -- Table constraints recheck the merged row under this lock, so a stale
    -- controller-side merge cannot store an invalid combination.
    UPDATE public.event AS e
       SET title = CASE WHEN p_event ? 'title' THEN NULLIF(BTRIM(p_event->>'title'), '') ELSE e.title END,
           purpose = CASE WHEN p_event ? 'purpose' THEN NULLIF(BTRIM(p_event->>'purpose'), '') ELSE e.purpose END,
           description = CASE WHEN p_event ? 'description' THEN NULLIF(BTRIM(p_event->>'description'), '') ELSE e.description END,
           start_datetime = CASE WHEN p_event ? 'start_datetime' THEN NULLIF(p_event->>'start_datetime', '')::timestamptz ELSE e.start_datetime END,
           end_datetime = CASE WHEN p_event ? 'end_datetime' THEN NULLIF(p_event->>'end_datetime', '')::timestamptz ELSE e.end_datetime END,
           expected_attendance = CASE WHEN p_event ? 'expected_attendance' THEN NULLIF(p_event->>'expected_attendance', '')::integer ELSE e.expected_attendance END,
           preferred_layout_type = CASE WHEN p_event ? 'preferred_layout_type' THEN NULLIF(BTRIM(p_event->>'preferred_layout_type'), '') ELSE e.preferred_layout_type END,
           accessibility_needs = CASE WHEN p_event ? 'accessibility_needs' THEN p_event->>'accessibility_needs' ELSE e.accessibility_needs END,
           is_registration_enabled = CASE WHEN p_event ? 'is_registration_enabled' THEN COALESCE(NULLIF(p_event->>'is_registration_enabled', '')::boolean, false) ELSE e.is_registration_enabled END,
           registration_capacity = CASE WHEN p_event ? 'registration_capacity' THEN NULLIF(p_event->>'registration_capacity', '')::integer ELSE e.registration_capacity END,
           updated_at = now()
     WHERE e.event_id = p_event_id
       AND e.organiser_id = p_organiser_id
       AND e.status = 'DRAFT'
     RETURNING * INTO v_event;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_DRAFT';
    END IF;
    v_action := 'DRAFT_UPDATED';
    v_details := 'Draft saved.';
  END IF;

  PERFORM public._replace_event_requirements(
    v_event.event_id,
    p_venue_preferences,
    p_equipment_requirements
  );

  -- Auto-saves are not history (SPM-37); a manual save records what it changed.
  IF p_event_id IS NULL OR NOT p_is_auto_save THEN
    IF p_event_id IS NOT NULL THEN
      v_changes := public._event_field_changes(v_before, v_event);
      v_after_requirements := public._event_response(v_event);
      IF v_before_requirements->'venue_preferences' IS DISTINCT FROM v_after_requirements->'venue_preferences' THEN
        v_changes := v_changes || jsonb_build_object('venuePreferences', jsonb_build_object(
          'before', v_before_requirements->'venue_preferences',
          'after', v_after_requirements->'venue_preferences'
        ));
      END IF;
      IF v_before_requirements->'equipment_requirements' IS DISTINCT FROM v_after_requirements->'equipment_requirements' THEN
        v_changes := v_changes || jsonb_build_object('equipmentRequirements', jsonb_build_object(
          'before', v_before_requirements->'equipment_requirements',
          'after', v_after_requirements->'equipment_requirements'
        ));
      END IF;
    END IF;
    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
    VALUES (p_organiser_id, 'event', v_event.event_id, v_action, v_details, 'ORGANISER', v_changes, 'ORGANISER_SAFE');
  END IF;

  RETURN public._store_idempotent_response(
    p_organiser_id, v_operation, p_idempotency_key, public._event_response(v_event)
  );
END;
$$;

-- ---------- 6. Assigned coordinator edits ordinary fields (AC4) ----------

-- p_editable_statuses is the backend's coordinator-edit allowlist (one constant in
-- config/eventConstants.js), so remapping statuses needs no migration. The
-- statuses that never allow a direct edit are refused here whatever is passed.
CREATE FUNCTION public.update_event_details(
  p_actor_id integer,
  p_event_id integer,
  p_changes jsonb,
  p_expected_version integer,
  p_editable_statuses text[],
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
  v_before public.event;
  v_title text;
  v_purpose text;
  v_description text;
  v_field text;
  v_limit integer;
  v_errors text[] := ARRAY[]::text[];
  v_replay jsonb;
BEGIN
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR p_expected_version IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_PATCH';
  END IF;
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  PERFORM 1
    FROM public."user"
   WHERE user_id = p_actor_id
     AND role = 'COORDINATOR'
     AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  -- Only the coordinator assigned right now. One reassigned away while this
  -- waited for the lock no longer matches and is told the event is not found.
  SELECT * INTO v_event
    FROM public.event
   WHERE event_id = p_event_id
     AND coordinator_id = p_actor_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  -- A retry is answered after the relationship check, so a stored result never
  -- reaches someone who lost access, but before the status and version checks.
  v_replay := public._claim_idempotency_key(
    p_actor_id, 'event.update_details', p_idempotency_key, p_request_hash
  );
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;

  IF v_event.status::text IN ('DRAFT', 'AWAITING_CLARIFICATION', 'COMPLETED', 'REJECTED', 'CANCELLED')
     OR p_editable_statuses IS NULL
     OR NOT (v_event.status::text = ANY (p_editable_statuses)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_EDITABLE_IN_STATUS';
  END IF;

  -- Any other key rejects the whole request; nothing is saved.
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_changes) AS k(name)
     WHERE k.name NOT IN ('title', 'purpose', 'description')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FIELD_NOT_EDITABLE';
  END IF;

  FOR v_field, v_limit IN
    SELECT * FROM (VALUES ('title', 200), ('purpose', 2000), ('description', 5000)) AS limits(field, max_length)
  LOOP
    CONTINUE WHEN NOT (p_changes ? v_field);
    IF jsonb_typeof(p_changes -> v_field) = 'null' OR BTRIM(p_changes ->> v_field) = '' THEN
      v_errors := array_append(v_errors, v_field || ':REQUIRED');
    ELSIF jsonb_typeof(p_changes -> v_field) <> 'string' THEN
      v_errors := array_append(v_errors, v_field || ':INVALID');
    ELSIF char_length(BTRIM(p_changes ->> v_field)) > v_limit THEN
      v_errors := array_append(v_errors, v_field || ':TOO_LONG');
    END IF;
  END LOOP;
  IF cardinality(v_errors) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'INVALID_EVENT_DETAILS',
      DETAIL = array_to_string(v_errors, ',');
  END IF;

  IF v_event.version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_VERSION_CONFLICT';
  END IF;

  v_title := CASE WHEN p_changes ? 'title' THEN BTRIM(p_changes->>'title') ELSE v_event.title END;
  v_purpose := CASE WHEN p_changes ? 'purpose' THEN BTRIM(p_changes->>'purpose') ELSE v_event.purpose END;
  v_description := CASE WHEN p_changes ? 'description' THEN BTRIM(p_changes->>'description') ELSE v_event.description END;

  -- Saving the values already stored changes nothing: no new version or history.
  IF v_title IS NOT DISTINCT FROM v_event.title::text
     AND v_purpose IS NOT DISTINCT FROM v_event.purpose
     AND v_description IS NOT DISTINCT FROM v_event.description THEN
    RETURN public._store_idempotent_response(
      p_actor_id, 'event.update_details', p_idempotency_key, public._event_response(v_event)
    );
  END IF;

  v_before := v_event;
  UPDATE public.event
     SET title = v_title,
         purpose = v_purpose,
         description = v_description,
         updated_at = now()
   WHERE event_id = p_event_id
   RETURNING * INTO v_event;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', v_event.event_id, 'EVENT_DETAILS_UPDATED', 'Event details updated.',
    'COORDINATOR', public._event_field_changes(v_before, v_event), 'ORGANISER_SAFE'
  );

  RETURN public._store_idempotent_response(
    p_actor_id, 'event.update_details', p_idempotency_key, public._event_response(v_event)
  );
END;
$$;

-- ---------- 7. Privileges ----------

REVOKE ALL ON FUNCTION public._bump_event_version() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._activity_log_defaults() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_field_changes(public.event, public.event) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.save_event_draft(integer, integer, jsonb, jsonb, jsonb, boolean, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_event_details(integer, integer, jsonb, integer, text[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_event_draft(integer, integer, jsonb, jsonb, jsonb, boolean, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_event_details(integer, integer, jsonb, integer, text[], text, text) TO service_role;
