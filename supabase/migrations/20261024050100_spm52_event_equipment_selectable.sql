-- SPM-52 AC4, AC9: equipment newly added to an event request must be
-- selectable (is_active AND NOT details_pending). Items the event already has
-- are kept even if they have since been deactivated, because every save
-- replaces all of the event's requirement rows. The new item's row is locked
-- FOR SHARE, so a deactivation running at the same time waits for this save
-- (Master 7 lock order: the caller holds the event first, then equipment).
-- Everything else is unchanged from the definition live on 2026-10-24.

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
  v_existing_equipment integer[];
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
