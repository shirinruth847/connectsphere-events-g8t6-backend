-- A read acknowledges displayed messages, never unseen replies that arrived
-- after the page loaded. Apply before the matching backend/frontend changes.
ALTER TABLE public.clarification_reads
  ADD COLUMN last_read_message_id integer NOT NULL DEFAULT 0
    CHECK (last_read_message_id >= 0);

CREATE INDEX clarification_messages_cursor
  ON public.clarification_messages (clarification_id, message_id);

-- Preserve legacy read state. New reads use IDs so transaction-start timestamps
-- and JavaScript's millisecond precision cannot hide later committed messages.
UPDATE public.clarification_reads AS r
   SET last_read_message_id = COALESCE((
     SELECT max(m.message_id) FROM public.clarification_messages AS m
      WHERE m.clarification_id = r.clarification_id AND m.created_at <= r.last_read_at
   ), 0);

-- Called by message writers while they hold the event lock. Their response
-- includes the resulting thread. Internal helper grants remain unchanged.
CREATE OR REPLACE FUNCTION public._mark_clarification_read(p_clarification_id integer, p_user_id integer)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.clarification_reads (clarification_id, user_id, last_read_at, last_read_message_id)
  VALUES (p_clarification_id, p_user_id, clock_timestamp(), COALESCE((
    SELECT max(message_id) FROM public.clarification_messages WHERE clarification_id = p_clarification_id
  ), 0))
  ON CONFLICT (clarification_id, user_id) DO UPDATE
    SET last_read_at = EXCLUDED.last_read_at,
        last_read_message_id = GREATEST(public.clarification_reads.last_read_message_id, EXCLUDED.last_read_message_id);
$$;

-- Serialize against message writers using the same event -> thread lock order.
-- If another message committed after the GET, preserve unread/notification state.
CREATE FUNCTION public.mark_clarification_read(
  p_event_id integer, p_round_number integer, p_actor_id integer, p_last_message_id integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_round public.clarifications;
  v_latest integer;
BEGIN
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND OR p_last_message_id IS NULL OR p_last_message_id < 0 THEN RETURN false; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."user" AS u WHERE u.user_id = p_actor_id AND u.is_active
      AND ((u.role = 'ORGANISER' AND v_event.organiser_id = p_actor_id)
        OR (u.role = 'COORDINATOR' AND v_event.coordinator_id = p_actor_id))
  ) THEN RETURN false; END IF;

  SELECT * INTO v_round FROM public.clarifications
   WHERE event_id = p_event_id AND round_number = p_round_number FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT COALESCE(max(message_id), 0) INTO v_latest FROM public.clarification_messages
   WHERE clarification_id = v_round.clarification_id;
  IF p_last_message_id <> v_latest THEN RETURN false; END IF;
  PERFORM public._mark_clarification_read(v_round.clarification_id, p_actor_id);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_clarification_read(integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_clarification_read(integer, integer, integer, integer) TO service_role;

-- Retain the old signature during rollout, but callers without an observed
-- message ID cannot safely acknowledge a thread. Old clients remain readable.
CREATE OR REPLACE FUNCTION public.mark_clarification_read(p_event_id integer, p_round_number integer, p_actor_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN;
END;
$$;

-- Transaction-start time can precede a read that acquired the event lock first.
-- Use actual notification time so that such a message still closes the throttle.
CREATE OR REPLACE FUNCTION public._notify_clarification_party(
  p_round public.clarifications, p_recipient integer, p_title text, p_message text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  INSERT INTO public.clarification_reads (clarification_id, user_id, last_notified_at)
  VALUES (p_round.clarification_id, p_recipient, v_now)
  ON CONFLICT (clarification_id, user_id) DO UPDATE SET last_notified_at = v_now
   WHERE public.clarification_reads.last_notified_at IS NULL
      OR public.clarification_reads.last_read_at >= public.clarification_reads.last_notified_at;
  IF FOUND THEN
    PERFORM public._notify_event_users(p_round.event_id, p_title, p_message, ARRAY[p_recipient]);
  END IF;
END;
$$;
