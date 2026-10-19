-- SPM-33 follow-up (2026-10-15): assigning a coordinator starts the review.
-- Master section 5.2: "Assign coordinator — set the coordinator and the
-- supervising Lead, record history, enter UNDER_REVIEW, notify the coordinator
-- and the owner". The function set the coordinator and sent both notifications
-- but left the event in SUBMITTED and recorded no history, so the assigned
-- coordinator could never edit it (AC4) and the staff-only assignment record
-- (AC8) was missing.
--
-- Identical to the live definition except for the status change and the
-- history entry. Privileges are kept by CREATE OR REPLACE. Events already left
-- in SUBMITTED with a coordinator are not moved here.

CREATE OR REPLACE FUNCTION public.assign_event_coordinator(p_event_id integer, p_coordinator_id integer, p_lead_id integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_coordinator public."user";
  v_notification_id integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."user" WHERE user_id = p_lead_id AND role = 'COORDINATOR_LEAD' AND is_active) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN';
  END IF;

  SELECT * INTO v_event
    FROM public.event
   WHERE event_id = p_event_id AND status = 'SUBMITTED' AND coordinator_id IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  SELECT * INTO v_coordinator
    FROM public."user"
   WHERE user_id = p_coordinator_id AND role = 'COORDINATOR' AND is_active
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_COORDINATOR';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.event AS other_event
     WHERE other_event.coordinator_id = p_coordinator_id
       AND other_event.status NOT IN ('DRAFT', 'COMPLETED', 'REJECTED', 'CANCELLED')
       AND other_event.start_datetime < v_event.end_datetime
       AND other_event.end_datetime > v_event.start_datetime
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COORDINATOR_CONFLICT';
  END IF;

  UPDATE public.event
     SET coordinator_id = p_coordinator_id,
         status = 'UNDER_REVIEW',
         updated_at = now()
   WHERE event_id = p_event_id AND coordinator_id IS NULL AND status = 'SUBMITTED'
   RETURNING * INTO v_event;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  INSERT INTO public.event_assignments (event_id, coordinator_id, assigned_by)
  VALUES (p_event_id, p_coordinator_id, p_lead_id);

  -- Assignment records are for staff only (SPM-33 AC8).
  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_lead_id, 'event', p_event_id, 'COORDINATOR_ASSIGNED', 'Coordinator assigned.', 'COORDINATOR_LEAD',
    jsonb_build_object('status', jsonb_build_object('before', 'SUBMITTED', 'after', 'UNDER_REVIEW')),
    'STAFF_ONLY'
  );

  INSERT INTO public.notification (event_id, title, message, type)
  VALUES (
    p_event_id,
    'Event coordinator assigned',
    format('Coordinator %s has been assigned to your event request REQ-%s.', v_coordinator.name, lpad(p_event_id::text, 6, '0')),
    'STATUS_CHANGE'
  )
  RETURNING notification_id INTO v_notification_id;
  INSERT INTO public.notification_recipient (notification_id, recipient_id) VALUES (v_notification_id, v_event.organiser_id);

  INSERT INTO public.notification (event_id, title, message, type)
  VALUES (
    p_event_id,
    'New event coordination assignment',
    format('You have been assigned to coordinate event request REQ-%s: %s.', lpad(p_event_id::text, 6, '0'), v_event.title),
    'STATUS_CHANGE'
  )
  RETURNING notification_id INTO v_notification_id;
  INSERT INTO public.notification_recipient (notification_id, recipient_id) VALUES (v_notification_id, p_coordinator_id);

  RETURN jsonb_build_object('event', to_jsonb(v_event));
END;
$$;
