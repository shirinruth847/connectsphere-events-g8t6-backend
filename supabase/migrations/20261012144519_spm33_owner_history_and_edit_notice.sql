-- SPM-33 follow-up, from the review decisions of 2026-10-12:
--   1. History recorded while a request was a private draft is for its owner only.
--      Same-organisation organisers and the assigned coordinator see history from
--      submission onwards.
--   2. The owner is notified in-app when the assigned coordinator edits the event.
--
-- Both replaced functions keep their signatures, so privileges are unchanged.

-- ---------- 1. A third audience for history entries ----------

ALTER TABLE public.activity_log
  DROP CONSTRAINT activity_log_audience_check,
  ADD CONSTRAINT activity_log_audience_check
    CHECK (audience IN ('OWNER_ONLY', 'ORGANISER_SAFE', 'STAFF_ONLY'));

UPDATE public.activity_log
   SET audience = 'OWNER_ONLY'
 WHERE entity_name = 'event'
   AND action IN ('DRAFT_CREATED', 'DRAFT_UPDATED');

-- Fills what a writer leaves out. Draft entries default to the owner alone, the
-- submission and coordinator edits to organisers, and anything else to staff,
-- so a new kind of entry can never reach organisers by default.
CREATE OR REPLACE FUNCTION public._activity_log_defaults()
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
      WHEN NEW.entity_name = 'event' AND NEW.action IN ('DRAFT_CREATED', 'DRAFT_UPDATED')
      THEN 'OWNER_ONLY'
      WHEN NEW.entity_name = 'event' AND NEW.action IN ('EVENT_SUBMITTED', 'EVENT_DETAILS_UPDATED')
      THEN 'ORGANISER_SAFE'
      ELSE 'STAFF_ONLY'
    END;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------- 2. Draft saves write owner-only entries ----------
-- Identical to the previous definition except for the audience of the entry.

CREATE OR REPLACE FUNCTION public.save_event_draft(
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
  -- Draft entries are for the owner only: nobody else could see the draft, so
  -- nobody else may later read what it used to say.
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
    VALUES (p_organiser_id, 'event', v_event.event_id, v_action, v_details, 'ORGANISER', v_changes, 'OWNER_ONLY');
  END IF;

  RETURN public._store_idempotent_response(
    p_organiser_id, v_operation, p_idempotency_key, public._event_response(v_event)
  );
END;
$$;

-- ---------- 3. Coordinator edits notify the owner ----------
-- Identical to the previous definition except that it also writes the
-- notification, in the same transaction as the edit and its history entry.

CREATE OR REPLACE FUNCTION public.update_event_details(
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
  v_changes jsonb;
  v_changed_fields text;
  v_notification_id integer;
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

  v_changes := public._event_field_changes(v_before, v_event);
  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', v_event.event_id, 'EVENT_DETAILS_UPDATED', 'Event details updated.',
    'COORDINATOR', v_changes, 'ORGANISER_SAFE'
  );

  -- The owner is told which details changed, not the values; those are in the
  -- event's history. A retry or an unchanged save returns before this point, so
  -- it never sends a second notification.
  SELECT string_agg(f.field, ', ' ORDER BY f.position)
    INTO v_changed_fields
    FROM (VALUES ('title', 1), ('purpose', 2), ('description', 3)) AS f(field, position)
   WHERE v_changes ? f.field;
  INSERT INTO public.notification (event_id, title, message, type)
  VALUES (
    v_event.event_id,
    'Event details updated',
    format(
      'Your event coordinator updated the %s of event request REQ-%s. Open the request to see what changed.',
      v_changed_fields, lpad(v_event.event_id::text, 6, '0')
    ),
    'STATUS_CHANGE'
  )
  RETURNING notification_id INTO v_notification_id;
  INSERT INTO public.notification_recipient (notification_id, recipient_id)
  VALUES (v_notification_id, v_event.organiser_id);

  RETURN public._store_idempotent_response(
    p_actor_id, 'event.update_details', p_idempotency_key, public._event_response(v_event)
  );
END;
$$;
