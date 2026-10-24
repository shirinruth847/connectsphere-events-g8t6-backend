-- SPM-41 v2: clarification rounds become chat threads (team decision, 2026-10-24).
--
-- A round ("Request <n>") is now a thread of immutable messages between the
-- assigned coordinator and the owner. While it is open the event stays in
-- AWAITING_CLARIFICATION and the owner may save amendments; only the coordinator
-- closes it, which returns the event to UNDER_REVIEW (Option A). The separate
-- resubmit step is removed.
--
-- clarifications keeps every column and row. A completed thread is stored as
-- status 'RESPONDED' with responded_by/responded_at naming the coordinator who
-- completed it, which the existing state checks and immutability trigger
-- already allow; the API reports it as COMPLETED.

-- ---------- idempotency operations ----------

-- Rebuilt from the live constraint as read on 2026-10-24 (12 operations). The
-- unused 'event.resubmit' stays to avoid churn.
ALTER TABLE public.idempotency_records DROP CONSTRAINT idempotency_records_operation_check;
ALTER TABLE public.idempotency_records
  ADD CONSTRAINT idempotency_records_operation_check CHECK (operation = ANY (ARRAY[
    'event.create_draft',
    'event.create_and_submit',
    'event.update_draft',
    'event.update_details',
    'event.submit_for_safety_review',
    'event.confirm',
    'event.start_preparation',
    'event.complete',
    'safety.decide',
    'event.suggest_venue',
    'event.request_clarification',
    'event.resubmit',
    'clarification.post_message',
    'event.save_amendments',
    'event.complete_clarification'
  ]));

-- ---------- SPM-173 transition table: one added row ----------

