-- SPM-35: the organiser sets the registration window on the event request
-- (create, draft, submit, clarification amendment). It reuses the SPM-134
-- columns registration_open_at / registration_close_at; no new columns.
--
-- Rebuilt from the LIVE definitions of 2026-11-01; only the window is added:
--   _event_field_changes          records registrationOpenAt / registrationCloseAt in history
--   save_event_draft              writes both columns on create and update
--   submit_event_request          writes both and checks them: required when
--                                 registration is enabled, close after open,
--                                 close no later than the event start
--   save_clarification_amendments accepts and writes both; an amended window
--                                 closes no later than the event start
-- Close after open is also the table's event_registration_window_check.

BEGIN;

CREATE OR REPLACE FUNCTION public._event_field_changes(p_before event, p_after event)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
      ('technical_support_needs', 'technicalSupportNeeds'),
      ('start_datetime', 'startDatetime'),
      ('end_datetime', 'endDatetime'),
      ('expected_attendance', 'expectedAttendance'),
      ('preferred_layout_type', 'preferredLayoutType'),
      ('accessibility_needs', 'accessibilityNeeds'),
      ('is_registration_enabled', 'isRegistrationEnabled'),
      ('registration_capacity', 'registrationCapacity'),
      ('registration_open_at', 'registrationOpenAt'),
      ('registration_close_at', 'registrationCloseAt')
    ) AS f(column_name, api_name)
   WHERE (to_jsonb(p_before) -> f.column_name) IS DISTINCT FROM (to_jsonb(p_after) -> f.column_name);
$function$;

