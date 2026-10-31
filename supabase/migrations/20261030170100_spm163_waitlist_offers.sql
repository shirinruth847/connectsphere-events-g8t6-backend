-- SPM-163 Join Event Waitlist: queue, offers, accept/decline, expiry cascade.
--   * registration.queue_order is the FIFO position (Master 5.6). A trigger
--     owns it: joining takes the back of the queue, re-entry after withdrawal
--     takes a new place (D05), leaving clears it.
--   * waitlist_offer holds a place for one waitlisted attendee (Master 6.2,
--     6.3: one OPEN offer per registration). The registration stays WAITLISTED
--     while the offer is open. An offer lasts 24 hours, capped at registration
--     close and event start (D05).
--   * _offer_freed_places is the one "place freed -> offer the next person"
--     step. Withdrawal (SPM-147), leave, decline and expiry all call it while
--     holding the event lock, in the same transaction (Master 5.6, 7.1).
--   * An overdue offer is treated as expired at read time, so it never takes a
--     place even before the expiry job runs (Master 5.6, 8).
--   * Decline and expiry withdraw the registration (D05); leaving with an open
--     offer counts as a decline.
-- Lock order: event, then registrations, then offers (Master 7).

-- ---------- queue order ----------

CREATE SEQUENCE public.registration_queue_order_seq AS bigint;

ALTER TABLE public.registration ADD COLUMN queue_order bigint;

-- Existing waitlisted rows keep their arrival order.
UPDATE public.registration AS r
   SET queue_order = ranked.queue_order
  FROM (
    SELECT registration_id, row_number() OVER (ORDER BY registration_datetime, registration_id) AS queue_order
      FROM public.registration
     WHERE registration_status = 'WAITLISTED'
  ) AS ranked
 WHERE r.registration_id = ranked.registration_id;

SELECT setval('public.registration_queue_order_seq', COALESCE(max(queue_order), 0) + 1, false)
  FROM public.registration;

ALTER TABLE public.registration
  ADD CONSTRAINT registration_queue_order_check
    CHECK ((registration_status = 'WAITLISTED') = (queue_order IS NOT NULL));

CREATE UNIQUE INDEX registration_waitlist_queue_idx
  ON public.registration (event_id, queue_order)
  WHERE queue_order IS NOT NULL;

CREATE FUNCTION public._set_registration_queue_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.registration_status = 'WAITLISTED' THEN
    IF TG_OP = 'INSERT' OR OLD.registration_status <> 'WAITLISTED' THEN
      NEW.queue_order := nextval('public.registration_queue_order_seq');
    ELSE
      NEW.queue_order := OLD.queue_order;
    END IF;
  ELSE
    NEW.queue_order := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER registration_queue_order
  BEFORE INSERT OR UPDATE ON public.registration
  FOR EACH ROW EXECUTE FUNCTION public._set_registration_queue_order();

-- ---------- offers ----------

