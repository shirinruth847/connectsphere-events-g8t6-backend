ALTER TYPE public.event_status
  ADD VALUE IF NOT EXISTS 'AWAITING_CLARIFICATION' AFTER 'UNDER_REVIEW';

ALTER TABLE public.event
  ADD CONSTRAINT event_expected_attendance_positive_check
    CHECK (expected_attendance IS NULL OR expected_attendance > 0),
  ADD CONSTRAINT event_registration_capacity_positive_check
    CHECK (registration_capacity IS NULL OR registration_capacity > 0),
  ADD CONSTRAINT event_registration_enabled_capacity_check
    CHECK (NOT is_registration_enabled OR registration_capacity IS NOT NULL),
  ADD CONSTRAINT event_datetime_order_check
    CHECK (start_datetime IS NULL OR end_datetime IS NULL OR end_datetime > start_datetime),
  ADD CONSTRAINT event_submitted_coordinator_check
    CHECK (status <> 'SUBMITTED' OR coordinator_id IS NOT NULL),
  ADD CONSTRAINT event_submitted_fields_check
    CHECK (
      status <> 'SUBMITTED'
      OR (
        NULLIF(BTRIM(title), '') IS NOT NULL
        AND NULLIF(BTRIM(purpose), '') IS NOT NULL
        AND NULLIF(BTRIM(description), '') IS NOT NULL
        AND start_datetime IS NOT NULL
        AND end_datetime IS NOT NULL
        AND expected_attendance IS NOT NULL
        AND preferred_layout_type IS NOT NULL
      )
    );

