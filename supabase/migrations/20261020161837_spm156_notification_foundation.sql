-- SPM-156: shared notification foundation for every role (Master v1.1
-- sections 6.2, 6.3, 7.1 and 8).
--
-- Additive only: two nullable columns, two indexes and new functions. Existing
-- rows keep NULL in the new columns, and no existing function is replaced:
-- SPM-173's four-argument _notify_event_users stays as it is, and the
-- seven-argument version below is a separate overload.
--
-- Notifications are written by database functions because the backend has no
-- transaction outside them; a workflow PERFORMs one of these helpers inside its
-- own function, so the notification commits or rolls back with the action.

-- ---------- schema ----------

-- The originating domain action (Master 6.2). A retried or repeated action
-- reuses its key, and the unique index turns the second insert into a no-op.
-- Rows written without a key (every row before this migration) stay distinct.
ALTER TABLE public.notification
  ADD COLUMN IF NOT EXISTS action_key text
    CONSTRAINT notification_action_key_format
    CHECK (action_key IS NULL OR (length(action_key) <= 200 AND action_key ~ '^[A-Z_]+(:[A-Za-z0-9_.-]+)+$'));

-- When the action the notification asks for stops being possible, e.g. a
-- waitlist offer's expiry (SPM-155 AC3).
ALTER TABLE public.notification
  ADD COLUMN IF NOT EXISTS action_expires_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS notification_action_key_key
  ON public.notification (action_key);

-- The navigation badge counts unread rows on every page load (Master 6.3).
CREATE INDEX IF NOT EXISTS notification_recipient_unread
  ON public.notification_recipient (recipient_id)
  WHERE NOT is_read;

-- ---------- writing ----------

-- One notification and its recipients, unless the action already notified
-- (same p_action_key) or nobody would receive it; both cases write nothing and
-- return NULL. Callers own recipient selection and audience-safe wording.
CREATE FUNCTION public._notify_event_users(
  p_event_id integer,
  p_title text,
  p_message text,
  p_recipients integer[],
  p_type public.notification_type,
  p_action_key text,
  p_action_expires_at timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_notification_id integer;
BEGIN
  IF p_recipients IS NULL OR cardinality(array_remove(p_recipients, NULL)) = 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.notification (event_id, title, message, type, action_key, action_expires_at)
  VALUES (p_event_id, p_title, p_message, p_type, p_action_key, p_action_expires_at)
  ON CONFLICT (action_key) DO NOTHING
  RETURNING notification_id INTO v_notification_id;
  IF v_notification_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.notification_recipient (notification_id, recipient_id)
  SELECT DISTINCT v_notification_id, recipient_id
    FROM unnest(p_recipients) AS recipient_id
   WHERE recipient_id IS NOT NULL;
  RETURN v_notification_id;
END;
$$;

-- Timestamps inside action keys, to the microsecond and in digits only.
CREATE FUNCTION public._notification_key_time(p_at timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT (extract(epoch FROM p_at) * 1000000)::bigint::text;
$$;

-- ---------- reading ----------

-- Whether a recipient may still see a notification about this event. Holding a
-- notification never restores access after the relationship ends (Master 8).
-- Attendees see only events they are registered or waitlisted for (SPM-155
-- AC6). Other roles see every notification addressed to them until their own
-- tickets (SPM-192, SPM-193) add their relationship here.
CREATE FUNCTION public._notification_visible(
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
    ELSE true
  END;
$$;

-- Newest first. Pass the last row's created_at and notification_id to get the
-- next page; the caller asks for one row more than it shows to detect it.
CREATE FUNCTION public.list_notifications(
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
     AND public._notification_visible(u.user_id, u.role, n.event_id)
     AND (p_before_created_at IS NULL OR (n.created_at, n.notification_id) < (p_before_created_at, p_before_id))
   ORDER BY n.created_at DESC, n.notification_id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 101);
$$;

CREATE FUNCTION public.count_unread_notifications(p_user_id integer)
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
     AND public._notification_visible(u.user_id, u.role, n.event_id);
$$;

-- ---------- read state ----------

-- No row when the notification is not the user's or is hidden from them.
-- Marking a read notification again keeps its first read time.
CREATE FUNCTION public.mark_notification_read(p_user_id integer, p_notification_id integer)
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
     AND public._notification_visible(u.user_id, u.role, n.event_id)
  RETURNING nr.notification_id, nr.is_read, nr.read_at;
$$;

-- Marks only what the user can see, so the list and the unread count agree.
CREATE FUNCTION public.mark_all_notifications_read(p_user_id integer)
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
       AND public._notification_visible(u.user_id, u.role, n.event_id)
    RETURNING 1
  )
  SELECT count(*)::integer FROM updated;
$$;

-- ---------- privileges ----------

REVOKE ALL ON FUNCTION public._notify_event_users(integer, text, text, integer[], public.notification_type, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notification_key_time(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notification_visible(integer, public.user_role, integer) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.list_notifications(integer, integer, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.count_unread_notifications(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_notification_read(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_all_notifications_read(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.list_notifications(integer, integer, timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.count_unread_notifications(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_notification_read(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read(integer) TO service_role;
