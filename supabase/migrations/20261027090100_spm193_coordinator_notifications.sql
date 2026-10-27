-- SPM-193: coordinator notifications (Master 1.5 sections 4.2, 5.4.3, 5.4.4,
-- 5.5, 5.8 and 8). Apply after 20261027051734_spm193_assignment_ended_type.
--
-- 1. A coordinator sees a notification only while its event is assigned to
--    them, except the ASSIGNMENT_ENDED notice from a reassignment (AC10). The
--    rule needs the notification type, so _notification_visible takes it and
--    the four inbox functions are rebuilt from their live SPM-156 definitions
--    to pass it. Attendee and organiser rules are unchanged.
-- 2. Coordinator notices for workflows that do not exist yet (AC5, AC6, AC8).
--    As with the SPM-155 and SPM-192 helpers, the workflow PERFORMs one after
--    its own writes, so the notice commits or rolls back with the action, and
--    each sets an action key, so a repeated call writes nothing (AC12).
--
--   Hold expiry warning (SPM-188)    _notify_coordinator_hold_expiring(event_id, hold_id, venue_id, expires_at)
--   Hold expired (SPM-188)           _notify_coordinator_hold_expired(event_id, hold_id, venue_id)
--   Venue block on a booking         _notify_coordinator_venue_blocked(event_id, block_id, venue_id, reason)
--   Technical request decided        _notify_coordinator_technical_decision(event_id, request_key, decision, reason)
--
-- Each is addressed to the event's coordinator at the time of the call.
-- Assignment, reassignment, clarification replies and amendments, venue
-- booking decisions, venue status changes and safety outcomes already notify
-- the coordinator from their own functions.

-- ---------- reading ----------

