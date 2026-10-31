-- SPM-76: each venue the organiser chooses may carry the time they would like
-- it for (Master 5.4.2, T36). A choice is still a preference: it never holds or
-- books the venue. NULL times mean the whole event, so a choice the organiser
-- never narrowed follows the event when its dates change.
--
-- _replace_event_requirements accepts a bare venue ID (the whole event) or
-- {"venue_id", "requested_start", "requested_end"}. Every caller updates the
-- event row first, so each stored time is checked against the event's saved
-- start and end, including when only the event's dates changed. A time equal
-- to the whole event is stored as NULL.
--
-- _event_response keeps a whole-event choice as a bare venue ID and returns a
-- narrowed one as an object, so edit history compares the same values as
-- before this migration and still records a change of time.

ALTER TABLE public.event_venue_preference
  ADD COLUMN requested_start timestamptz,
  ADD COLUMN requested_end timestamptz,
  ADD CONSTRAINT event_venue_preference_requested_window_check CHECK (
    (requested_start IS NULL AND requested_end IS NULL)
    OR (requested_start IS NOT NULL AND requested_end IS NOT NULL AND requested_start < requested_end)
  );

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
  v_requested_start timestamptz;
  v_requested_end timestamptz;
  v_event_start timestamptz;
  v_event_end timestamptz;
  v_equipment_id integer;
  v_quantity integer;
  v_existing_equipment integer[];
BEGIN
  SELECT start_datetime, end_datetime
    INTO v_event_start, v_event_end
    FROM public.event
   WHERE event_id = p_event_id;

  IF p_venue_preferences IS NOT NULL THEN
    IF jsonb_typeof(p_venue_preferences) <> 'array' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_PREFERENCES';
    END IF;

    DELETE FROM public.event_venue_preference WHERE event_id = p_event_id;
    FOR v_item IN
      SELECT value, ordinality
        FROM jsonb_array_elements(p_venue_preferences) WITH ORDINALITY AS items(value, ordinality)
    LOOP
      v_requested_start := NULL;
      v_requested_end := NULL;
      IF jsonb_typeof(v_item.value) = 'number' THEN
        v_venue_id := (v_item.value #>> '{}')::integer;
      ELSIF jsonb_typeof(v_item.value) = 'object'
            AND jsonb_typeof(v_item.value->'venue_id') = 'number'
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_object_keys(v_item.value) AS keys(key)
               WHERE key NOT IN ('venue_id', 'requested_start', 'requested_end')
            ) THEN
        v_venue_id := (v_item.value->>'venue_id')::integer;
        v_requested_start := NULLIF(v_item.value->>'requested_start', '')::timestamptz;
        v_requested_end := NULLIF(v_item.value->>'requested_end', '')::timestamptz;
        IF (v_requested_start IS NULL) <> (v_requested_end IS NULL) THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_PREFERENCES';
        END IF;
        IF v_requested_start = v_event_start AND v_requested_end = v_event_end THEN
          v_requested_start := NULL;
          v_requested_end := NULL;
        END IF;
      ELSE
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_PREFERENCES';
      END IF;
      INSERT INTO public.event_venue_preference (event_id, venue_id, preference_order, requested_start, requested_end)
      VALUES (p_event_id, v_venue_id, v_item.ordinality::integer, v_requested_start, v_requested_end);
    END LOOP;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.event_venue_preference
     WHERE event_id = p_event_id
       AND requested_start IS NOT NULL
       AND (v_event_start IS NULL OR v_event_end IS NULL
            OR requested_start < v_event_start OR requested_end > v_event_end)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_PREFERENCE_OUTSIDE_EVENT';
  END IF;

  IF p_equipment_requirements IS NOT NULL THEN
    IF jsonb_typeof(p_equipment_requirements) <> 'array' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EQUIPMENT_REQUIREMENTS';
    END IF;

    SELECT coalesce(array_agg(equipment_id), '{}')
      INTO v_existing_equipment
      FROM public.event_equipment_requirement
     WHERE event_id = p_event_id;

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
      IF NOT (v_equipment_id = ANY (v_existing_equipment)) THEN
        PERFORM 1
          FROM public.equipment
         WHERE equipment_id = v_equipment_id
           AND is_active
           AND NOT details_pending
           FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EQUIPMENT_REQUIREMENTS';
        END IF;
      END IF;
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
      SELECT jsonb_agg(
        CASE WHEN requested_start IS NULL THEN to_jsonb(venue_id)
             ELSE jsonb_build_object('venue_id', venue_id, 'requested_start', requested_start, 'requested_end', requested_end)
        END
        ORDER BY preference_order
      )
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
