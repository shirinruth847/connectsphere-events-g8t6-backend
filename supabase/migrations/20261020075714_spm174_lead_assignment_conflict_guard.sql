-- SPM-174/SPM-180: staged protection while Leads resolve legacy overlaps.
-- Append-only: no existing event, assignment, user or notification is rewritten.
-- The full exclusion constraint remains a separate rollout after zero conflicts.

CREATE OR REPLACE FUNCTION public._guard_coordinator_schedule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.coordinator_id IS NULL OR NEW.status IN ('DRAFT','COMPLETED','REJECTED','CANCELLED') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Existing conflicts can be inspected/edited without silently repairing them.
    IF OLD.coordinator_id IS NOT DISTINCT FROM NEW.coordinator_id
       AND OLD.start_datetime IS NOT DISTINCT FROM NEW.start_datetime
       AND OLD.end_datetime IS NOT DISTINCT FROM NEW.end_datetime
       AND OLD.status NOT IN ('DRAFT','COMPLETED','REJECTED','CANCELLED') THEN
      RETURN NEW;
    END IF;
  END IF;
  -- Same serialization point as both assignment RPCs. Held until commit.
  PERFORM 1 FROM public."user" WHERE user_id = NEW.coordinator_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.event other_event
     WHERE other_event.event_id <> NEW.event_id
       AND other_event.coordinator_id = NEW.coordinator_id
       AND other_event.status NOT IN ('DRAFT','COMPLETED','REJECTED','CANCELLED')
       AND tstzrange(other_event.start_datetime, other_event.end_datetime)
           && tstzrange(NEW.start_datetime, NEW.end_datetime)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'COORDINATOR_CONFLICT';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._guard_coordinator_schedule() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER event_guard_coordinator_schedule
BEFORE INSERT OR UPDATE OF coordinator_id, start_datetime, end_datetime, status ON public.event
FOR EACH ROW EXECUTE FUNCTION public._guard_coordinator_schedule();

CREATE OR REPLACE FUNCTION public.list_lead_event_assignments(p_lead_id integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."user" WHERE user_id=p_lead_id AND role='COORDINATOR_LEAD' AND is_active) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='FORBIDDEN';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'eventId', e.event_id, 'requestId', 'REQ-' || lpad(e.event_id::text,6,'0'),
      'title', e.title, 'status', e.status, 'startDatetime', e.start_datetime,
      'endDatetime', e.end_datetime, 'expectedAttendance', e.expected_attendance,
      'createdAt', e.created_at, 'updatedAt', e.updated_at,
      'coordinatorId', e.coordinator_id, 'coordinatorName', c.name,
      'supervisingLeadId', a.assigned_by,
      'hasScheduleConflict', EXISTS (
        SELECT 1 FROM public.event other_event
         WHERE other_event.coordinator_id=e.coordinator_id AND other_event.event_id<>e.event_id
           AND other_event.status NOT IN ('DRAFT','COMPLETED','REJECTED','CANCELLED')
           AND tstzrange(other_event.start_datetime,other_event.end_datetime)
               && tstzrange(e.start_datetime,e.end_datetime)
      ),
      'organisation', CASE WHEN o.organisation_id IS NULL THEN NULL ELSE
        jsonb_build_object('organisationId',o.organisation_id,'name',o.name) END
    ) ORDER BY e.start_datetime,e.event_id)
    FROM public.event e
    JOIN public."user" c ON c.user_id=e.coordinator_id
    LEFT JOIN public.organisation o ON o.organisation_id=e.organisation_id
    LEFT JOIN public.event_assignments a ON a.event_id=e.event_id AND a.ended_at IS NULL
    WHERE e.status NOT IN ('DRAFT','COMPLETED','REJECTED','CANCELLED')
      AND (a.assigned_by=p_lead_id OR a.assigned_by IS NULL)
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.list_lead_event_assignments(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_lead_event_assignments(integer) TO service_role;

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
    format('The coordinator for event request REQ-%s has changed.', lpad(p_event_id::text, 6, '0')),
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

REVOKE ALL ON FUNCTION public.reassign_event_coordinator(integer, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reassign_event_coordinator(integer, integer, integer, integer)
  TO service_role;