CREATE FUNCTION public._notification_visible(
  p_user_id integer,
  p_role public.user_role,
  p_event_id integer,
  p_type public.notification_type
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
    WHEN p_role = 'COORDINATOR' THEN
      p_event_id IS NOT NULL AND (
        p_type = 'ASSIGNMENT_ENDED'
        OR EXISTS (
          SELECT 1
            FROM public.event AS e
           WHERE e.event_id = p_event_id
             AND e.coordinator_id = p_user_id
        )
      )
    ELSE true
  END;
$$;

CREATE OR REPLACE FUNCTION public.list_notifications(
  p_user_id integer,
  p_limit integer,
  p_before_created_at timestamptz,
  p_before_id integer
)
RETURNS TABLE (
  notification_id integer,
  type text,
  title text,
  message text,
  created_at timestamptz,
  is_read boolean,
  read_at timestamptz,
  action_expires_at timestamptz,
  event_id integer,
  event_title text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT n.notification_id, n.type::text, n.title::text, n.message, n.created_at,
         nr.is_read, nr.read_at, n.action_expires_at, n.event_id, e.title::text
    FROM public."user" AS u
    JOIN public.notification_recipient AS nr ON nr.recipient_id = u.user_id
    JOIN public.notification AS n ON n.notification_id = nr.notification_id
    LEFT JOIN public.event AS e ON e.event_id = n.event_id
   WHERE u.user_id = p_user_id
     AND u.is_active
     AND public._notification_visible(u.user_id, u.role, n.event_id, n.type)
     AND (p_before_created_at IS NULL OR (n.created_at, n.notification_id) < (p_before_created_at, p_before_id))
   ORDER BY n.created_at DESC, n.notification_id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 101);
$$;

CREATE OR REPLACE FUNCTION public.count_unread_notifications(p_user_id integer)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
    FROM public."user" AS u
    JOIN public.notification_recipient AS nr ON nr.recipient_id = u.user_id AND NOT nr.is_read
    JOIN public.notification AS n ON n.notification_id = nr.notification_id
   WHERE u.user_id = p_user_id
     AND u.is_active
     AND public._notification_visible(u.user_id, u.role, n.event_id, n.type);
$$;

-- ---------- read state ----------

CREATE OR REPLACE FUNCTION public.mark_notification_read(p_user_id integer, p_notification_id integer)
RETURNS TABLE (notification_id integer, is_read boolean, read_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.notification_recipient AS nr
     SET is_read = true,
         read_at = COALESCE(nr.read_at, now())
    FROM public."user" AS u, public.notification AS n
   WHERE nr.notification_id = p_notification_id
     AND nr.recipient_id = p_user_id
     AND u.user_id = nr.recipient_id
     AND u.is_active
     AND n.notification_id = nr.notification_id
     AND public._notification_visible(u.user_id, u.role, n.event_id, n.type)
  RETURNING nr.notification_id, nr.is_read, nr.read_at;
$$;

CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(p_user_id integer)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH updated AS (
    UPDATE public.notification_recipient AS nr
       SET is_read = true,
           read_at = now()
      FROM public."user" AS u, public.notification AS n
     WHERE nr.recipient_id = p_user_id
       AND NOT nr.is_read
       AND u.user_id = nr.recipient_id
       AND u.is_active
       AND n.notification_id = nr.notification_id
       AND public._notification_visible(u.user_id, u.role, n.event_id, n.type)
    RETURNING 1
  )
  SELECT count(*)::integer FROM updated;
$$;

-- Its four callers now pass the type.
DROP FUNCTION public._notification_visible(integer, public.user_role, integer);

-- ---------- writing ----------

CREATE FUNCTION public._coordinator_notice_event(p_event_id integer)
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
  RETURN v_event;
END;
$$;

-- The event's coordinator while their profile is active; none when unassigned.
CREATE FUNCTION public._event_coordinator_recipients(p_event public.event)
RETURNS integer[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT ARRAY(SELECT user_id FROM public."user" WHERE user_id = p_event.coordinator_id AND is_active);
$$;

CREATE FUNCTION public._coordinator_notice_venue_name(p_venue_id integer)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_name text;
BEGIN
  SELECT name INTO v_name FROM public.venue WHERE venue_id = p_venue_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'VENUE_NOT_FOUND';
  END IF;
  RETURN v_name;
END;
$$;

-- MongoDB hold and block IDs, and technical request references, become part
-- of an action key, so they must fit its format.
CREATE FUNCTION public._coordinator_notice_ref(p_value text, p_code text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_value IS NULL OR p_value !~ '^[A-Za-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = p_code;
  END IF;
  RETURN p_value;
END;
$$;

-- AC8: call from the hold reminder job (Master 5.4.3: 24 hours before expiry,
-- or at once for a shorter hold). The expiry is part of the key, so a hold
-- extended once warns once more for its new expiry.
CREATE FUNCTION public._notify_coordinator_hold_expiring(
  p_event_id integer,
  p_hold_id text,
  p_venue_id integer,
  p_expires_at timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_hold_id text := public._coordinator_notice_ref(p_hold_id, 'INVALID_HOLD_ID');
  v_event public.event;
BEGIN
  IF p_expires_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'HOLD_EXPIRY_REQUIRED';
  END IF;
  v_event := public._coordinator_notice_event(p_event_id);

  RETURN public._notify_event_users(
    p_event_id,
    'Venue hold expiring',
    format(
      'The tentative hold on %s for event REQ-%s "%s" expires on %s. Confirm the venue before then to keep it.',
      public._coordinator_notice_venue_name(p_venue_id), lpad(p_event_id::text, 6, '0'), v_event.title,
      public._attendee_datetime_text(p_expires_at)
    ),
    public._event_coordinator_recipients(v_event),
    'BOOKING_UPDATE',
    format('HOLD_EXPIRING:%s:%s', v_hold_id, public._notification_key_time(p_expires_at)),
    NULL
  );
END;
$$;

-- AC8: call when the expiry job records the hold as EXPIRED. A hold expires once.
CREATE FUNCTION public._notify_coordinator_hold_expired(
  p_event_id integer,
  p_hold_id text,
  p_venue_id integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_hold_id text := public._coordinator_notice_ref(p_hold_id, 'INVALID_HOLD_ID');
  v_event public.event := public._coordinator_notice_event(p_event_id);
BEGIN
  RETURN public._notify_event_users(
    p_event_id,
    'Venue hold expired',
    format(
      'The tentative hold on %s for event REQ-%s "%s" has expired, so the venue is no longer held. Request it again or choose another venue.',
      public._coordinator_notice_venue_name(p_venue_id), lpad(p_event_id::text, 6, '0'), v_event.title
    ),
    public._event_coordinator_recipients(v_event),
    'BOOKING_UPDATE',
    format('HOLD_EXPIRED:%s', v_hold_id),
    NULL
  );
END;
$$;

-- AC5: call once per affected event when a venue block creates its incident
-- (Master 5.4.4). The reason is the block's reason code; the note stays with
-- Venue Staff.
CREATE FUNCTION public._notify_coordinator_venue_blocked(
  p_event_id integer,
  p_block_id text,
  p_venue_id integer,
  p_reason text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_block_id text := public._coordinator_notice_ref(p_block_id, 'INVALID_BLOCK_ID');
  v_event public.event;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('MAINTENANCE', 'EQUIPMENT_FAILURE', 'RENOVATION', 'SAFETY', 'OTHER') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_BLOCK_REASON';
  END IF;
  v_event := public._coordinator_notice_event(p_event_id);

  RETURN public._notify_event_users(
    p_event_id,
    'Alternative venue required',
    format(
      '%s is blocked (%s) during the booking for event REQ-%s "%s". The booking and the event are kept; restore the booking if the venue becomes free, replace the venue or cancel the event.',
      public._coordinator_notice_venue_name(p_venue_id), lower(replace(p_reason, '_', ' ')),
      lpad(p_event_id::text, 6, '0'), v_event.title
    ),
    public._event_coordinator_recipients(v_event),
    'BOOKING_UPDATE',
    format('VENUE_BLOCKED:%s:%s:COORDINATOR', v_block_id, p_event_id),
    NULL
  );
END;
$$;

-- AC6: call after Technical Support decide a technical request. A request is
-- approved in full or rejected (Master 5.5); a rejection needs its reason.
CREATE FUNCTION public._notify_coordinator_technical_decision(
  p_event_id integer,
  p_request_key text,
  p_decision text,
  p_reason text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request_key text := public._coordinator_notice_ref(p_request_key, 'INVALID_TECHNICAL_REQUEST');
  v_event public.event;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_TECHNICAL_DECISION';
  END IF;
  IF p_decision = 'REJECTED' AND (p_reason IS NULL OR btrim(p_reason) = '') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'REJECTION_REASON_REQUIRED';
  END IF;
  v_event := public._coordinator_notice_event(p_event_id);

  RETURN public._notify_event_users(
    p_event_id,
    CASE p_decision WHEN 'APPROVED' THEN 'Technical request approved' ELSE 'Technical request rejected' END,
    CASE p_decision
      WHEN 'APPROVED' THEN format(
        'Technical Support approved the technical request for event REQ-%s "%s". The equipment and support are reserved.',
        lpad(p_event_id::text, 6, '0'), v_event.title
      )
      ELSE format(
        'Technical Support rejected the technical request for event REQ-%s "%s". Reason: %s. The event stays in planning; revise the request.',
        lpad(p_event_id::text, 6, '0'), v_event.title, btrim(p_reason)
      )
    END,
    public._event_coordinator_recipients(v_event),
    'EQUIPMENT_UPDATE',
    format('TECHNICAL_REQUEST_%s:%s:COORDINATOR', p_decision, v_request_key),
    NULL
  );
END;
$$;

-- ---------- privileges ----------

REVOKE ALL ON FUNCTION public._notification_visible(integer, public.user_role, integer, public.notification_type) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._coordinator_notice_event(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_coordinator_recipients(public.event) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._coordinator_notice_venue_name(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._coordinator_notice_ref(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_coordinator_hold_expiring(integer, text, integer, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_coordinator_hold_expired(integer, text, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_coordinator_venue_blocked(integer, text, integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_coordinator_technical_decision(integer, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
-- CREATE OR REPLACE keeps the inbox functions' existing grants (SPM-156):
-- service_role only.
