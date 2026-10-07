-- SPM-177: assign an unassigned submitted request atomically.
CREATE OR REPLACE FUNCTION public.assign_event_coordinator(
  p_event_id integer,
  p_coordinator_id integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_coordinator public."user";
  v_conflict public.event;
  v_notification_id integer;
BEGIN
  SELECT *
    INTO v_event
    FROM public.event
   WHERE event_id = p_event_id
     AND status = 'SUBMITTED'
     AND coordinator_id IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  SELECT *
    INTO v_coordinator
    FROM public."user"
   WHERE user_id = p_coordinator_id
     AND role = 'COORDINATOR'
     AND is_active
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_COORDINATOR';
  END IF;

  SELECT e.*
    INTO v_conflict
    FROM public.event AS e
   WHERE e.coordinator_id = p_coordinator_id
     AND e.status NOT IN ('DRAFT', 'REJECTED', 'CANCELLED')
     AND e.start_datetime < v_event.end_datetime
     AND e.end_datetime > v_event.start_datetime
   ORDER BY e.start_datetime
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'COORDINATOR_CONFLICT',
      DETAIL = v_conflict.title;
  END IF;

  UPDATE public.event
     SET coordinator_id = p_coordinator_id,
         updated_at = now()
   WHERE event_id = p_event_id
     AND coordinator_id IS NULL
   RETURNING * INTO v_event;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  INSERT INTO public.notification (event_id, title, message, type)
  VALUES (
    v_event.event_id,
    'Event coordinator assigned',
    format('Coordinator %s has been assigned to your event request REQ-%s.', v_coordinator.name, lpad(v_event.event_id::text, 6, '0')),
    'STATUS_CHANGE'
  )
  RETURNING notification_id INTO v_notification_id;
  INSERT INTO public.notification_recipient (notification_id, recipient_id)
  VALUES (v_notification_id, v_event.organiser_id);

  INSERT INTO public.notification (event_id, title, message, type)
  VALUES (
    v_event.event_id,
    'New event coordination assignment',
    format('You have been assigned to coordinate event request REQ-%s: %s.', lpad(v_event.event_id::text, 6, '0'), v_event.title),
    'STATUS_CHANGE'
  )
  RETURNING notification_id INTO v_notification_id;
  INSERT INTO public.notification_recipient (notification_id, recipient_id)
  VALUES (v_notification_id, p_coordinator_id);

  RETURN jsonb_build_object(
    'event', to_jsonb(v_event),
    'coordinator_name', v_coordinator.name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assign_event_coordinator(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_event_coordinator(integer, integer)
  TO service_role;
