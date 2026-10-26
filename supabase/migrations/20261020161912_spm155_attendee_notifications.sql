-- SPM-155 (SPM-157, SPM-159, SPM-160): attendee notifications for AC1-AC3 and
-- AC5. New functions only; nothing existing is changed.
--
-- The workflows that cause these notifications belong to other tickets and do
-- not exist yet. Each one PERFORMs its function below inside its own database
-- function, after its own writes, so the notification commits or rolls back
-- with the action (Master 7.1, 8). Every function sets an action key, so a
-- repeated call for the same action writes nothing.
--
--   Registration or waitlist joined (SPM-134, SPM-163)
--       _notify_registration_recorded(registration_id)
--   Waitlist place offered (SPM-163)
--       _notify_place_offered(registration_id, offer_id, expires_at)
--   Event cancelled (cancellation ticket). Registrations must keep their
--   REGISTERED or WAITLISTED status: the CANCELLED event closes them, and a
--   WITHDRAWN registration would hide the notice (AC6).
--       _notify_event_cancelled_attendees(event_id)
--   Attendee-facing details changed at reconfirmation (SPM-173 confirm_event,
--   with the previous and new confirmation snapshots)
--       _notify_event_changed_attendees(event_id, previous_snapshot, current_snapshot)
--
-- Wording never includes reasons, staff names, internal notes or other
-- attendees. Times are shown in Singapore time, as the frontend does.

