-- SPM-76 follow-up: put back the two removals that were left commented out
-- when 20261031140000_spm76_venue_preference_times.sql was applied. Without
-- them a venue or equipment line the organiser takes off the list stays saved.
-- Each DELETE touches only the one event being saved, and only the venues or
-- equipment missing from the list the organiser just sent, inside that save's
-- transaction. Applying this file changes no row; it replaces one function.
-- Checked before writing: no event had a left-over choice.

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
  v_venue_ids integer[] := '{}';
  v_requested_start timestamptz;
  v_requested_end timestamptz;
  v_event_start timestamptz;
  v_event_end timestamptz;
  v_order_offset integer;
  v_equipment_id integer;
  v_equipment_ids integer[] := '{}';
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

    -- Kept choices move above every new rank first, so the unique
    -- (event_id, preference_order) never clashes while ranks are rewritten.
    SELECT coalesce(max(preference_order), 0) + jsonb_array_length(p_venue_preferences)
      INTO v_order_offset
      FROM public.event_venue_preference
     WHERE event_id = p_event_id;
    UPDATE public.event_venue_preference
       SET preference_order = preference_order + v_order_offset
     WHERE event_id = p_event_id;

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
      IF v_venue_id = ANY (v_venue_ids) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_PREFERENCES';
      END IF;
      v_venue_ids := array_append(v_venue_ids, v_venue_id);

      INSERT INTO public.event_venue_preference (event_id, venue_id, preference_order, requested_start, requested_end)
      VALUES (p_event_id, v_venue_id, v_item.ordinality::integer, v_requested_start, v_requested_end)
      ON CONFLICT (event_id, venue_id) DO UPDATE
        SET preference_order = EXCLUDED.preference_order,
            requested_start = EXCLUDED.requested_start,
            requested_end = EXCLUDED.requested_end;
    END LOOP;

    -- Only the venues the organiser took off the list.
    DELETE FROM public.event_venue_preference
     WHERE event_id = p_event_id
       AND NOT (venue_id = ANY (v_venue_ids));
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

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_equipment_requirements) AS items(value)
    LOOP
      IF jsonb_typeof(v_item.value) <> 'object'
         OR NOT (v_item.value ? 'equipment_id')
         OR NOT (v_item.value ? 'quantity') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EQUIPMENT_REQUIREMENTS';
      END IF;
      v_equipment_id := (v_item.value->>'equipment_id')::integer;
      v_quantity := (v_item.value->>'quantity')::integer;
      IF v_equipment_id = ANY (v_equipment_ids) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EQUIPMENT_REQUIREMENTS';
      END IF;
      v_equipment_ids := array_append(v_equipment_ids, v_equipment_id);
      -- SPM-52 AC4/AC9: newly added equipment must be selectable; kept lines stay valid.
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
      VALUES (p_event_id, v_equipment_id, v_quantity)
      ON CONFLICT (event_id, equipment_id) DO UPDATE
        SET quantity_requested = EXCLUDED.quantity_requested;
    END LOOP;

    -- Only the equipment the organiser took off the list.
    DELETE FROM public.event_equipment_requirement
     WHERE event_id = p_event_id
       AND NOT (equipment_id = ANY (v_equipment_ids));
  END IF;
END;
$$;