-- Rebuilt from the live definition; every existing row is unchanged (agreed with
-- the SPM-173 developer, 2026-10-24). 'complete_clarification' lets the assigned
-- coordinator return the event to review; 'resubmit' stays but is unused.
CREATE OR REPLACE FUNCTION public._lifecycle_transitions()
RETURNS TABLE (
  action text,
  from_states text[],
  to_state text,
  actor_role text,
  relationship text,
  allows_system boolean,
  activity_action text,
  audience text
)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  VALUES
    ('submit', ARRAY['DRAFT'], 'SUBMITTED', 'ORGANISER', 'OWNER', false, 'EVENT_SUBMITTED', 'ORGANISER_SAFE'),
    ('withdraw', ARRAY['SUBMITTED'], 'CANCELLED', 'ORGANISER', 'OWNER', false, 'EVENT_WITHDRAWN', 'ORGANISER_SAFE'),
    ('assign', ARRAY['SUBMITTED'], 'UNDER_REVIEW', 'COORDINATOR_LEAD', 'LEAD', false, 'COORDINATOR_ASSIGNED', 'STAFF_ONLY'),
    ('request_clarification', ARRAY['UNDER_REVIEW'], 'AWAITING_CLARIFICATION', 'COORDINATOR', 'ASSIGNED', false, 'CLARIFICATION_REQUESTED', 'ORGANISER_SAFE'),
    ('resubmit', ARRAY['AWAITING_CLARIFICATION'], 'UNDER_REVIEW', 'ORGANISER', 'OWNER', false, 'EVENT_RESUBMITTED', 'ORGANISER_SAFE'),
    ('complete_clarification', ARRAY['AWAITING_CLARIFICATION'], 'UNDER_REVIEW', 'COORDINATOR', 'ASSIGNED', false, 'CLARIFICATION_COMPLETED', 'ORGANISER_SAFE'),
    ('accept_feasibility', ARRAY['UNDER_REVIEW'], 'PLANNING', 'COORDINATOR', 'ASSIGNED', false, 'FEASIBILITY_ACCEPTED', 'ORGANISER_SAFE'),
    ('submit_for_safety_review', ARRAY['PLANNING'], 'SAFETY_REVIEW', 'COORDINATOR', 'ASSIGNED', false, 'SAFETY_REVIEW_SUBMITTED', 'STAFF_ONLY'),
    ('safety_changes_requested', ARRAY['SAFETY_REVIEW'], 'PLANNING', 'SAFETY_OFFICER', 'CLAIMANT', false, 'SAFETY_CHANGES_REQUESTED', 'ORGANISER_SAFE'),
    ('safety_rejected', ARRAY['SAFETY_REVIEW'], 'PLANNING', 'SAFETY_OFFICER', 'CLAIMANT', false, 'SAFETY_VENUES_REJECTED', 'ORGANISER_SAFE'),
    ('safety_superseded', ARRAY['SAFETY_REVIEW'], 'PLANNING', NULL, 'ANY', true, 'SAFETY_REVIEW_SUPERSEDED', 'STAFF_ONLY'),
    ('confirm', ARRAY['SAFETY_REVIEW'], 'CONFIRMED', 'COORDINATOR', 'ASSIGNED', false, 'EVENT_CONFIRMED', 'ORGANISER_SAFE'),
    ('start_preparation', ARRAY['CONFIRMED'], 'PREPARATION', 'COORDINATOR', 'ASSIGNED', false, 'PREPARATION_STARTED', 'STAFF_ONLY'),
    ('complete', ARRAY['CONFIRMED', 'PREPARATION'], 'COMPLETED', 'COORDINATOR', 'ASSIGNED', true, 'EVENT_COMPLETED', 'ORGANISER_SAFE'),
    ('reject', ARRAY['UNDER_REVIEW', 'AWAITING_CLARIFICATION', 'PLANNING', 'SAFETY_REVIEW'], 'REJECTED', 'COORDINATOR', 'ASSIGNED', false, 'EVENT_REJECTED', 'ORGANISER_SAFE'),
    ('accept_change', ARRAY['PLANNING', 'SAFETY_REVIEW', 'CONFIRMED', 'PREPARATION'], 'PLANNING', 'COORDINATOR', 'ASSIGNED', false, 'CHANGE_ACCEPTED', 'ORGANISER_SAFE'),
    ('cancel', ARRAY['UNDER_REVIEW', 'AWAITING_CLARIFICATION', 'PLANNING', 'SAFETY_REVIEW', 'CONFIRMED', 'PREPARATION'], 'CANCELLED', 'COORDINATOR', 'ASSIGNED', false, 'EVENT_CANCELLED', 'ORGANISER_SAFE'),
    ('venue_replacement', ARRAY['SAFETY_REVIEW', 'CONFIRMED', 'PREPARATION'], 'PLANNING', 'COORDINATOR', 'ASSIGNED', false, 'VENUE_REPLACEMENT_RAISED', 'ORGANISER_SAFE')
$$;

-- ---------- legacy columns ----------

COMMENT ON COLUMN public.clarifications.message IS
  'Legacy (SPM-41 v1): the thread''s opening question. Still written when a thread opens, and also stored as its first clarification_messages row; read the messages table.';
COMMENT ON COLUMN public.clarifications.response IS
  'Legacy (SPM-41 v1): the organiser''s single answer from the resubmit flow. No longer written; existing answers were copied to clarification_messages.';
COMMENT ON COLUMN public.clarifications.responded_by IS
  'Who closed the thread: the organiser who resubmitted (SPM-41 v1 rows) or the coordinator who marked it complete (v2).';

-- ---------- messages ----------

CREATE TABLE public.clarification_messages (
  message_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Named: the backend embeds threads and authors by constraint name.
  clarification_id integer NOT NULL
    CONSTRAINT clarification_messages_clarification_id_fkey REFERENCES public.clarifications (clarification_id) ON DELETE RESTRICT,
  author_id integer NOT NULL
    CONSTRAINT clarification_messages_author_id_fkey REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clarification_messages_body_check CHECK (btrim(body) <> '' AND char_length(body) <= 2000)
);

