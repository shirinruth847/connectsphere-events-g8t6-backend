-- SPM-158 (SPM-155 AC7): one reminder per registered attendee about 24 hours
-- before their event starts. A new function only; nothing existing is changed.
--
-- Called by jobs/eventReminderJob.js through the service role; there is no
-- HTTP trigger. Correctness comes from the database, not the timer (Master 8):
--   * database time decides what is due;
--   * claim, notification and completion marker commit together: the
--     notification's unique action key is the durable record that the
--     reminder was sent, so a crash rolls the batch back for the next run and
--     no lease is needed;
--   * FOR UPDATE ... SKIP LOCKED keeps parallel runs off each other's rows,
--     and the unique key stops any duplicate that slips through;
--   * p_limit bounds each batch.
-- The key includes the start time, so a rescheduled event is reminded once
-- more for its new date. Registrations made within 24 hours of the start get
-- no reminder: their confirmation already gave them the time.
CREATE FUNCTION public.send_due_event_reminders(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_due record;
  v_sent integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_LIMIT';
  END IF;

  FOR v_due IN
    SELECT r.attendee_id, e.event_id, e.title, e.start_datetime
      FROM public.registration AS r
      JOIN public.event AS e ON e.event_id = r.event_id
      JOIN public."user" AS u ON u.user_id = r.attendee_id AND u.is_active
     WHERE r.registration_status = 'REGISTERED'
       AND e.status IN ('CONFIRMED', 'PREPARATION')
       AND e.start_datetime > now()
       AND e.start_datetime <= now() + interval '24 hours'
       AND r.registration_datetime <= e.start_datetime - interval '24 hours'
       AND NOT EXISTS (
         SELECT 1 FROM public.notification AS n
          WHERE n.action_key = format('EVENT_REMINDER:%s:%s:%s', e.event_id, r.attendee_id, public._notification_key_time(e.start_datetime))
       )
     ORDER BY e.start_datetime, r.registration_id
     LIMIT p_limit
     FOR UPDATE OF r SKIP LOCKED
  LOOP
    IF public._notify_event_users(
      v_due.event_id,
      'Event reminder',
      format('Reminder: "%s" starts %s.', v_due.title, public._attendee_datetime_text(v_due.start_datetime)),
      ARRAY[v_due.attendee_id],
      'EVENT_REMINDER',
      format('EVENT_REMINDER:%s:%s:%s', v_due.event_id, v_due.attendee_id, public._notification_key_time(v_due.start_datetime)),
      NULL
    ) IS NOT NULL THEN
      v_sent := v_sent + 1;
    END IF;
  END LOOP;

  RETURN v_sent;
END;
$$;

REVOKE ALL ON FUNCTION public.send_due_event_reminders(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_due_event_reminders(integer) TO service_role;
