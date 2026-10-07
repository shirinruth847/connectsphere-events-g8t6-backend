-- SPM-174: organiser submissions enter the lead's unassigned queue.
-- Keep assignment as a separate action so submitted requests are not
-- silently allocated by round robin.
DO $$
BEGIN
  ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'COORDINATOR_LEAD';
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.submit_event_request(
  p_organiser_id integer,
  p_event_id integer,
  p_event jsonb,
  p_venue_preferences jsonb,
  p_equipment_requirements jsonb,
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
  v_title text;
  v_purpose text;
  v_description text;
  v_start_datetime timestamptz;
  v_end_datetime timestamptz;
  v_expected_attendance integer;
  v_preferred_layout_type text;
  v_accessibility_needs text;
  v_is_registration_enabled boolean;
  v_registration_capacity integer;
  v_notification_id integer;
  v_request_id text;
  v_errors text[] := ARRAY[]::text[];
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
  v_start_datetime := CASE WHEN p_event ? 'start_datetime' THEN NULLIF(p_event->>'start_datetime', '')::timestamptz ELSE v_event.start_datetime END;
  v_end_datetime := CASE WHEN p_event ? 'end_datetime' THEN NULLIF(p_event->>'end_datetime', '')::timestamptz ELSE v_event.end_datetime END;
  v_expected_attendance := CASE WHEN p_event ? 'expected_attendance' THEN NULLIF(p_event->>'expected_attendance', '')::integer ELSE v_event.expected_attendance END;
  v_preferred_layout_type := CASE WHEN p_event ? 'preferred_layout_type' THEN NULLIF(BTRIM(p_event->>'preferred_layout_type'), '') ELSE v_event.preferred_layout_type END;
  v_accessibility_needs := CASE WHEN p_event ? 'accessibility_needs' THEN p_event->>'accessibility_needs' ELSE v_event.accessibility_needs END;
  v_is_registration_enabled := CASE WHEN p_event ? 'is_registration_enabled' THEN COALESCE(NULLIF(p_event->>'is_registration_enabled', '')::boolean, false) ELSE COALESCE(v_event.is_registration_enabled, false) END;
  v_registration_capacity := CASE WHEN p_event ? 'registration_capacity' THEN NULLIF(p_event->>'registration_capacity', '')::integer ELSE v_event.registration_capacity END;

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

  IF cardinality(v_errors) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'INVALID_EVENT_SUBMISSION',
      DETAIL = array_to_string(v_errors, ',');
  END IF;

  IF p_event_id IS NULL THEN
    INSERT INTO public.event (
      organiser_id, coordinator_id, title, purpose, description, start_datetime,
      end_datetime, expected_attendance, preferred_layout_type, accessibility_needs,
      is_registration_enabled, registration_capacity, status, updated_at
    ) VALUES (
      p_organiser_id, NULL, v_title, v_purpose, v_description,
      v_start_datetime, v_end_datetime, v_expected_attendance,
      v_preferred_layout_type, v_accessibility_needs, v_is_registration_enabled,
      v_registration_capacity, 'SUBMITTED', now()
    ) RETURNING * INTO v_event;
  ELSE
    UPDATE public.event
       SET coordinator_id = NULL,
           title = v_title,
           purpose = v_purpose,
           description = v_description,
           start_datetime = v_start_datetime,
           end_datetime = v_end_datetime,
           expected_attendance = v_expected_attendance,
           preferred_layout_type = v_preferred_layout_type,
           accessibility_needs = v_accessibility_needs,
           is_registration_enabled = v_is_registration_enabled,
           registration_capacity = v_registration_capacity,
           status = 'SUBMITTED',
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

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details)
  VALUES (
    p_organiser_id,
    'event',
    v_event.event_id,
    'EVENT_SUBMITTED',
    CASE WHEN p_event_id IS NULL
      THEN 'Event request created and submitted.'
      ELSE 'Draft submitted for review.'
    END
  );

  v_request_id := 'REQ-' || lpad(v_event.event_id::text, 6, '0');

  INSERT INTO public.notification (event_id, title, message, type)
  VALUES (
    v_event.event_id,
    'Event request received',
    format('Your event request "%s" (%s) has been submitted and is pending coordinator assignment.', v_event.title, v_request_id),
    'STATUS_CHANGE'
  )
  RETURNING notification_id INTO v_notification_id;
  INSERT INTO public.notification_recipient (notification_id, recipient_id)
  VALUES (v_notification_id, p_organiser_id);

  RETURN public._store_idempotent_response(
    p_organiser_id, 'event.create_and_submit', p_idempotency_key, public._event_response(v_event)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_event_request(integer, integer, jsonb, jsonb, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_event_request(integer, integer, jsonb, jsonb, jsonb, text, text) TO service_role;