CREATE INDEX clarification_messages_thread
  ON public.clarification_messages (clarification_id, created_at, message_id);

-- Copy the v1 rounds: each question, then its answer if there was one.
INSERT INTO public.clarification_messages (clarification_id, author_id, body, created_at)
SELECT clarification_id, author_id, body, created_at
  FROM (
    SELECT clarification_id, requested_by AS author_id, message AS body, requested_at AS created_at, 1 AS position
      FROM public.clarifications
    UNION ALL
    SELECT clarification_id, responded_by, response, responded_at, 2
      FROM public.clarifications
     WHERE response IS NOT NULL
  ) AS legacy
 ORDER BY clarification_id, position;

-- Messages are never edited or deleted by the application (no grants), and
-- never rewritten by any function (this trigger). New ones go only into an
-- open thread; added after the copy above, which includes closed threads.
CREATE FUNCTION public._clarification_messages_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CLARIFICATION_MESSAGE_IMMUTABLE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.clarifications WHERE clarification_id = NEW.clarification_id AND status = 'OPEN'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CLARIFICATION_CLOSED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clarification_messages_guard
  BEFORE INSERT OR UPDATE ON public.clarification_messages
  FOR EACH ROW EXECUTE FUNCTION public._clarification_messages_guard();

-- ---------- who has read a thread, and the notification throttle ----------

-- A new message or amendment notifies the other party only when they have not
-- been notified since they last opened the thread.
CREATE TABLE public.clarification_reads (
  clarification_id integer NOT NULL
    CONSTRAINT clarification_reads_clarification_id_fkey REFERENCES public.clarifications (clarification_id) ON DELETE CASCADE,
  user_id integer NOT NULL
    CONSTRAINT clarification_reads_user_id_fkey REFERENCES public."user" (user_id) ON DELETE CASCADE,
  last_read_at timestamptz,
  last_notified_at timestamptz,
  PRIMARY KEY (clarification_id, user_id)
);

-- ---------- when each person last viewed an event's history ----------

-- Several people view one event's history, so this is per person (SPM-41 v2,
-- replicating SPM-181's "last opened" comparison on the server).
CREATE TABLE public.event_history_views (
  user_id integer NOT NULL
    CONSTRAINT event_history_views_user_id_fkey REFERENCES public."user" (user_id) ON DELETE CASCADE,
  event_id integer NOT NULL
    CONSTRAINT event_history_views_event_id_fkey REFERENCES public.event (event_id) ON DELETE CASCADE,
  last_viewed_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, event_id)
);

-- ---------- helpers ----------

-- The owner or the assigned coordinator, as an active user; anyone else is told
-- the event does not exist (as _check_event_transition does).
CREATE FUNCTION public._clarification_party(p_event public.event, p_actor_id integer)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1 FROM public."user" WHERE user_id = p_actor_id AND is_active;
  IF FOUND AND p_event.organiser_id = p_actor_id THEN
    RETURN 'OWNER';
  END IF;
  IF FOUND AND p_event.coordinator_id = p_actor_id THEN
    RETURN 'COORDINATOR';
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
END;
$$;

CREATE FUNCTION public._mark_clarification_read(p_clarification_id integer, p_user_id integer)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.clarification_reads (clarification_id, user_id, last_read_at)
  VALUES (p_clarification_id, p_user_id, now())
  ON CONFLICT (clarification_id, user_id) DO UPDATE SET last_read_at = now();
$$;

