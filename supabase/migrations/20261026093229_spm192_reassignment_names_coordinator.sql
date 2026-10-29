-- SPM-192 AC4: the owner's reassignment notice names the new coordinator as
-- their point of contact. Rebuilt from the live definition (SPM-180, as last
-- changed by 20261020075714_spm174_lead_assignment_conflict_guard); only the
-- owner's message changes. It still carries no reason or internal details
-- (SPM-33 AC8). Agreed with the function's owner.

CREATE OR REPLACE FUNCTION public.reassign_event_coordinator(
  p_event_id integer,
  p_coordinator_id integer,
  p_expected_coordinator_id integer,
  p_lead_id integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_old_coordinator public."user";
  v_coordinator public."user";
  v_notification_id integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public."user"
     WHERE user_id = p_lead_id
       AND role = 'COORDINATOR_LEAD'
       AND is_active
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN';
  END IF;

  SELECT *
    INTO v_event
    FROM public.event
   WHERE event_id = p_event_id
     AND coordinator_id IS NOT NULL
     AND status NOT IN ('DRAFT', 'COMPLETED', 'CANCELLED', 'REJECTED')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_REASSIGNABLE';
  END IF;

  -- Assignment history owns supervision. Legacy rows without a recorded Lead
  -- remain visible under Unsupervised; the reassigning Lead takes supervision.
  IF EXISTS (
    SELECT 1 FROM public.event_assignments
     WHERE event_id = p_event_id AND ended_at IS NULL
       AND assigned_by IS NOT NULL AND assigned_by <> p_lead_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_REASSIGNABLE';
  END IF;

  IF v_event.coordinator_id IS DISTINCT FROM p_expected_coordinator_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ASSIGNMENT_CHANGED';
  END IF;

  IF v_event.coordinator_id = p_coordinator_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COORDINATOR_UNCHANGED';
  END IF;

  SELECT *
    INTO v_old_coordinator
    FROM public."user"
   WHERE user_id = v_event.coordinator_id;

  -- Serializes assignments to this coordinator so overlapping events cannot
  -- both pass the availability check concurrently.
  SELECT *
    INTO v_coordinator
    FROM public."user"
   WHERE user_id = p_coordinator_id
     AND role = 'COORDINATOR'
     AND is_active
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_COORDINATOR';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.event AS other_event
     WHERE other_event.coordinator_id = p_coordinator_id
       AND other_event.event_id <> p_event_id
       AND other_event.status NOT IN ('DRAFT', 'COMPLETED', 'CANCELLED', 'REJECTED')
       AND other_event.start_datetime < v_event.end_datetime
       AND other_event.end_datetime > v_event.start_datetime
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COORDINATOR_CONFLICT';
  END IF;

  UPDATE public.event_assignments
     SET ended_at = now()
   WHERE event_id = p_event_id
     AND ended_at IS NULL;

  UPDATE public.event
     SET coordinator_id = p_coordinator_id,
         updated_at = now()
   WHERE event_id = p_event_id
   RETURNING * INTO v_event;

  INSERT INTO public.event_assignments (event_id, coordinator_id, assigned_by)
  VALUES (p_event_id, p_coordinator_id, p_lead_id);

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, audience)
  VALUES (
    p_lead_id,
    'event',
    p_event_id,
    'COORDINATOR_REASSIGNED',
    jsonb_build_object(
      'previousCoordinatorId', v_old_coordinator.user_id,
      'coordinatorId', p_coordinator_id
    )::text,
    'COORDINATOR_LEAD',
    'STAFF_ONLY'
  );

  INSERT INTO public.notification (event_id, title, message, type)
  VALUES (
    p_event_id,
    'Event coordinator changed',
    format(
      'Your event request REQ-%s "%s" has a new coordinator, %s, who is now your point of contact.',
      lpad(p_event_id::text, 6, '0'), v_event.title, v_coordinator.name
    ),
    'STATUS_CHANGE'
  )
  RETURNING notification_id INTO v_notification_id;
  INSERT INTO public.notification_recipient (notification_id, recipient_id)
  VALUES (v_notification_id, v_event.organiser_id);

  INSERT INTO public.notification (event_id, title, message, type)
  VALUES (
    p_event_id,
    'Event assignment ended',
    format('Your coordinator assignment for event request REQ-%s has ended.', lpad(p_event_id::text, 6, '0')),
    'STATUS_CHANGE'
  )
  RETURNING notification_id INTO v_notification_id;
  INSERT INTO public.notification_recipient (notification_id, recipient_id)
  VALUES (v_notification_id, v_old_coordinator.user_id);

  INSERT INTO public.notification (event_id, title, message, type)
  VALUES (
    p_event_id,
    'New event coordination assignment',
    format('You have been assigned to coordinate event request REQ-%s: %s.', lpad(p_event_id::text, 6, '0'), v_event.title),
    'STATUS_CHANGE'
  )
  RETURNING notification_id INTO v_notification_id;
  INSERT INTO public.notification_recipient (notification_id, recipient_id)
  VALUES (v_notification_id, p_coordinator_id);

  RETURN jsonb_build_object(
    'event', jsonb_build_object(
      'event_id', v_event.event_id,
      'title', v_event.title,
      'status', v_event.status,
      'coordinator_id', v_event.coordinator_id
    ),
    'coordinator', jsonb_build_object(
      'user_id', v_coordinator.user_id,
      'name', v_coordinator.name
    )
  );
END;
$$;