CREATE FUNCTION public._attendee_datetime_text(p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_at IS NULL THEN 'a date to be confirmed'
    ELSE to_char(p_at AT TIME ZONE 'Asia/Singapore', 'FMDy FMDD Mon YYYY, FMHH12:MI AM') || ' SGT'
  END;
$$;

-- Active attendees with a place on the event, registered or waitlisted.
CREATE FUNCTION public._event_attendee_recipients(p_event_id integer)
RETURNS integer[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(array_agg(r.attendee_id ORDER BY r.attendee_id), ARRAY[]::integer[])
    FROM public.registration AS r
    JOIN public."user" AS u ON u.user_id = r.attendee_id AND u.is_active
   WHERE r.event_id = p_event_id
     AND r.registration_status IN ('REGISTERED', 'WAITLISTED');
$$;

-- AC1: confirms the registration or waitlist place the row now records. Call
-- after inserting or updating the registration. A re-entry after withdrawal
-- has a new registration time, so it is a new action and notifies again.
CREATE FUNCTION public._notify_registration_recorded(p_registration_id integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_registration public.registration;
  v_event public.event;
  v_recipients integer[];
BEGIN
  SELECT * INTO v_registration FROM public.registration WHERE registration_id = p_registration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'REGISTRATION_NOT_FOUND';
  END IF;
  SELECT * INTO v_event FROM public.event WHERE event_id = v_registration.event_id;
  v_recipients := ARRAY(
    SELECT user_id FROM public."user" WHERE user_id = v_registration.attendee_id AND is_active
  );

  IF v_registration.registration_status = 'REGISTERED' THEN
    RETURN public._notify_event_users(
      v_event.event_id,
      'Registration confirmed',
      format('You''re registered for "%s" on %s.', v_event.title, public._attendee_datetime_text(v_event.start_datetime)),
      v_recipients,
      'REGISTRATION_CONFIRMED',
      format('REGISTRATION:%s:REGISTERED:%s', p_registration_id, public._notification_key_time(v_registration.registration_datetime)),
      NULL
    );
  ELSIF v_registration.registration_status = 'WAITLISTED' THEN
    RETURN public._notify_event_users(
      v_event.event_id,
      'Waitlisted',
      format('"%s" is full, so you''re on the waitlist. We''ll tell you if a place opens up.', v_event.title),
      v_recipients,
      'WAITLIST_JOINED',
      format('REGISTRATION:%s:WAITLISTED:%s', p_registration_id, public._notification_key_time(v_registration.registration_datetime)),
      NULL
    );
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_NOT_ACTIVE';
END;
$$;

-- AC3: action required, with the offer's expiry. Call after the offer row is
-- created; p_offer_id is that row's ID and identifies the action.
CREATE FUNCTION public._notify_place_offered(
  p_registration_id integer,
  p_offer_id bigint,
  p_expires_at timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_registration public.registration;
  v_event public.event;
BEGIN
  IF p_offer_id IS NULL OR p_offer_id < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'OFFER_ID_INVALID';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'OFFER_EXPIRY_INVALID';
  END IF;
  SELECT * INTO v_registration FROM public.registration WHERE registration_id = p_registration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'REGISTRATION_NOT_FOUND';
  END IF;
  IF v_registration.registration_status <> 'WAITLISTED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_NOT_WAITLISTED';
  END IF;
  SELECT * INTO v_event FROM public.event WHERE event_id = v_registration.event_id;

  RETURN public._notify_event_users(
    v_event.event_id,
    'Action required: a place is available',
    format(
      'A place is available for "%s". Accept or decline it by %s, or it will be offered to the next person.',
      v_event.title,
      public._attendee_datetime_text(p_expires_at)
    ),
    ARRAY(SELECT user_id FROM public."user" WHERE user_id = v_registration.attendee_id AND is_active),
    'WAITLIST_OFFER',
    format('WAITLIST_OFFER:%s', p_offer_id),
    p_expires_at
  );
END;
$$;

-- AC2: every registered and waitlisted attendee. Call in the cancellation
-- transaction while their registrations are still REGISTERED or WAITLISTED.
CREATE FUNCTION public._notify_event_cancelled_attendees(p_event_id integer)
RETURNS integer
LANGUAGE plpgsql
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

  RETURN public._notify_event_users(
    p_event_id,
    'Event cancelled',
    CASE
      WHEN v_event.start_datetime IS NULL THEN format('"%s" has been cancelled.', v_event.title)
      ELSE format('"%s", scheduled for %s, has been cancelled.', v_event.title, public._attendee_datetime_text(v_event.start_datetime))
    END,
    public._event_attendee_recipients(p_event_id),
    'EVENT_CANCELLED',
    format('EVENT_CANCELLED:%s', p_event_id),
    NULL
  );
END;
$$;

-- AC5: tells registered and waitlisted attendees what kind of detail changed
-- between two confirmation snapshots (SPM-173's _event_attendee_snapshot).
-- Writes nothing for a first confirmation or when nothing attendee-facing
-- changed. Call after the event's new version is written.
CREATE FUNCTION public._notify_event_changed_attendees(
  p_event_id integer,
  p_previous jsonb,
  p_current jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_changes text[] := ARRAY[]::text[];
BEGIN
  IF p_previous IS NULL OR p_current IS NULL OR p_previous = p_current THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  IF p_previous->'start_datetime' IS DISTINCT FROM p_current->'start_datetime'
     OR p_previous->'end_datetime' IS DISTINCT FROM p_current->'end_datetime' THEN
    v_changes := array_append(v_changes, 'date and time');
  END IF;
  IF p_previous->'primary_venue' IS DISTINCT FROM p_current->'primary_venue' THEN
    v_changes := array_append(v_changes, 'venue');
  END IF;
  IF cardinality(v_changes) = 0 THEN
    v_changes := ARRAY['details'];
  END IF;

  RETURN public._notify_event_users(
    p_event_id,
    'Event details changed',
    format(
      'The %s for "%s" changed. Open My Events to see the latest information.',
      array_to_string(v_changes, ' and '),
      v_event.title
    ),
    public._event_attendee_recipients(p_event_id),
    'EVENT_CHANGED',
    format('EVENT_CHANGED:%s:v%s', p_event_id, v_event.version),
    NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public._attendee_datetime_text(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_attendee_recipients(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_registration_recorded(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_place_offered(integer, bigint, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_event_cancelled_attendees(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_event_changed_attendees(integer, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