-- Notifies p_recipient unless they were notified about this thread and have not
-- opened it since. The check and the update are one statement, so two messages
-- sent at once cannot both notify.
CREATE FUNCTION public._notify_clarification_party(
  p_round public.clarifications,
  p_recipient integer,
  p_title text,
  p_message text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.clarification_reads (clarification_id, user_id, last_notified_at)
  VALUES (p_round.clarification_id, p_recipient, now())
  ON CONFLICT (clarification_id, user_id) DO UPDATE SET last_notified_at = now()
   WHERE public.clarification_reads.last_notified_at IS NULL
      OR public.clarification_reads.last_read_at >= public.clarification_reads.last_notified_at;
  IF FOUND THEN
    -- TODO(SPM-155): switch to the keyed _notify_event_users overload once its
    -- action-key format is agreed.
    PERFORM public._notify_event_users(p_round.event_id, p_title, p_message, ARRAY[p_recipient]);
  END IF;
END;
$$;

-- ---------- open a thread (assigned coordinator, UNDER_REVIEW) ----------

-- Replaces the v1 function (same signature): the question is also the thread's
-- first message, and the owner's notification starts the throttle.
CREATE OR REPLACE FUNCTION public.request_event_clarification(
  p_event_id integer,
  p_actor_id integer,
  p_expected_version integer,
  p_message text,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_operation constant text := 'event.request_clarification';
  v_event public.event;
  v_round public.clarifications;
  v_message text := btrim(p_message);
  v_replay jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_actor_id, v_operation, p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  -- UNDER_REVIEW only, so a previous thread is always complete first.
  PERFORM public._check_event_transition(v_event, 'request_clarification', p_actor_id, p_expected_version);

  IF v_message IS NULL OR v_message = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_CLARIFICATION', DETAIL = 'message:REQUIRED';
  END IF;
  IF char_length(v_message) > 2000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_CLARIFICATION', DETAIL = 'message:TOO_LONG';
  END IF;

  INSERT INTO public.clarifications (event_id, round_number, message, requested_by)
  VALUES (
    p_event_id,
    COALESCE((SELECT max(round_number) FROM public.clarifications WHERE event_id = p_event_id), 0) + 1,
    v_message,
    p_actor_id
  )
  RETURNING * INTO v_round;
  INSERT INTO public.clarification_messages (clarification_id, author_id, body)
  VALUES (v_round.clarification_id, p_actor_id, v_message);

  -- History: thread opened, with the full question (SPM-41 AC5).
  v_event := public._apply_event_transition(
    v_event,
    'request_clarification',
    p_actor_id,
    format('Clarification Request %s opened: %s', v_round.round_number, v_message)
  );

  PERFORM public._mark_clarification_read(v_round.clarification_id, p_actor_id);
  PERFORM public._notify_clarification_party(
    v_round,
    v_event.organiser_id,
    'Clarification requested',
    format(
      'Your event coordinator opened Request %s on event request REQ-%s "%s": %s Reply in the request, and amend it if needed.',
      v_round.round_number, lpad(p_event_id::text, 6, '0'), v_event.title, v_message
    )
  );

  RETURN public._store_idempotent_response(
    p_actor_id, v_operation, p_idempotency_key,
    public._event_response(v_event) || jsonb_build_object('clarification', to_jsonb(v_round))
  );
END;
$$;

-- ---------- post a message (owner or assigned coordinator, open thread) ----------

CREATE FUNCTION public.post_clarification_message(
  p_event_id integer,
  p_round_number integer,
  p_actor_id integer,
  p_body text,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_operation constant text := 'clarification.post_message';
  v_event public.event;
  v_round public.clarifications;
  v_party text;
  v_body text := btrim(p_body);
  v_message public.clarification_messages;
  v_replay jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_actor_id, v_operation, p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  -- The event lock orders messages against completion of the thread.
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  v_party := public._clarification_party(v_event, p_actor_id);

  SELECT * INTO v_round FROM public.clarifications
   WHERE event_id = p_event_id AND round_number = p_round_number
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'CLARIFICATION_NOT_FOUND';
  END IF;
  IF v_round.status <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CLARIFICATION_CLOSED';
  END IF;

  IF v_body IS NULL OR v_body = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_CLARIFICATION', DETAIL = 'body:REQUIRED';
  END IF;
  IF char_length(v_body) > 2000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_CLARIFICATION', DETAIL = 'body:TOO_LONG';
  END IF;

  INSERT INTO public.clarification_messages (clarification_id, author_id, body)
  VALUES (v_round.clarification_id, p_actor_id, v_body)
  RETURNING * INTO v_message;

  -- Writing in the thread means the author has read it.
  PERFORM public._mark_clarification_read(v_round.clarification_id, p_actor_id);
  PERFORM public._notify_clarification_party(
    v_round,
    CASE WHEN v_party = 'OWNER' THEN v_event.coordinator_id ELSE v_event.organiser_id END,
    'New clarification message',
    format(
      'There is a new message in Request %s on event request REQ-%s "%s". Open the request to read it.',
      v_round.round_number, lpad(p_event_id::text, 6, '0'), v_event.title
    )
  );

  RETURN public._store_idempotent_response(
    p_actor_id, v_operation, p_idempotency_key, jsonb_build_object('message', to_jsonb(v_message))
  );
END;
$$;

-- ---------- save amendments (owner, open thread) ----------

-- The v1 resubmit amendment rules, without the state change: the event stays in
-- AWAITING_CLARIFICATION until the coordinator completes the thread.
CREATE FUNCTION public.save_clarification_amendments(
  p_event_id integer,
  p_actor_id integer,
  p_expected_version integer,
  p_changes jsonb,
  p_venue_preferences jsonb,
  p_equipment_requirements jsonb,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_operation constant text := 'event.save_amendments';
  v_changes_in jsonb := COALESCE(p_changes, '{}'::jsonb);
  v_event public.event;
  v_before public.event;
  v_before_requirements jsonb;
  v_after_requirements jsonb;
  v_changes jsonb;
  v_round public.clarifications;
  v_replay jsonb;
BEGIN
  IF jsonb_typeof(v_changes_in) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_PATCH';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_actor_id, v_operation, p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  -- Same order as _check_event_transition: relationship, version, state.
  IF public._clarification_party(v_event, p_actor_id) <> 'OWNER' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version <> v_event.version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_VERSION_CONFLICT', DETAIL = v_event.status::text;
  END IF;
  IF v_event.status <> 'AWAITING_CLARIFICATION' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TRANSITION_NOT_ALLOWED', DETAIL = v_event.status::text;
  END IF;

  SELECT * INTO v_round FROM public.clarifications
   WHERE event_id = p_event_id AND status = 'OPEN'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CLARIFICATION_NOT_OPEN';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_changes_in) AS k(name)
     WHERE k.name NOT IN (
       'title', 'purpose', 'description', 'start_datetime', 'end_datetime',
       'expected_attendance', 'preferred_layout_type', 'accessibility_needs'
     )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FIELD_NOT_EDITABLE';
  END IF;

  v_before := v_event;
  v_before_requirements := public._event_response(v_event);

  IF v_changes_in <> '{}'::jsonb THEN
    UPDATE public.event AS e
       SET title = CASE WHEN v_changes_in ? 'title' THEN NULLIF(btrim(v_changes_in->>'title'), '') ELSE e.title END,
           purpose = CASE WHEN v_changes_in ? 'purpose' THEN NULLIF(btrim(v_changes_in->>'purpose'), '') ELSE e.purpose END,
           description = CASE WHEN v_changes_in ? 'description' THEN NULLIF(btrim(v_changes_in->>'description'), '') ELSE e.description END,
           start_datetime = CASE WHEN v_changes_in ? 'start_datetime' THEN NULLIF(v_changes_in->>'start_datetime', '')::timestamptz ELSE e.start_datetime END,
           end_datetime = CASE WHEN v_changes_in ? 'end_datetime' THEN NULLIF(v_changes_in->>'end_datetime', '')::timestamptz ELSE e.end_datetime END,
           expected_attendance = CASE WHEN v_changes_in ? 'expected_attendance' THEN NULLIF(v_changes_in->>'expected_attendance', '')::integer ELSE e.expected_attendance END,
           preferred_layout_type = CASE WHEN v_changes_in ? 'preferred_layout_type' THEN NULLIF(btrim(v_changes_in->>'preferred_layout_type'), '') ELSE e.preferred_layout_type END,
           accessibility_needs = CASE WHEN v_changes_in ? 'accessibility_needs' THEN v_changes_in->>'accessibility_needs' ELSE e.accessibility_needs END,
           updated_at = now()
     WHERE e.event_id = p_event_id
     RETURNING * INTO v_event;
  END IF;
  PERFORM public._replace_event_requirements(p_event_id, p_venue_preferences, p_equipment_requirements);

  v_changes := public._event_field_changes(v_before, v_event);
  v_after_requirements := public._event_response(v_event);
  IF v_before_requirements->'venue_preferences' IS DISTINCT FROM v_after_requirements->'venue_preferences' THEN
    v_changes := v_changes || jsonb_build_object('venuePreferences', jsonb_build_object(
      'before', v_before_requirements->'venue_preferences',
      'after', v_after_requirements->'venue_preferences'
    ));
  END IF;
  IF v_before_requirements->'equipment_requirements' IS DISTINCT FROM v_after_requirements->'equipment_requirements' THEN
    v_changes := v_changes || jsonb_build_object('equipmentRequirements', jsonb_build_object(
      'before', v_before_requirements->'equipment_requirements',
      'after', v_after_requirements->'equipment_requirements'
    ));
  END IF;

  -- Saving the stored values again is not an amendment; raising undoes the rewrite.
  IF v_changes = '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AMENDMENT_EMPTY';
  END IF;

  -- Still a complete submission (Master 5.2); end after start is the table's
  -- event_datetime_order_check.
  IF NULLIF(btrim(v_event.title), '') IS NULL
     OR v_event.purpose IS NULL
     OR v_event.description IS NULL
     OR v_event.start_datetime IS NULL
     OR v_event.end_datetime IS NULL
     OR COALESCE(v_event.expected_attendance, 0) <= 0
     OR v_event.preferred_layout_type IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_PATCH';
  END IF;
  -- The 48-hour lead time applies only to a newly chosen start (team decision, 2026-10-24).
  IF v_changes ? 'startDatetime' AND v_event.start_datetime < now() + interval '48 hours' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_PATCH';
  END IF;

  -- Requirement-only amendments still move the version, so the coordinator's
  -- completion (which checks the version) cannot miss them.
  IF v_changes_in = '{}'::jsonb THEN
    UPDATE public.event SET updated_at = now() WHERE event_id = p_event_id RETURNING * INTO v_event;
  END IF;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', p_event_id, 'CLARIFICATION_AMENDED',
    format('Request amended during clarification Request %s.', v_round.round_number),
    'ORGANISER', v_changes, 'ORGANISER_SAFE'
  );

  PERFORM public._notify_clarification_party(
    v_round,
    v_event.coordinator_id,
    'Event request amended',
    format(
      'The organiser amended event request REQ-%s "%s" during Request %s. Open the request to see what changed.',
      lpad(p_event_id::text, 6, '0'), v_event.title, v_round.round_number
    )
  );

  RETURN public._store_idempotent_response(p_actor_id, v_operation, p_idempotency_key, public._event_response(v_event));
END;
$$;

-- ---------- complete the thread (assigned coordinator) ----------

CREATE FUNCTION public.complete_event_clarification(
  p_event_id integer,
  p_round_number integer,
  p_actor_id integer,
  p_expected_version integer,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_operation constant text := 'event.complete_clarification';
  v_event public.event;
  v_round public.clarifications;
  v_replay jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_actor_id, v_operation, p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  -- The version check means the coordinator has seen the latest amendments.
  PERFORM public._check_event_transition(v_event, 'complete_clarification', p_actor_id, p_expected_version);

  SELECT * INTO v_round FROM public.clarifications
   WHERE event_id = p_event_id AND round_number = p_round_number
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'CLARIFICATION_NOT_FOUND';
  END IF;
  IF v_round.status <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CLARIFICATION_CLOSED';
  END IF;

  UPDATE public.clarifications
     SET status = 'RESPONDED', responded_by = p_actor_id, responded_at = now()
   WHERE clarification_id = v_round.clarification_id
   RETURNING * INTO v_round;

  -- History: thread completed; back to UNDER_REVIEW with the same coordinator.
  v_event := public._apply_event_transition(
    v_event,
    'complete_clarification',
    p_actor_id,
    format('Clarification Request %s marked complete.', v_round.round_number)
  );

  -- TODO(SPM-155): switch to the keyed _notify_event_users overload once its
  -- action-key format is agreed.
  PERFORM public._notify_event_users(
    p_event_id,
    'Clarification complete',
    format(
      'Your event coordinator marked Request %s on event request REQ-%s "%s" complete. The request is back under review.',
      v_round.round_number, lpad(p_event_id::text, 6, '0'), v_event.title
    ),
    ARRAY[v_event.organiser_id]
  );

  RETURN public._store_idempotent_response(
    p_actor_id, v_operation, p_idempotency_key,
    public._event_response(v_event) || jsonb_build_object('clarification', to_jsonb(v_round))
  );
END;
$$;

-- ---------- mark read / viewed ----------

-- Opening a thread resets the throttle for that person. Others can read the
-- thread (same-organisation organisers) but are never notified, so nothing is stored.
CREATE FUNCTION public.mark_clarification_read(p_event_id integer, p_round_number integer, p_actor_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_clarification_id integer;
BEGIN
  SELECT c.clarification_id INTO v_clarification_id
    FROM public.clarifications AS c
    JOIN public.event AS e ON e.event_id = c.event_id
   WHERE c.event_id = p_event_id
     AND c.round_number = p_round_number
     AND p_actor_id IN (e.organiser_id, e.coordinator_id);
  IF FOUND THEN
    PERFORM public._mark_clarification_read(v_clarification_id, p_actor_id);
  END IF;
END;
$$;

-- The backend checks that the viewer may see the event's history first.
CREATE FUNCTION public.mark_event_history_viewed(p_event_id integer, p_actor_id integer)
RETURNS timestamptz
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.event_history_views (user_id, event_id, last_viewed_at)
  VALUES (p_actor_id, p_event_id, now())
  ON CONFLICT (user_id, event_id) DO UPDATE SET last_viewed_at = now()
  RETURNING last_viewed_at;
$$;

-- ---------- the v1 resubmit step is removed ----------

DROP FUNCTION public.resubmit_event_after_clarification(integer, integer, integer, text, jsonb, jsonb, jsonb, text, text);

-- ---------- access ----------

ALTER TABLE public.clarification_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clarification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_history_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.clarification_messages FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.clarification_reads FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.event_history_views FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.clarification_messages TO service_role;
GRANT SELECT ON public.clarification_reads TO service_role;
GRANT SELECT ON public.event_history_views TO service_role;

REVOKE ALL ON FUNCTION public._clarification_messages_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._clarification_party(public.event, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._mark_clarification_read(integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_clarification_party(public.clarifications, integer, text, text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.post_clarification_message(integer, integer, integer, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_clarification_amendments(integer, integer, integer, jsonb, jsonb, jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_event_clarification(integer, integer, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_clarification_read(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_event_history_viewed(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_clarification_message(integer, integer, integer, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_clarification_amendments(integer, integer, integer, jsonb, jsonb, jsonb, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_event_clarification(integer, integer, integer, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_clarification_read(integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_event_history_viewed(integer, integer) TO service_role;