CREATE TABLE public.waitlist_offer (
  offer_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registration_id integer NOT NULL REFERENCES public.registration (registration_id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'OPEN',
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  CONSTRAINT waitlist_offer_state_check CHECK (state IN ('OPEN', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED')),
  CONSTRAINT waitlist_offer_window_check CHECK (expires_at > offered_at),
  CONSTRAINT waitlist_offer_response_check CHECK ((state = 'OPEN') = (responded_at IS NULL))
);

CREATE UNIQUE INDEX waitlist_offer_one_open_idx
  ON public.waitlist_offer (registration_id)
  WHERE state = 'OPEN';

CREATE INDEX waitlist_offer_due_idx
  ON public.waitlist_offer (expires_at)
  WHERE state = 'OPEN';

ALTER TABLE public.waitlist_offer ENABLE ROW LEVEL SECURITY;

DO $idempotency_operations$
DECLARE
  v_existing_check text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT v_existing_check
    FROM pg_constraint
   WHERE conrelid = 'public.idempotency_records'::regclass
     AND conname = 'idempotency_records_operation_check'
     AND contype = 'c';
  EXECUTE format(
    'ALTER TABLE public.idempotency_records
       DROP CONSTRAINT idempotency_records_operation_check,
       ADD CONSTRAINT idempotency_records_operation_check CHECK ((%s) OR operation = ANY (ARRAY[%L, %L, %L, %L]))',
    v_existing_check,
    'registration.join_waitlist', 'registration.leave_waitlist',
    'registration.accept_offer', 'registration.decline_offer'
  );
END;
$idempotency_operations$;

-- ---------- shared reads ----------

-- Capacity minus registered places minus places held by open offers. NULL when
-- the event has no capacity limit.
CREATE FUNCTION public._free_places(p_event_id integer)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.registration_capacity
         - (SELECT count(*) FROM public.registration AS r
             WHERE r.event_id = e.event_id AND r.registration_status = 'REGISTERED')::integer
         - (SELECT count(*) FROM public.waitlist_offer AS o
              JOIN public.registration AS r ON r.registration_id = o.registration_id
             WHERE r.event_id = e.event_id AND o.state = 'OPEN')::integer
    FROM public.event AS e
   WHERE e.event_id = p_event_id;
$$;

-- 1-based place in the event's queue; NULL when not waitlisted.
CREATE FUNCTION public._waitlist_position(p_registration_id integer)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
    FROM public.registration AS mine
    JOIN public.registration AS ahead
      ON ahead.event_id = mine.event_id
     AND ahead.registration_status = 'WAITLISTED'
     AND ahead.queue_order <= mine.queue_order
   WHERE mine.registration_id = p_registration_id
     AND mine.registration_status = 'WAITLISTED'
  HAVING count(*) > 0;
$$;

-- The attendee's own waitlist places with their position and any open offer.
-- An overdue offer is not shown: it can no longer be accepted.
CREATE FUNCTION public.list_waitlist_positions(p_attendee_id integer)
RETURNS TABLE (
  registration_id integer,
  event_id integer,
  waitlist_position integer,
  offer_id bigint,
  offer_expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.registration_id,
         r.event_id,
         public._waitlist_position(r.registration_id),
         o.offer_id,
         o.expires_at
    FROM public.registration AS r
    LEFT JOIN public.waitlist_offer AS o
      ON o.registration_id = r.registration_id
     AND o.state = 'OPEN'
     AND o.expires_at > now()
   WHERE r.attendee_id = p_attendee_id
     AND r.registration_status = 'WAITLISTED'
   ORDER BY r.event_id;
$$;

CREATE FUNCTION public._waitlist_action_result(p_registration_id integer, p_outcome text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'registration', jsonb_build_object(
      'registration_id', r.registration_id,
      'registration_status', r.registration_status,
      'registration_datetime', r.registration_datetime,
      'withdrawal_date', r.withdrawal_date,
      'waitlist_position', public._waitlist_position(r.registration_id),
      'outcome', p_outcome
    ),
    'event', jsonb_build_object(
      'event_id', e.event_id,
      'title', e.title,
      'start_datetime', e.start_datetime,
      'end_datetime', e.end_datetime
    )
  )
    FROM public.registration AS r
    JOIN public.event AS e ON e.event_id = r.event_id
   WHERE r.registration_id = p_registration_id;
$$;

-- ---------- notifications (rebuilt from live SPM-155 / SPM-193) ----------

CREATE OR REPLACE FUNCTION public._notify_registration_recorded(p_registration_id integer)
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
      format(
        'You are on the waitlist for "%s". Position: %s. You''ll be notified if a spot opens.',
        v_event.title,
        public._waitlist_position(p_registration_id)
      ),
      v_recipients,
      'WAITLIST_JOINED',
      format('REGISTRATION:%s:WAITLISTED:%s', p_registration_id, public._notification_key_time(v_registration.registration_datetime)),
      NULL
    );
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_NOT_ACTIVE';
END;
$$;

CREATE OR REPLACE FUNCTION public._notify_place_offered(p_registration_id integer, p_offer_id bigint, p_expires_at timestamptz)
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

  -- The window is shorter than 24 hours when registration closes or the event
  -- starts sooner (D05); the message then gives only the real deadline.
  RETURN public._notify_event_users(
    v_event.event_id,
    'Action required: a place is available',
    CASE
      WHEN p_expires_at >= now() + interval '24 hours' THEN format(
        'A spot has opened in "%s"! You have 24 hours to accept or decline (until %s).',
        v_event.title,
        public._attendee_datetime_text(p_expires_at)
      )
      ELSE format(
        'A spot has opened in "%s"! You have until %s to accept or decline.',
        v_event.title,
        public._attendee_datetime_text(p_expires_at)
      )
    END,
    ARRAY(SELECT user_id FROM public."user" WHERE user_id = v_registration.attendee_id AND is_active),
    'WAITLIST_OFFER',
    format('WAITLIST_OFFER:%s', p_offer_id),
    p_expires_at
  );
END;
$$;

-- Unchanged except: an attendee keeps seeing WAITLIST_LEFT and
-- REGISTRATION_WITHDRAWN after their place has ended.
CREATE OR REPLACE FUNCTION public._notification_visible(
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
           AND (
             r.registration_status IN ('REGISTERED', 'WAITLISTED')
             OR p_type IN ('WAITLIST_LEFT', 'REGISTRATION_WITHDRAWN')
           )
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

-- ---------- shared steps (caller holds the event lock) ----------

-- Ends a waitlist place: LEFT (no offer), DECLINED or EXPIRED (with its offer).
-- The registration becomes WITHDRAWN and the attendee is told how to return.
CREATE FUNCTION public._end_waitlist_place(
  p_registration_id integer,
  p_offer_id bigint,
  p_outcome text,
  p_actor_id integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_registration public.registration;
  v_title text;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('LEFT', 'DECLINED', 'EXPIRED')
     OR (p_outcome = 'LEFT') <> (p_offer_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'WAITLIST_OUTCOME_INVALID';
  END IF;

  IF p_offer_id IS NOT NULL THEN
    UPDATE public.waitlist_offer
       SET state = p_outcome, responded_at = now()
     WHERE offer_id = p_offer_id
       AND registration_id = p_registration_id
       AND state = 'OPEN';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_NOT_OPEN';
    END IF;
  END IF;

  UPDATE public.registration
     SET registration_status = 'WITHDRAWN', withdrawal_date = now()
   WHERE registration_id = p_registration_id
     AND registration_status = 'WAITLISTED'
  RETURNING * INTO v_registration;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOT_WAITLISTED';
  END IF;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, audience, actor_role)
  VALUES (
    p_actor_id,
    'registration',
    p_registration_id,
    CASE p_outcome
      WHEN 'LEFT' THEN 'WAITLIST_LEFT'
      WHEN 'DECLINED' THEN 'WAITLIST_OFFER_DECLINED'
      ELSE 'WAITLIST_OFFER_EXPIRED'
    END,
    CASE
      WHEN p_offer_id IS NULL THEN format('Left the waitlist for event %s', v_registration.event_id)
      ELSE format('Waitlist offer %s %s for event %s', p_offer_id, lower(p_outcome), v_registration.event_id)
    END,
    'STAFF_ONLY',
    CASE WHEN p_actor_id IS NULL THEN 'SYSTEM' END
  );

  SELECT title INTO v_title FROM public.event WHERE event_id = v_registration.event_id;
  PERFORM public._notify_event_users(
    v_registration.event_id,
    CASE p_outcome
      WHEN 'EXPIRED' THEN 'Place offer expired'
      WHEN 'DECLINED' THEN 'Place declined'
      ELSE 'You left the waitlist'
    END,
    format(
      '%s To attend, register again; if the event is still full, you''ll join the back of the waitlist.',
      CASE p_outcome
        WHEN 'EXPIRED' THEN format('Your offer of a place at "%s" expired, so you''ve left the waitlist.', v_title)
        WHEN 'DECLINED' THEN format('You declined the place at "%s" and left the waitlist.', v_title)
        ELSE format('You left the waitlist for "%s".', v_title)
      END
    ),
    ARRAY(SELECT user_id FROM public."user" WHERE user_id = v_registration.attendee_id AND is_active),
    'WAITLIST_LEFT',
    format('WAITLIST_LEFT:%s:%s', p_registration_id, public._notification_key_time(v_registration.withdrawal_date)),
    NULL
  );
END;
$$;

CREATE FUNCTION public._expire_overdue_waitlist_offers(p_event_id integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_due record;
  v_expired integer := 0;
BEGIN
  FOR v_due IN
    SELECT o.offer_id, o.registration_id
      FROM public.waitlist_offer AS o
      JOIN public.registration AS r ON r.registration_id = o.registration_id
     WHERE r.event_id = p_event_id
       AND o.state = 'OPEN'
       AND o.expires_at <= now()
     ORDER BY o.registration_id
     FOR UPDATE OF r, o
  LOOP
    PERFORM public._end_waitlist_place(v_due.registration_id, v_due.offer_id, 'EXPIRED', NULL);
    v_expired := v_expired + 1;
  END LOOP;
  RETURN v_expired;
END;
$$;

-- Offers every free place to the earliest waitlisted attendees without an
-- offer. Offers are made only while the event takes registrations (published,
-- CONFIRMED, before close and start).
CREATE FUNCTION public._offer_freed_places(p_event_id integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_free integer;
  v_expires_at timestamptz;
  v_next record;
  v_offer_id bigint;
  v_offered integer := 0;
BEGIN
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id;
  IF NOT FOUND
     OR NOT v_event.is_published
     OR v_event.status <> 'CONFIRMED'
     OR v_event.registration_capacity IS NULL
     OR v_event.start_datetime IS NULL THEN
    RETURN 0;
  END IF;

  v_expires_at := LEAST(
    now() + interval '24 hours',
    v_event.start_datetime,
    COALESCE(v_event.registration_close_at, 'infinity'::timestamptz)
  );
  IF v_expires_at <= now() THEN
    RETURN 0;
  END IF;

  v_free := public._free_places(p_event_id);
  IF v_free <= 0 THEN
    RETURN 0;
  END IF;

  FOR v_next IN
    SELECT r.registration_id
      FROM public.registration AS r
      JOIN public."user" AS u ON u.user_id = r.attendee_id AND u.is_active
     WHERE r.event_id = p_event_id
       AND r.registration_status = 'WAITLISTED'
       AND NOT EXISTS (
         SELECT 1 FROM public.waitlist_offer AS o
          WHERE o.registration_id = r.registration_id AND o.state = 'OPEN'
       )
     ORDER BY r.queue_order
     LIMIT v_free
     FOR UPDATE OF r
  LOOP
    INSERT INTO public.waitlist_offer (registration_id, offered_at, expires_at)
    VALUES (v_next.registration_id, now(), v_expires_at)
    RETURNING offer_id INTO v_offer_id;

    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, audience, actor_role)
    VALUES (
      NULL,
      'registration',
      v_next.registration_id,
      'WAITLIST_OFFER_CREATED',
      format('Waitlist offer %s for event %s, open until %s', v_offer_id, p_event_id, v_expires_at),
      'STAFF_ONLY',
      'SYSTEM'
    );

    PERFORM public._notify_place_offered(v_next.registration_id, v_offer_id, v_expires_at);
    v_offered := v_offered + 1;
  END LOOP;
  RETURN v_offered;
END;
$$;

-- ---------- attendee actions ----------
-- Refusals are P0001 with a stable message:
--   EVENT_NOT_FOUND     event hidden or missing, or no place on it
--   NOT_ATTENDEE        not an active ATTENDEE
--   ALREADY_REGISTERED / ALREADY_WAITLISTED
--   REGISTRATION_CLOSED registration has closed, or is paused for replanning
--   PLACES_AVAILABLE    the event is not full: register directly
--   NOT_WAITLISTED      no waitlist place to leave
--   OFFER_NOT_FOUND     no such offer on this attendee's place
--   OFFER_EXPIRED       the offer's window has passed (job may not have run)
--   OFFER_NOT_OPEN      the offer was already accepted, declined or cancelled
--   REGISTRATION_FULL   capacity was reduced below the offered place

CREATE FUNCTION public.join_event_waitlist(
  p_attendee_id integer,
  p_event_id integer,
  p_dietary_restrictions text,
  p_accessibility_requirements text,
  p_idempotency_key text DEFAULT NULL,
  p_request_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_replay jsonb;
  v_event public.event;
  v_existing public.registration;
  v_registration public.registration;
  v_free integer;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_attendee_id, 'registration.join_waitlist', p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  -- Same lock and visibility as register_for_event (SPM-134).
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND
     OR NOT v_event.is_published
     OR v_event.end_datetime IS NULL
     OR v_event.end_datetime <= now()
     OR v_event.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  PERFORM 1 FROM public."user"
   WHERE user_id = p_attendee_id AND role = 'ATTENDEE' AND is_active
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOT_ATTENDEE';
  END IF;

  SELECT * INTO v_existing
    FROM public.registration
   WHERE attendee_id = p_attendee_id AND event_id = p_event_id
   FOR UPDATE;
  IF v_existing.registration_status = 'REGISTERED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ALREADY_REGISTERED';
  ELSIF v_existing.registration_status = 'WAITLISTED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ALREADY_WAITLISTED';
  END IF;

  IF v_event.registration_close_at IS NOT NULL AND now() >= v_event.registration_close_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_CLOSED';
  END IF;

  -- Places freed by overdue offers go to the people already queued first.
  PERFORM public._expire_overdue_waitlist_offers(p_event_id);
  PERFORM public._offer_freed_places(p_event_id);
  v_free := public._free_places(p_event_id);
  IF v_free IS NULL OR v_free > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PLACES_AVAILABLE';
  END IF;

  IF v_existing.registration_id IS NULL THEN
    INSERT INTO public.registration (
      attendee_id, event_id, registration_status, registration_datetime,
      dietary_restrictions, accessibility_requirements
    )
    VALUES (p_attendee_id, p_event_id, 'WAITLISTED', now(), p_dietary_restrictions, p_accessibility_requirements)
    RETURNING * INTO v_registration;
  ELSE
    UPDATE public.registration
       SET registration_status = 'WAITLISTED',
           registration_datetime = now(),
           withdrawal_date = NULL,
           dietary_restrictions = p_dietary_restrictions,
           accessibility_requirements = p_accessibility_requirements
     WHERE registration_id = v_existing.registration_id
    RETURNING * INTO v_registration;
  END IF;

  -- No dietary or accessibility text in the audit entry: it is personal data.
  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, audience)
  VALUES (
    p_attendee_id,
    'registration',
    v_registration.registration_id,
    CASE WHEN v_existing.registration_id IS NULL THEN 'WAITLIST_JOINED' ELSE 'WAITLIST_REENTERED' END,
    format('Joined the waitlist for event %s', p_event_id),
    'STAFF_ONLY'
  );

  PERFORM public._notify_registration_recorded(v_registration.registration_id);

  RETURN public._store_idempotent_response(
    p_attendee_id,
    'registration.join_waitlist',
    p_idempotency_key,
    public._waitlist_action_result(v_registration.registration_id, 'JOINED')
  );
END;
$$;

CREATE FUNCTION public.leave_event_waitlist(
  p_attendee_id integer,
  p_event_id integer,
  p_idempotency_key text DEFAULT NULL,
  p_request_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_replay jsonb;
  v_registration public.registration;
  v_offer public.waitlist_offer;
  v_outcome text;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_attendee_id, 'registration.leave_waitlist', p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  PERFORM 1 FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  SELECT * INTO v_registration
    FROM public.registration
   WHERE attendee_id = p_attendee_id AND event_id = p_event_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  IF v_registration.registration_status <> 'WAITLISTED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOT_WAITLISTED';
  END IF;

  -- An overdue offer of their own ends as EXPIRED here, not as a decline.
  PERFORM public._expire_overdue_waitlist_offers(p_event_id);
  SELECT * INTO v_registration FROM public.registration WHERE registration_id = v_registration.registration_id;

  IF v_registration.registration_status = 'WAITLISTED' THEN
    SELECT * INTO v_offer
      FROM public.waitlist_offer
     WHERE registration_id = v_registration.registration_id AND state = 'OPEN'
     FOR UPDATE;
    v_outcome := CASE WHEN FOUND THEN 'DECLINED' ELSE 'LEFT' END;
    PERFORM public._end_waitlist_place(v_registration.registration_id, v_offer.offer_id, v_outcome, p_attendee_id);
  ELSE
    v_outcome := 'EXPIRED';
  END IF;

  PERFORM public._offer_freed_places(p_event_id);

  RETURN public._store_idempotent_response(
    p_attendee_id,
    'registration.leave_waitlist',
    p_idempotency_key,
    public._waitlist_action_result(v_registration.registration_id, v_outcome)
  );
END;
$$;

CREATE FUNCTION public.accept_waitlist_offer(
  p_attendee_id integer,
  p_event_id integer,
  p_offer_id bigint,
  p_idempotency_key text DEFAULT NULL,
  p_request_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_replay jsonb;
  v_event public.event;
  v_registration public.registration;
  v_offer public.waitlist_offer;
  v_registered integer;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_attendee_id, 'registration.accept_offer', p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  -- The expiry job takes the same event lock and rechecks the offer, so an
  -- accept and an expiry at the same moment cannot both succeed.
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  PERFORM 1 FROM public."user"
   WHERE user_id = p_attendee_id AND role = 'ATTENDEE' AND is_active
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOT_ATTENDEE';
  END IF;

  SELECT * INTO v_registration
    FROM public.registration
   WHERE attendee_id = p_attendee_id AND event_id = p_event_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  SELECT * INTO v_offer
    FROM public.waitlist_offer
   WHERE offer_id = p_offer_id AND registration_id = v_registration.registration_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_NOT_FOUND';
  END IF;
  -- Read-time expiry: an overdue offer never takes a place (Master 5.6).
  IF v_offer.state = 'EXPIRED' OR (v_offer.state = 'OPEN' AND v_offer.expires_at <= now()) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_EXPIRED';
  END IF;
  IF v_offer.state <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_NOT_OPEN';
  END IF;

  IF NOT v_event.is_published OR v_event.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_CLOSED';
  END IF;

  IF v_event.registration_capacity IS NOT NULL THEN
    SELECT count(*) INTO v_registered
      FROM public.registration
     WHERE event_id = p_event_id AND registration_status = 'REGISTERED';
    IF v_registered >= v_event.registration_capacity THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REGISTRATION_FULL';
    END IF;
  END IF;

  UPDATE public.waitlist_offer
     SET state = 'ACCEPTED', responded_at = now()
   WHERE offer_id = v_offer.offer_id;

  UPDATE public.registration
     SET registration_status = 'REGISTERED',
         registration_datetime = now(),
         withdrawal_date = NULL
   WHERE registration_id = v_registration.registration_id
  RETURNING * INTO v_registration;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, audience)
  VALUES (
    p_attendee_id,
    'registration',
    v_registration.registration_id,
    'WAITLIST_OFFER_ACCEPTED',
    format('Waitlist offer %s accepted for event %s', v_offer.offer_id, p_event_id),
    'STAFF_ONLY'
  );

  PERFORM public._notify_registration_recorded(v_registration.registration_id);

  RETURN public._store_idempotent_response(
    p_attendee_id,
    'registration.accept_offer',
    p_idempotency_key,
    public._waitlist_action_result(v_registration.registration_id, 'ACCEPTED')
  );
END;
$$;

CREATE FUNCTION public.decline_waitlist_offer(
  p_attendee_id integer,
  p_event_id integer,
  p_offer_id bigint,
  p_idempotency_key text DEFAULT NULL,
  p_request_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_replay jsonb;
  v_registration public.registration;
  v_offer public.waitlist_offer;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_attendee_id, 'registration.decline_offer', p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  PERFORM 1 FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  SELECT * INTO v_registration
    FROM public.registration
   WHERE attendee_id = p_attendee_id AND event_id = p_event_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  SELECT * INTO v_offer
    FROM public.waitlist_offer
   WHERE offer_id = p_offer_id AND registration_id = v_registration.registration_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_NOT_FOUND';
  END IF;
  IF v_offer.state = 'EXPIRED' OR (v_offer.state = 'OPEN' AND v_offer.expires_at <= now()) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_EXPIRED';
  END IF;
  IF v_offer.state <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OFFER_NOT_OPEN';
  END IF;

  PERFORM public._end_waitlist_place(v_registration.registration_id, v_offer.offer_id, 'DECLINED', p_attendee_id);
  PERFORM public._expire_overdue_waitlist_offers(p_event_id);
  PERFORM public._offer_freed_places(p_event_id);

  RETURN public._store_idempotent_response(
    p_attendee_id,
    'registration.decline_offer',
    p_idempotency_key,
    public._waitlist_action_result(v_registration.registration_id, 'DECLINED')
  );
END;
$$;

-- ---------- expiry job (jobs/waitlistOfferExpiryJob.js) ----------

-- Expires overdue offers for up to p_limit events and offers the freed places
-- on. Database time and event locks make late, repeated or parallel runs safe:
-- a busy event is skipped and picked up by the next run.
CREATE FUNCTION public.expire_due_waitlist_offers(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event_id integer;
  v_expired integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_LIMIT';
  END IF;

  FOR v_event_id IN
    SELECT DISTINCT r.event_id
      FROM public.waitlist_offer AS o
      JOIN public.registration AS r ON r.registration_id = o.registration_id
     WHERE o.state = 'OPEN' AND o.expires_at <= now()
     ORDER BY r.event_id
     LIMIT p_limit
  LOOP
    PERFORM 1 FROM public.event WHERE event_id = v_event_id FOR UPDATE SKIP LOCKED;
    IF FOUND THEN
      v_expired := v_expired + public._expire_overdue_waitlist_offers(v_event_id);
      PERFORM public._offer_freed_places(v_event_id);
    END IF;
  END LOOP;
  RETURN v_expired;
END;
$$;

-- ---------- privileges ----------

REVOKE ALL ON public.waitlist_offer FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.registration_queue_order_seq FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._set_registration_queue_order() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._free_places(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._waitlist_position(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._waitlist_action_result(integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._end_waitlist_place(integer, bigint, text, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._expire_overdue_waitlist_offers(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._offer_freed_places(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_waitlist_positions(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.join_event_waitlist(integer, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leave_event_waitlist(integer, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_waitlist_offer(integer, integer, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decline_waitlist_offer(integer, integer, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_due_waitlist_offers(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_waitlist_positions(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.join_event_waitlist(integer, integer, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.leave_event_waitlist(integer, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.accept_waitlist_offer(integer, integer, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decline_waitlist_offer(integer, integer, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_due_waitlist_offers(integer) TO service_role;