CREATE TABLE public.staff_assignment_cursors (
  cursor_name text PRIMARY KEY,
  last_user_id integer REFERENCES public."user" (user_id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.event_venue_preference (
  event_id integer NOT NULL REFERENCES public.event (event_id) ON DELETE RESTRICT,
  venue_id integer NOT NULL REFERENCES public.venue (venue_id) ON DELETE RESTRICT,
  preference_order integer NOT NULL CHECK (preference_order > 0),
  PRIMARY KEY (event_id, venue_id),
  UNIQUE (event_id, preference_order)
);

CREATE TABLE public.event_equipment_requirement (
  event_id integer NOT NULL REFERENCES public.event (event_id) ON DELETE RESTRICT,
  equipment_id integer NOT NULL REFERENCES public.equipment (equipment_id) ON DELETE RESTRICT,
  quantity_requested integer NOT NULL CHECK (quantity_requested > 0),
  PRIMARY KEY (event_id, equipment_id)
);

ALTER TABLE public.staff_assignment_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_venue_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_equipment_requirement ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.staff_assignment_cursors,
  public.event_venue_preference,
  public.event_equipment_requirement
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_venue_preference,
  public.event_equipment_requirement TO service_role;

CREATE INDEX event_venue_preference_venue_idx
  ON public.event_venue_preference (venue_id);
CREATE INDEX event_equipment_requirement_equipment_idx
  ON public.event_equipment_requirement (equipment_id);
CREATE INDEX event_organiser_updated_cursor_idx
  ON public.event (organiser_id, updated_at DESC, event_id DESC);
CREATE INDEX event_organiser_status_updated_cursor_idx
  ON public.event (organiser_id, status, updated_at DESC, event_id DESC);

CREATE OR REPLACE FUNCTION public._next_event_coordinator()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_last_user_id integer;
  v_coordinator_id integer;
BEGIN
  INSERT INTO public.staff_assignment_cursors (cursor_name)
  VALUES ('event_submission')
  ON CONFLICT (cursor_name) DO NOTHING;

  SELECT last_user_id
    INTO v_last_user_id
    FROM public.staff_assignment_cursors
   WHERE cursor_name = 'event_submission'
   FOR UPDATE;

  SELECT user_id
    INTO v_coordinator_id
    FROM public."user"
   WHERE role = 'COORDINATOR'
     AND is_active
     AND (v_last_user_id IS NULL OR user_id > v_last_user_id)
   ORDER BY user_id
   LIMIT 1;

  IF v_coordinator_id IS NULL THEN
    SELECT user_id
      INTO v_coordinator_id
      FROM public."user"
     WHERE role = 'COORDINATOR'
       AND is_active
     ORDER BY user_id
     LIMIT 1;
  END IF;

  IF v_coordinator_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NO_ELIGIBLE_COORDINATOR';
  END IF;

  UPDATE public.staff_assignment_cursors
     SET last_user_id = v_coordinator_id,
         updated_at = now()
   WHERE cursor_name = 'event_submission';

  RETURN v_coordinator_id;
END;
$$;

CREATE OR REPLACE FUNCTION public._replace_event_requirements(
  p_event_id integer,
  p_venue_preferences jsonb,
  p_equipment_requirements jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_item record;
  v_venue_id integer;
  v_equipment_id integer;
  v_quantity integer;
BEGIN
  IF p_venue_preferences IS NOT NULL THEN
    IF jsonb_typeof(p_venue_preferences) <> 'array' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_PREFERENCES';
    END IF;

    DELETE FROM public.event_venue_preference WHERE event_id = p_event_id;
    FOR v_item IN
      SELECT value, ordinality
        FROM jsonb_array_elements(p_venue_preferences) WITH ORDINALITY AS items(value, ordinality)
    LOOP
      IF jsonb_typeof(v_item.value) <> 'number' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_PREFERENCES';
      END IF;
      v_venue_id := (v_item.value #>> '{}')::integer;
      INSERT INTO public.event_venue_preference (event_id, venue_id, preference_order)
      VALUES (p_event_id, v_venue_id, v_item.ordinality::integer);
    END LOOP;
  END IF;

  IF p_equipment_requirements IS NOT NULL THEN
    IF jsonb_typeof(p_equipment_requirements) <> 'array' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EQUIPMENT_REQUIREMENTS';
    END IF;

    DELETE FROM public.event_equipment_requirement WHERE event_id = p_event_id;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_equipment_requirements) AS items(value)
    LOOP
      IF jsonb_typeof(v_item.value) <> 'object'
         OR NOT (v_item.value ? 'equipment_id')
         OR NOT (v_item.value ? 'quantity') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EQUIPMENT_REQUIREMENTS';
      END IF;
      v_equipment_id := (v_item.value->>'equipment_id')::integer;
      v_quantity := (v_item.value->>'quantity')::integer;
      INSERT INTO public.event_equipment_requirement (event_id, equipment_id, quantity_requested)
      VALUES (p_event_id, v_equipment_id, v_quantity);
    END LOOP;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._event_response(p_event public.event)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'event', to_jsonb(p_event),
    'venue_preferences', COALESCE((
      SELECT jsonb_agg(venue_id ORDER BY preference_order)
        FROM public.event_venue_preference
       WHERE event_id = p_event.event_id
    ), '[]'::jsonb),
    'equipment_requirements', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('equipment_id', equipment_id, 'quantity', quantity_requested)
        ORDER BY equipment_id
      )
        FROM public.event_equipment_requirement
       WHERE event_id = p_event.event_id
    ), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.save_event_draft(
  p_organiser_id integer,
  p_event_id integer,
  p_event jsonb,
  p_venue_preferences jsonb,
  p_equipment_requirements jsonb,
  p_is_auto_save boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_action text;
  v_details text;
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

  IF p_event_id IS NULL OR NOT p_is_auto_save THEN
    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details)
    VALUES (p_organiser_id, 'event', v_event.event_id, v_action, v_details);
  END IF;

  RETURN public._event_response(v_event);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_event_request(
  p_organiser_id integer,
  p_event_id integer,
  p_event jsonb,
  p_venue_preferences jsonb,
  p_equipment_requirements jsonb
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
  v_coordinator_id integer;
  v_notification_id integer;
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

  IF p_event_id IS NOT NULL THEN
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

  IF v_title IS NULL OR v_purpose IS NULL OR v_description IS NULL
     OR v_start_datetime IS NULL OR v_end_datetime IS NULL
     OR v_expected_attendance IS NULL OR v_preferred_layout_type IS NULL
     OR v_expected_attendance <= 0
     OR v_end_datetime <= v_start_datetime
     OR v_start_datetime < now() + interval '48 hours'
     OR (v_is_registration_enabled AND (v_registration_capacity IS NULL OR v_registration_capacity <= 0))
     OR (v_preferred_layout_type <> 'NO_PREFERENCE' AND NOT EXISTS (
       SELECT 1 FROM public.room WHERE layout_type = v_preferred_layout_type
     )) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_SUBMISSION';
  END IF;

  v_coordinator_id := public._next_event_coordinator();

  IF p_event_id IS NULL THEN
    INSERT INTO public.event (
      organiser_id, coordinator_id, title, purpose, description, start_datetime,
      end_datetime, expected_attendance, preferred_layout_type, accessibility_needs,
      is_registration_enabled, registration_capacity, status, updated_at
    ) VALUES (
      p_organiser_id, v_coordinator_id, v_title, v_purpose, v_description,
      v_start_datetime, v_end_datetime, v_expected_attendance,
      v_preferred_layout_type, v_accessibility_needs, v_is_registration_enabled,
      v_registration_capacity, 'SUBMITTED', now()
    ) RETURNING * INTO v_event;
  ELSE
    UPDATE public.event
       SET coordinator_id = v_coordinator_id,
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

  INSERT INTO public.notification (event_id, title, message, type)
  VALUES (
    v_event.event_id,
    'Event request received',
    format(
      'Your event request "%s" (REQ-%s) has been submitted and is pending approval.',
      v_event.title,
      lpad(v_event.event_id::text, 6, '0')
    ),
    'STATUS_CHANGE'
  )
  RETURNING notification_id INTO v_notification_id;

  INSERT INTO public.notification_recipient (notification_id, recipient_id)
  VALUES
    (v_notification_id, p_organiser_id),
    (v_notification_id, v_coordinator_id)
  ON CONFLICT (notification_id, recipient_id) DO NOTHING;

  RETURN public._event_response(v_event);
END;
$$;

REVOKE ALL ON FUNCTION public._next_event_coordinator() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._replace_event_requirements(integer, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_response(public.event) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.save_event_draft(integer, integer, jsonb, jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_event_request(integer, integer, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_event_draft(integer, integer, jsonb, jsonb, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_event_request(integer, integer, jsonb, jsonb, jsonb) TO service_role;