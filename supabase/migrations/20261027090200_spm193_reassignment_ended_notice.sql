-- SPM-193 AC2/AC10: the previous coordinator's "assignment ended" notice is
-- typed ASSIGNMENT_ENDED, so it stays in their inbox after the event's other
-- notices are hidden from them. Apply after 20261027090100.
--
-- reassign_event_coordinator (SPM-180) is rebuilt from its live definition
-- (20261026093229_spm192_reassignment_names_coordinator). The only change is
-- that notice's type; checks, locks, history and the other notices are as before.

CREATE OR REPLACE FUNCTION public.reassign_event_coordinator(p_event_id integer, p_coordinator_id integer, p_expected_coordinator_id integer, p_lead_id integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
    'ASSIGNMENT_ENDED'
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
$function$;

-- Earlier notices of that kind keep showing to their recipients. Only rows with
-- the exact title whose every recipient is a former coordinator of the event.
UPDATE public.notification AS n
   SET type = 'ASSIGNMENT_ENDED'
 WHERE n.type = 'STATUS_CHANGE'
   AND n.title = 'Event assignment ended'
   AND n.event_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.notification_recipient AS nr WHERE nr.notification_id = n.notification_id)
   AND NOT EXISTS (
     SELECT 1
       FROM public.notification_recipient AS nr
      WHERE nr.notification_id = n.notification_id
        AND NOT EXISTS (
          SELECT 1
            FROM public.event_assignments AS ea
           WHERE ea.event_id = n.event_id
             AND ea.coordinator_id = nr.recipient_id
             AND ea.ended_at IS NOT NULL
        )
   );