CREATE OR REPLACE FUNCTION public.save_event_draft(p_organiser_id integer, p_event_id integer, p_event jsonb, p_venue_preferences jsonb, p_equipment_requirements jsonb, p_is_auto_save boolean, p_idempotency_key text, p_request_hash text, p_expected_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
  -- Reject non-text values as well as overlong input before any business write.
  IF p_event ? 'technical_support_needs' AND (
    jsonb_typeof(p_event->'technical_support_needs') NOT IN ('string', 'null')
    OR char_length(btrim(p_event->>'technical_support_needs')) > 2000
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_SUBMISSION',
      DETAIL = 'technicalSupportNeeds:INVALID';
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
      organiser_id, title, purpose, description, technical_support_needs, start_datetime, end_datetime,
      expected_attendance, preferred_layout_type, accessibility_needs,
      is_registration_enabled, registration_capacity, registration_open_at, registration_close_at,
      status, updated_at
    ) VALUES (
      p_organiser_id,
      NULLIF(BTRIM(p_event->>'title'), ''),
      NULLIF(BTRIM(p_event->>'purpose'), ''),
      NULLIF(BTRIM(p_event->>'description'), ''),
      NULLIF(BTRIM(p_event->>'technical_support_needs'), ''),
      NULLIF(p_event->>'start_datetime', '')::timestamptz,
      NULLIF(p_event->>'end_datetime', '')::timestamptz,
      NULLIF(p_event->>'expected_attendance', '')::integer,
      NULLIF(BTRIM(p_event->>'preferred_layout_type'), ''),
      p_event->>'accessibility_needs',
      COALESCE(NULLIF(p_event->>'is_registration_enabled', '')::boolean, false),
      NULLIF(p_event->>'registration_capacity', '')::integer,
      NULLIF(p_event->>'registration_open_at', '')::timestamptz,
      NULLIF(p_event->>'registration_close_at', '')::timestamptz,
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
           technical_support_needs = CASE WHEN p_event ? 'technical_support_needs' THEN NULLIF(BTRIM(p_event->>'technical_support_needs'), '') ELSE e.technical_support_needs END,
           start_datetime = CASE WHEN p_event ? 'start_datetime' THEN NULLIF(p_event->>'start_datetime', '')::timestamptz ELSE e.start_datetime END,
           end_datetime = CASE WHEN p_event ? 'end_datetime' THEN NULLIF(p_event->>'end_datetime', '')::timestamptz ELSE e.end_datetime END,
           expected_attendance = CASE WHEN p_event ? 'expected_attendance' THEN NULLIF(p_event->>'expected_attendance', '')::integer ELSE e.expected_attendance END,
           preferred_layout_type = CASE WHEN p_event ? 'preferred_layout_type' THEN NULLIF(BTRIM(p_event->>'preferred_layout_type'), '') ELSE e.preferred_layout_type END,
           accessibility_needs = CASE WHEN p_event ? 'accessibility_needs' THEN p_event->>'accessibility_needs' ELSE e.accessibility_needs END,
           is_registration_enabled = CASE WHEN p_event ? 'is_registration_enabled' THEN COALESCE(NULLIF(p_event->>'is_registration_enabled', '')::boolean, false) ELSE e.is_registration_enabled END,
           registration_capacity = CASE WHEN p_event ? 'registration_capacity' THEN NULLIF(p_event->>'registration_capacity', '')::integer ELSE e.registration_capacity END,
           registration_open_at = CASE WHEN p_event ? 'registration_open_at' THEN NULLIF(p_event->>'registration_open_at', '')::timestamptz ELSE e.registration_open_at END,
           registration_close_at = CASE WHEN p_event ? 'registration_close_at' THEN NULLIF(p_event->>'registration_close_at', '')::timestamptz ELSE e.registration_close_at END,
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
$function$;

CREATE OR REPLACE FUNCTION public.submit_event_request(p_organiser_id integer, p_event_id integer, p_event jsonb, p_venue_preferences jsonb, p_equipment_requirements jsonb, p_idempotency_key text, p_request_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_event public.event;
  v_title text;
  v_purpose text;
  v_description text;
  v_technical_support_needs text;
  v_start_datetime timestamptz;
  v_end_datetime timestamptz;
  v_expected_attendance integer;
  v_preferred_layout_type text;
  v_accessibility_needs text;
  v_is_registration_enabled boolean;
  v_registration_capacity integer;
  v_registration_open_at timestamptz;
  v_registration_close_at timestamptz;
  v_request_id text;
  v_errors text[] := ARRAY[]::text[];
  v_replay jsonb;
BEGIN
  IF jsonb_typeof(p_event) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_PATCH';
  END IF;
  -- Reject non-text values as well as overlong input before any business write.
  IF p_event ? 'technical_support_needs' AND (
    jsonb_typeof(p_event->'technical_support_needs') NOT IN ('string', 'null')
    OR char_length(btrim(p_event->>'technical_support_needs')) > 2000
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_SUBMISSION',
      DETAIL = 'technicalSupportNeeds:INVALID';
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
    IF p_idempotency_key IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
    END IF;
    v_replay := public._claim_idempotency_key(
      p_organiser_id, 'event.create_and_submit', p_idempotency_key, p_request_hash
    );
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  ELSE
    SELECT * INTO v_event
      FROM public.event
     WHERE event_id = p_event_id
       AND organiser_id = p_organiser_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
    END IF;
    IF v_event.status <> 'DRAFT' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_DRAFT';
    END IF;
  END IF;

  v_title := CASE WHEN p_event ? 'title' THEN NULLIF(BTRIM(p_event->>'title'), '') ELSE v_event.title END;
  v_purpose := CASE WHEN p_event ? 'purpose' THEN NULLIF(BTRIM(p_event->>'purpose'), '') ELSE v_event.purpose END;
  v_description := CASE WHEN p_event ? 'description' THEN NULLIF(BTRIM(p_event->>'description'), '') ELSE v_event.description END;
  v_technical_support_needs := CASE WHEN p_event ? 'technical_support_needs' THEN NULLIF(BTRIM(p_event->>'technical_support_needs'), '') ELSE v_event.technical_support_needs END;
  v_start_datetime := CASE WHEN p_event ? 'start_datetime' THEN NULLIF(p_event->>'start_datetime', '')::timestamptz ELSE v_event.start_datetime END;
  v_end_datetime := CASE WHEN p_event ? 'end_datetime' THEN NULLIF(p_event->>'end_datetime', '')::timestamptz ELSE v_event.end_datetime END;
  v_expected_attendance := CASE WHEN p_event ? 'expected_attendance' THEN NULLIF(p_event->>'expected_attendance', '')::integer ELSE v_event.expected_attendance END;
  v_preferred_layout_type := CASE WHEN p_event ? 'preferred_layout_type' THEN NULLIF(BTRIM(p_event->>'preferred_layout_type'), '') ELSE v_event.preferred_layout_type END;
  v_accessibility_needs := CASE WHEN p_event ? 'accessibility_needs' THEN p_event->>'accessibility_needs' ELSE v_event.accessibility_needs END;
  v_is_registration_enabled := CASE WHEN p_event ? 'is_registration_enabled' THEN COALESCE(NULLIF(p_event->>'is_registration_enabled', '')::boolean, false) ELSE COALESCE(v_event.is_registration_enabled, false) END;
  v_registration_capacity := CASE WHEN p_event ? 'registration_capacity' THEN NULLIF(p_event->>'registration_capacity', '')::integer ELSE v_event.registration_capacity END;
  v_registration_open_at := CASE WHEN p_event ? 'registration_open_at' THEN NULLIF(p_event->>'registration_open_at', '')::timestamptz ELSE v_event.registration_open_at END;
  v_registration_close_at := CASE WHEN p_event ? 'registration_close_at' THEN NULLIF(p_event->>'registration_close_at', '')::timestamptz ELSE v_event.registration_close_at END;

  IF v_title IS NULL THEN v_errors := array_append(v_errors, 'title:REQUIRED'); END IF;
  IF v_purpose IS NULL THEN v_errors := array_append(v_errors, 'purpose:REQUIRED'); END IF;
  IF v_description IS NULL THEN v_errors := array_append(v_errors, 'description:REQUIRED'); END IF;
  IF v_start_datetime IS NULL THEN
    v_errors := array_append(v_errors, 'startDatetime:REQUIRED');
  ELSIF v_start_datetime < now() + interval '48 hours' THEN
    v_errors := array_append(v_errors, 'startDatetime:LEAD_TIME');
  END IF;
  IF v_end_datetime IS NULL THEN
    v_errors := array_append(v_errors, 'endDatetime:REQUIRED');
  ELSIF v_start_datetime IS NOT NULL AND v_end_datetime <= v_start_datetime THEN
    v_errors := array_append(v_errors, 'endDatetime:END_BEFORE_START');
  END IF;
  IF v_expected_attendance IS NULL THEN
    v_errors := array_append(v_errors, 'expectedAttendance:REQUIRED');
  ELSIF v_expected_attendance <= 0 THEN
    v_errors := array_append(v_errors, 'expectedAttendance:INVALID');
  END IF;
  IF v_preferred_layout_type IS NULL THEN
    v_errors := array_append(v_errors, 'preferredLayoutType:REQUIRED');
  ELSIF v_preferred_layout_type <> 'NO_PREFERENCE' AND NOT EXISTS (
    SELECT 1 FROM public.room WHERE layout_type = v_preferred_layout_type
  ) THEN
    v_errors := array_append(v_errors, 'preferredLayoutType:INVALID');
  END IF;
  IF v_is_registration_enabled AND v_registration_capacity IS NULL THEN
    v_errors := array_append(v_errors, 'registrationCapacity:REQUIRED');
  ELSIF v_registration_capacity IS NOT NULL AND v_registration_capacity <= 0 THEN
    v_errors := array_append(v_errors, 'registrationCapacity:INVALID');
  END IF;
  -- SPM-35: registration runs [open, close) and closes by the event start.
  IF v_is_registration_enabled AND v_registration_open_at IS NULL THEN
    v_errors := array_append(v_errors, 'registrationOpenAt:REQUIRED');
  END IF;
  IF v_is_registration_enabled AND v_registration_close_at IS NULL THEN
    v_errors := array_append(v_errors, 'registrationCloseAt:REQUIRED');
  ELSIF v_registration_open_at IS NOT NULL AND v_registration_close_at <= v_registration_open_at THEN
    v_errors := array_append(v_errors, 'registrationCloseAt:BEFORE_OPEN');
  ELSIF v_start_datetime IS NOT NULL AND v_registration_close_at > v_start_datetime THEN
    v_errors := array_append(v_errors, 'registrationCloseAt:AFTER_START');
  END IF;

  IF cardinality(v_errors) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'INVALID_EVENT_SUBMISSION',
      DETAIL = array_to_string(v_errors, ',');
  END IF;

  IF p_event_id IS NULL THEN
    INSERT INTO public.event (
      organiser_id, coordinator_id, title, purpose, description, technical_support_needs, start_datetime,
      end_datetime, expected_attendance, preferred_layout_type, accessibility_needs,
      is_registration_enabled, registration_capacity, registration_open_at, registration_close_at,
      status, updated_at
    ) VALUES (
      p_organiser_id, NULL, v_title, v_purpose, v_description, v_technical_support_needs,
      v_start_datetime, v_end_datetime, v_expected_attendance,
      v_preferred_layout_type, v_accessibility_needs, v_is_registration_enabled,
      v_registration_capacity, v_registration_open_at, v_registration_close_at,
      'DRAFT', now()
    ) RETURNING * INTO v_event;
  ELSE
    UPDATE public.event
       SET coordinator_id = NULL,
           title = v_title,
           purpose = v_purpose,
           description = v_description,
           technical_support_needs = v_technical_support_needs,
           start_datetime = v_start_datetime,
           end_datetime = v_end_datetime,
           expected_attendance = v_expected_attendance,
           preferred_layout_type = v_preferred_layout_type,
           accessibility_needs = v_accessibility_needs,
           is_registration_enabled = v_is_registration_enabled,
           registration_capacity = v_registration_capacity,
           registration_open_at = v_registration_open_at,
           registration_close_at = v_registration_close_at,
           updated_at = now()
     WHERE event_id = p_event_id
       AND organiser_id = p_organiser_id
       AND status = 'DRAFT'
     RETURNING * INTO v_event;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_DRAFT';
    END IF;
  END IF;

  PERFORM public._replace_event_requirements(
    v_event.event_id,
    p_venue_preferences,
    p_equipment_requirements
  );

  PERFORM public._check_event_transition(v_event, 'submit', p_organiser_id, NULL);
  v_event := public._apply_event_transition(
    v_event,
    'submit',
    p_organiser_id,
    CASE WHEN p_event_id IS NULL
      THEN 'Event request created and submitted.'
      ELSE 'Draft submitted for review.'
    END
  );

  v_request_id := 'REQ-' || lpad(v_event.event_id::text, 6, '0');

  -- SPM-36: one receipt shared by the organiser and every active Coordinator Lead.
  PERFORM public._notify_event_users(
    v_event.event_id,
    'Event request received',
    format('Event request "%s" (%s) has been submitted and is awaiting assignment by the Coordinator Lead.', v_event.title, v_request_id),
    array_prepend(p_organiser_id, public._active_users_with_role('COORDINATOR_LEAD'))
  );

  RETURN public._store_idempotent_response(
    p_organiser_id, 'event.create_and_submit', p_idempotency_key, public._event_response(v_event)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_clarification_amendments(p_event_id integer, p_actor_id integer, p_expected_version integer, p_changes jsonb, p_venue_preferences jsonb, p_equipment_requirements jsonb, p_idempotency_key text, p_request_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_operation constant text := 'event.save_amendments';
  v_changes_in jsonb := COALESCE(p_changes, '{}'::jsonb);
  v_event public.event;
  v_before public.event;
  v_before_requirements jsonb;
  v_after_requirements jsonb;
  v_changes jsonb;
  v_round public.clarifications;
  v_replay jsonb;
BEGIN
  IF jsonb_typeof(v_changes_in) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_PATCH';
  END IF;
  -- Reject non-text values as well as overlong input before any business write.
  IF v_changes_in ? 'technical_support_needs' AND (
    jsonb_typeof(v_changes_in->'technical_support_needs') NOT IN ('string', 'null')
    OR char_length(btrim(v_changes_in->>'technical_support_needs')) > 2000
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_SUBMISSION',
      DETAIL = 'technicalSupportNeeds:INVALID';
  END IF;


  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_actor_id, v_operation, p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  -- Same order as _check_event_transition: relationship, version, state.
  IF public._clarification_party(v_event, p_actor_id) <> 'OWNER' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version <> v_event.version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_VERSION_CONFLICT', DETAIL = v_event.status::text;
  END IF;
  IF v_event.status <> 'AWAITING_CLARIFICATION' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TRANSITION_NOT_ALLOWED', DETAIL = v_event.status::text;
  END IF;

  SELECT * INTO v_round FROM public.clarifications
   WHERE event_id = p_event_id AND status = 'OPEN'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CLARIFICATION_NOT_OPEN';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_changes_in) AS k(name)
     WHERE k.name NOT IN (
       'title', 'purpose', 'description', 'start_datetime', 'end_datetime',
       'expected_attendance', 'preferred_layout_type', 'accessibility_needs', 'technical_support_needs',
       'registration_open_at', 'registration_close_at'
     )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FIELD_NOT_EDITABLE';
  END IF;

  v_before := v_event;
  v_before_requirements := public._event_response(v_event);

  IF v_changes_in <> '{}'::jsonb THEN
    UPDATE public.event AS e
       SET title = CASE WHEN v_changes_in ? 'title' THEN NULLIF(btrim(v_changes_in->>'title'), '') ELSE e.title END,
           purpose = CASE WHEN v_changes_in ? 'purpose' THEN NULLIF(btrim(v_changes_in->>'purpose'), '') ELSE e.purpose END,
           description = CASE WHEN v_changes_in ? 'description' THEN NULLIF(btrim(v_changes_in->>'description'), '') ELSE e.description END,
           technical_support_needs = CASE WHEN v_changes_in ? 'technical_support_needs' THEN NULLIF(btrim(v_changes_in->>'technical_support_needs'), '') ELSE e.technical_support_needs END,
           start_datetime = CASE WHEN v_changes_in ? 'start_datetime' THEN NULLIF(v_changes_in->>'start_datetime', '')::timestamptz ELSE e.start_datetime END,
           end_datetime = CASE WHEN v_changes_in ? 'end_datetime' THEN NULLIF(v_changes_in->>'end_datetime', '')::timestamptz ELSE e.end_datetime END,
           expected_attendance = CASE WHEN v_changes_in ? 'expected_attendance' THEN NULLIF(v_changes_in->>'expected_attendance', '')::integer ELSE e.expected_attendance END,
           preferred_layout_type = CASE WHEN v_changes_in ? 'preferred_layout_type' THEN NULLIF(btrim(v_changes_in->>'preferred_layout_type'), '') ELSE e.preferred_layout_type END,
           accessibility_needs = CASE WHEN v_changes_in ? 'accessibility_needs' THEN v_changes_in->>'accessibility_needs' ELSE e.accessibility_needs END,
           registration_open_at = CASE WHEN v_changes_in ? 'registration_open_at' THEN NULLIF(v_changes_in->>'registration_open_at', '')::timestamptz ELSE e.registration_open_at END,
           registration_close_at = CASE WHEN v_changes_in ? 'registration_close_at' THEN NULLIF(v_changes_in->>'registration_close_at', '')::timestamptz ELSE e.registration_close_at END,
           updated_at = now()
     WHERE e.event_id = p_event_id
     RETURNING * INTO v_event;
  END IF;
  PERFORM public._replace_event_requirements(p_event_id, p_venue_preferences, p_equipment_requirements);

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

  -- Saving the stored values again is not an amendment; raising undoes the rewrite.
  IF v_changes = '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AMENDMENT_EMPTY';
  END IF;

  -- Still a complete submission (Master 5.2); end after start is the table's
  -- event_datetime_order_check.
  IF NULLIF(btrim(v_event.title), '') IS NULL
     OR v_event.purpose IS NULL
     OR v_event.description IS NULL
     OR v_event.start_datetime IS NULL
     OR v_event.end_datetime IS NULL
     OR COALESCE(v_event.expected_attendance, 0) <= 0
     OR v_event.preferred_layout_type IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_PATCH';
  END IF;
  -- The 48-hour lead time applies only to a newly chosen start (team decision, 2026-10-24).
  IF v_changes ? 'startDatetime' AND v_event.start_datetime < now() + interval '48 hours' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_PATCH';
  END IF;
  -- SPM-35: an amended window closes by the event start (close after open is
  -- event_registration_window_check). Events saved without one are not rechecked.
  IF (v_changes_in ? 'registration_open_at' OR v_changes_in ? 'registration_close_at')
     AND v_event.registration_close_at > v_event.start_datetime THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_SUBMISSION',
      DETAIL = 'registrationCloseAt:AFTER_START';
  END IF;

  -- Requirement-only amendments still move the version, so the coordinator's
  -- completion (which checks the version) cannot miss them.
  IF v_changes_in = '{}'::jsonb THEN
    UPDATE public.event SET updated_at = now() WHERE event_id = p_event_id RETURNING * INTO v_event;
  END IF;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', p_event_id, 'CLARIFICATION_AMENDED',
    format('Request amended during clarification Request %s.', v_round.round_number),
    'ORGANISER', v_changes, 'ORGANISER_SAFE'
  );

  PERFORM public._notify_clarification_party(
    v_round,
    v_event.coordinator_id,
    'Event request amended',
    format(
      'The organiser amended event request REQ-%s "%s" during Request %s. Open the request to see what changed.',
      lpad(p_event_id::text, 6, '0'), v_event.title, v_round.round_number
    )
  );

  RETURN public._store_idempotent_response(p_actor_id, v_operation, p_idempotency_key, public._event_response(v_event));
END;
$function$;

COMMIT;
