-- SPM-173 AC1: coordinator assignment uses the shared guarded transition
-- writer while retaining the SPM-177 assignment checks and side effects.

CREATE OR REPLACE FUNCTION public._apply_event_transition(
  p_event public.event,
  p_action text,
  p_actor_id integer,
  p_details text,
  p_coordinator_id integer
)
RETURNS public.event
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rule record;
  v_current public.event;
  v_updated public.event;
BEGIN
  SELECT * INTO v_rule FROM public._lifecycle_transitions() AS t WHERE t.action = p_action;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNKNOWN_LIFECYCLE_ACTION', DETAIL = p_action;
  END IF;

  SELECT * INTO v_current FROM public.event WHERE event_id = p_event.event_id FOR UPDATE;

  IF v_rule.to_state = 'SUBMITTED' AND v_current.coordinator_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COORDINATOR_INVARIANT', DETAIL = v_rule.to_state;
  END IF;
  IF v_rule.to_state IN ('UNDER_REVIEW', 'AWAITING_CLARIFICATION', 'PLANNING', 'SAFETY_REVIEW', 'CONFIRMED', 'PREPARATION')
     AND COALESCE(p_coordinator_id, v_current.coordinator_id) IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COORDINATOR_INVARIANT', DETAIL = v_rule.to_state;
  END IF;

  UPDATE public.event
     SET status = v_rule.to_state::public.event_status,
         coordinator_id = COALESCE(p_coordinator_id, coordinator_id),
         previously_confirmed = previously_confirmed OR v_rule.to_state = 'CONFIRMED',
         updated_at = now()
   WHERE event_id = v_current.event_id
   RETURNING * INTO v_updated;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id,
    'event',
    v_updated.event_id,
    v_rule.activity_action,
    p_details,
    COALESCE((SELECT role::text FROM public."user" WHERE user_id = p_actor_id), 'SYSTEM'),
    jsonb_build_object('status', jsonb_build_object('before', v_current.status::text, 'after', v_rule.to_state)),
    v_rule.audience
  );

  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public._apply_event_transition(public.event, text, integer, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assign_event_coordinator(
  p_event_id integer,
  p_coordinator_id integer,
  p_lead_id integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_coordinator public."user";
  v_actor public."user";
  v_notification_id integer;
BEGIN
  SELECT * INTO v_actor
    FROM public."user"
   WHERE user_id = p_lead_id
     AND role = 'COORDINATOR_LEAD'
     AND is_active
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN';
  END IF;

  SELECT * INTO v_event
    FROM public.event
   WHERE event_id = p_event_id
     AND status = 'SUBMITTED'
     AND coordinator_id IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  SELECT * INTO v_coordinator
    FROM public."user"
   WHERE user_id = p_coordinator_id
     AND role = 'COORDINATOR'
     AND is_active
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

  PERFORM public._check_event_transition(v_event, 'assign', p_lead_id, NULL);
  v_event := public._apply_event_transition(v_event, 'assign', p_lead_id, 'Coordinator assigned.', p_coordinator_id);

  INSERT INTO public.event_assignments (event_id, coordinator_id, assigned_by)
  VALUES (p_event_id, p_coordinator_id, p_lead_id);

  INSERT INTO public.notification (event_id, title, message, type)
  VALUES (
    p_event_id,
    'Event coordinator assigned',
    format('Coordinator %s has been assigned to your event request REQ-%s.', v_coordinator.name, lpad(p_event_id::text, 6, '0')),
    'STATUS_CHANGE'
  )
  RETURNING notification_id INTO v_notification_id;
  INSERT INTO public.notification_recipient (notification_id, recipient_id)
  VALUES (v_notification_id, v_event.organiser_id);

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

  RETURN jsonb_build_object('event', to_jsonb(v_event) || jsonb_build_object('coordinator', jsonb_build_object('name', v_coordinator.name)));
END;
$$;

REVOKE ALL ON FUNCTION public.assign_event_coordinator(integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_event_coordinator(integer, integer, integer)
  TO service_role;
