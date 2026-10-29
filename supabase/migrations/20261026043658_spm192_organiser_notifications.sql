-- SPM-192: organiser notifications (Master 1.5 sections 4.2, 5.2 and 8).
--
-- 1. An organiser sees a notification only while they own its event (AC8).
--    Same-organisation organisers are never recipients of the owner's notices,
--    and a notice addressed to one by mistake stays hidden.
-- 2. Owner notices for workflows that do not exist yet (AC3, AC5). As with
--    SPM-155's attendee helpers, the workflow PERFORMs its function after its
--    own writes, so the notice commits or rolls back with the action, and each
--    sets an action key, so a repeated call writes nothing (AC10).
--
--   Feasibility accepted (SPM-39)   _notify_feasibility_accepted(event_id)
--   Request rejected (SPM-39)       _notify_event_rejected_owner(event_id, reason)
--   Event cancelled (SPM-40)        _notify_event_cancelled_owner(event_id)
--
-- Submission, assignment, clarification, confirmation and coordinator edits
-- already notify the owner from their own functions. Wording never includes
-- internal notes or reassignment reasons.

-- ---------- reading ----------

CREATE OR REPLACE FUNCTION public._notification_visible(
  p_user_id integer,
  p_role public.user_role,
  p_event_id integer
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_role = 'ATTENDEE' THEN
      p_event_id IS NOT NULL AND EXISTS (
        SELECT 1
          FROM public.registration AS r
         WHERE r.attendee_id = p_user_id
           AND r.event_id = p_event_id
           AND r.registration_status IN ('REGISTERED', 'WAITLISTED')
      )
    WHEN p_role = 'ORGANISER' THEN
      p_event_id IS NOT NULL AND EXISTS (
        SELECT 1
          FROM public.event AS e
         WHERE e.event_id = p_event_id
           AND e.organiser_id = p_user_id
      )
    ELSE true
  END;
$$;

-- ---------- writing ----------

-- The event, locked by the caller already, after its transition to p_status.
CREATE FUNCTION public._owner_notice_event(p_event_id integer, p_status text)
RETURNS public.event
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
BEGIN
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  IF v_event.status::text <> p_status THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_STATUS_MISMATCH', DETAIL = v_event.status::text;
  END IF;
  RETURN v_event;
END;
$$;

CREATE FUNCTION public._event_owner_recipients(p_event public.event)
RETURNS integer[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT ARRAY(SELECT user_id FROM public."user" WHERE user_id = p_event.organiser_id AND is_active);
$$;

-- AC3: call after the accept_feasibility transition (UNDER_REVIEW -> PLANNING).
-- An event enters PLANNING from review once, so the event ID is the action.
CREATE FUNCTION public._notify_feasibility_accepted(p_event_id integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event := public._owner_notice_event(p_event_id, 'PLANNING');
BEGIN
  RETURN public._notify_event_users(
    p_event_id,
    'Request approved: now in planning',
    format(
      'Your event request REQ-%s "%s" passed its feasibility review and is now in planning. Your coordinator will arrange the venue and resources.',
      lpad(p_event_id::text, 6, '0'), v_event.title
    ),
    public._event_owner_recipients(v_event),
    'STATUS_CHANGE',
    format('FEASIBILITY_ACCEPTED:%s', p_event_id),
    NULL
  );
END;
$$;

-- AC3: call after the reject transition, with the reason the coordinator
-- recorded for the organiser. REJECTED is terminal, so the event is the action.
CREATE FUNCTION public._notify_event_rejected_owner(p_event_id integer, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'REJECTION_REASON_REQUIRED';
  END IF;
  v_event := public._owner_notice_event(p_event_id, 'REJECTED');

  RETURN public._notify_event_users(
    p_event_id,
    'Request rejected',
    format(
      'Your event request REQ-%s "%s" was rejected. Reason: %s',
      lpad(p_event_id::text, 6, '0'), v_event.title, btrim(p_reason)
    ),
    public._event_owner_recipients(v_event),
    'STATUS_CHANGE',
    format('EVENT_REJECTED:%s', p_event_id),
    NULL
  );
END;
$$;

-- AC5: call in the cancellation transaction, after the cancel transition.
-- The attendee notice (_notify_event_cancelled_attendees) is separate and keyed
-- separately, because attendees get different wording.
CREATE FUNCTION public._notify_event_cancelled_owner(p_event_id integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event := public._owner_notice_event(p_event_id, 'CANCELLED');
BEGIN
  RETURN public._notify_event_users(
    p_event_id,
    'Event cancelled',
    format('Your event request REQ-%s "%s" has been cancelled.', lpad(p_event_id::text, 6, '0'), v_event.title),
    public._event_owner_recipients(v_event),
    'EVENT_CANCELLED',
    format('EVENT_CANCELLED_OWNER:%s', p_event_id),
    NULL
  );
END;
$$;

-- ---------- privileges ----------

REVOKE ALL ON FUNCTION public._owner_notice_event(integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_owner_recipients(public.event) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_feasibility_accepted(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_event_rejected_owner(integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_event_cancelled_owner(integer) FROM PUBLIC, anon, authenticated, service_role;
