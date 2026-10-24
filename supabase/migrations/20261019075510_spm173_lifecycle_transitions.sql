-- SPM-173: one shared, guarded event lifecycle (Master v1.1 sections 5.2, 5.3,
-- 7.1 and 8).
--
-- The transition table lives here, not in eventModel.js: the backend has no
-- transaction outside database functions, and a guard is only safe when it runs
-- under the event row lock in the same transaction as the write. Every action
-- function calls _check_event_transition and _apply_event_transition, or the
-- _transition_event shortcut, instead of writing event.status itself.
--
-- Master v1.1 section 5.2 lists 17 actions without numbers; the ticket's
-- "T01-T14" are numbered here as T01-T17:
--   T01 submit                   T07 submit_for_safety_review  T13 reject
--   T02 withdraw                 T08 safety_changes_requested  T14 accept_change
--   T03 assign                       / safety_rejected          T15 cancel
--   T04 request_clarification    T09 safety_superseded         T16 venue_replacement
--   T05 resubmit                 T10 confirm                   T17 safety approval
--   T06 accept_feasibility       T11 start_preparation             (no state change;
--                                T12 complete                       recorded by SPM-249)
--
-- Not done here, so other people's open work is not broken:
--   * assign_event_coordinator keeps writing its status directly; it is
--     redefined on the SPM-177 and SPM-180 branches and adopts T03 there.
--   * No trigger yet refuses status writes made outside these functions; it is
--     added once every writer uses them. AC2 holds at the API in the meantime.
--   * _event_readiness is a stub until the Master resource tables are agreed
--     with SPM-179 and SPM-186 (a later migration replaces it).

-- ---------- schema ----------

-- Reject is allowed only for events never confirmed (Master 5.2), and the
-- organiser's "Reconfirmation pending" note needs the same fact (Master 3.5).
ALTER TABLE public.event
  ADD COLUMN IF NOT EXISTS previously_confirmed boolean NOT NULL DEFAULT false;

UPDATE public.event
   SET previously_confirmed = true
 WHERE status IN ('CONFIRMED', 'COMPLETED')
   AND NOT previously_confirmed;

-- What attendees were told at each confirmation (Master 5.3: attendees keep
-- seeing the last snapshot while a confirmed event is back in planning).
CREATE TABLE public.event_confirmation_snapshots (
  snapshot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id integer NOT NULL REFERENCES public.event (event_id) ON DELETE RESTRICT,
  event_version integer NOT NULL CHECK (event_version > 0),
  arrangement_version integer NOT NULL CHECK (arrangement_version > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 16384),
  confirmed_by integer NOT NULL REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  confirmed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX event_confirmation_snapshots_event
  ON public.event_confirmation_snapshots (event_id, snapshot_id DESC);

ALTER TABLE public.event_confirmation_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_confirmation_snapshots FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.event_confirmation_snapshots TO service_role;

-- AC4: the completion job is recorded as "System", which has no user row.
ALTER TABLE public.activity_log ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.activity_log
  ADD CONSTRAINT activity_log_actor_check CHECK (user_id IS NOT NULL OR actor_role = 'SYSTEM');

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
    'event.complete'
  ]));

-- ---------- the transition table ----------

-- relationship: OWNER (organiser_id), ASSIGNED (coordinator_id), LEAD (any
-- active Lead until supervising Leads exist), CLAIMANT (holds the open safety
-- review), ANY (the caller has already authorised the change, e.g. a venue
-- block superseding a review). actor_role NULL means any active role.
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

-- Raises unless p_actor_id (NULL = the system) may run p_action on p_event now.
-- p_event must be the row the caller locked FOR UPDATE. Checks run in the order
-- the API reports them: role (403), relationship (404, so the event's existence
-- is not confirmed), stale version (409 with the current state), state (403
-- naming the current state).
CREATE OR REPLACE FUNCTION public._check_event_transition(
  p_event public.event,
  p_action text,
  p_actor_id integer,
  p_expected_version integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rule record;
  v_actor public."user";
BEGIN
  SELECT * INTO v_rule FROM public._lifecycle_transitions() AS t WHERE t.action = p_action;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNKNOWN_LIFECYCLE_ACTION', DETAIL = p_action;
  END IF;

  IF p_actor_id IS NULL THEN
    IF NOT v_rule.allows_system THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN';
    END IF;
  ELSE
    SELECT * INTO v_actor FROM public."user" WHERE user_id = p_actor_id AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN';
    END IF;
    -- A Lead never makes lifecycle decisions; a Safety Officer only records safety outcomes (AC3).
    IF v_rule.actor_role IS NOT NULL AND v_actor.role::text <> v_rule.actor_role THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TRANSITION_NOT_ALLOWED', DETAIL = p_event.status::text;
    END IF;
    IF (v_rule.relationship = 'OWNER' AND p_event.organiser_id IS DISTINCT FROM p_actor_id)
       OR (v_rule.relationship = 'ASSIGNED' AND p_event.coordinator_id IS DISTINCT FROM p_actor_id)
       OR (v_rule.relationship = 'CLAIMANT' AND NOT EXISTS (
             SELECT 1 FROM public.safety_reviews
              WHERE event_id = p_event.event_id AND status = 'OPEN' AND claimed_by = p_actor_id
           )) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
    END IF;
  END IF;

  IF p_expected_version IS NOT NULL AND p_expected_version <> p_event.version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_VERSION_CONFLICT', DETAIL = p_event.status::text;
  END IF;

  IF NOT (p_event.status::text = ANY (v_rule.from_states))
     OR (p_action = 'reject' AND p_event.previously_confirmed) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TRANSITION_NOT_ALLOWED', DETAIL = p_event.status::text;
  END IF;
END;
$$;

-- Writes the new state and its one history entry (AC4). Call only after
-- _check_event_transition on the same locked row, inside the action's transaction.
CREATE OR REPLACE FUNCTION public._apply_event_transition(
  p_event public.event,
  p_action text,
  p_actor_id integer,
  p_details text
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

  -- Re-read under the caller's lock: the caller may have changed the row (for
  -- example, set the coordinator) after locking it.
  SELECT * INTO v_current FROM public.event WHERE event_id = p_event.event_id FOR UPDATE;

  -- Master 5.2 / 6.3: SUBMITTED never has a coordinator; every active state
  -- from UNDER_REVIEW onward has exactly one.
  IF v_rule.to_state = 'SUBMITTED' AND v_current.coordinator_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COORDINATOR_INVARIANT', DETAIL = v_rule.to_state;
  END IF;
  IF v_rule.to_state IN ('UNDER_REVIEW', 'AWAITING_CLARIFICATION', 'PLANNING', 'SAFETY_REVIEW', 'CONFIRMED', 'PREPARATION')
     AND v_current.coordinator_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COORDINATOR_INVARIANT', DETAIL = v_rule.to_state;
  END IF;

  UPDATE public.event
     SET status = v_rule.to_state::public.event_status,
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

-- Lock, check and apply in one call, for actions with no other precondition.
CREATE OR REPLACE FUNCTION public._transition_event(
  p_event_id integer,
  p_action text,
  p_actor_id integer,
  p_expected_version integer,
  p_details text
)
RETURNS public.event
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
BEGIN
  SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  PERFORM public._check_event_transition(v_event, p_action, p_actor_id, p_expected_version);
  RETURN public._apply_event_transition(v_event, p_action, p_actor_id, p_details);
END;
$$;

-- ---------- readiness and helpers ----------

-- Master 5.3 readiness, as the list of failing condition codes (empty = ready).
-- Placeholder until the Master resource tables (venue bookings by venue with a
-- primary flag, technical requests, incidents) are agreed with SPM-179/SPM-186;
-- the migration that adds them replaces this function. Until then nothing is
-- reported ready, so no event can skip a check that has no data yet.
CREATE OR REPLACE FUNCTION public._event_readiness(p_event_id integer)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN ARRAY['READINESS_DATA_PENDING'];
END;
$$;

-- Staff on the event: the Venue Staff and Technical Support who approved its
-- bookings and equipment. Replaced with the Master tables' reviewers later.
CREATE OR REPLACE FUNCTION public._event_staff_recipients(p_event_id integer)
RETURNS integer[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(array_agg(DISTINCT staff.user_id), ARRAY[]::integer[])
    FROM (
      SELECT reviewed_by AS user_id FROM public.venue_booking
       WHERE event_id = p_event_id AND status = 'APPROVED' AND reviewed_by IS NOT NULL
      UNION
      SELECT reviewed_by FROM public.equipment_request
       WHERE event_id = p_event_id AND status = 'APPROVED' AND reviewed_by IS NOT NULL
    ) AS staff
    JOIN public."user" AS u ON u.user_id = staff.user_id AND u.is_active;
$$;

-- One notification row and its recipients. Nothing is written when nobody
-- would receive it.
CREATE OR REPLACE FUNCTION public._notify_event_users(
  p_event_id integer,
  p_title text,
  p_message text,
  p_recipients integer[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_notification_id integer;
BEGIN
  IF p_recipients IS NULL OR cardinality(p_recipients) = 0 THEN
    RETURN;
  END IF;
  INSERT INTO public.notification (event_id, title, message, type)
  VALUES (p_event_id, p_title, p_message, 'STATUS_CHANGE')
  RETURNING notification_id INTO v_notification_id;
  INSERT INTO public.notification_recipient (notification_id, recipient_id)
  SELECT DISTINCT v_notification_id, recipient_id FROM unnest(p_recipients) AS recipient_id;
END;
$$;

CREATE OR REPLACE FUNCTION public._active_users_with_role(p_role text)
RETURNS integer[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(array_agg(user_id ORDER BY user_id), ARRAY[]::integer[])
    FROM public."user"
   WHERE role::text = p_role AND is_active;
$$;

-- The attendee-facing details fixed at confirmation (Master 5.3).
CREATE OR REPLACE FUNCTION public._event_attendee_snapshot(p_event public.event)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'title', p_event.title,
    'description', p_event.description,
    'start_datetime', p_event.start_datetime,
    'end_datetime', p_event.end_datetime,
    'is_published', p_event.is_published,
    'is_registration_enabled', p_event.is_registration_enabled,
    'registration_capacity', p_event.registration_capacity,
    'registration_open_at', p_event.registration_open_at,
    'registration_close_at', p_event.registration_close_at
  );
$$;

-- ---------- coordinator actions (SPM-173 AC8-AC12) ----------

-- AC8: readiness for the assigned coordinator. Read-only; the action functions
-- recheck it under the event lock.
CREATE OR REPLACE FUNCTION public.get_event_readiness(p_event_id integer, p_actor_id integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_failures text[];
BEGIN
  SELECT e.* INTO v_event
    FROM public.event AS e
    JOIN public."user" AS u ON u.user_id = p_actor_id AND u.is_active AND u.role = 'COORDINATOR'
   WHERE e.event_id = p_event_id AND e.coordinator_id = p_actor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  v_failures := public._event_readiness(p_event_id);
  RETURN jsonb_build_object(
    'ready', cardinality(v_failures) = 0,
    'failures', to_jsonb(v_failures),
    'status', v_event.status,
    'version', v_event.version,
    'arrangement_version', v_event.arrangement_version
  );
END;
$$;

-- AC9 (T07): PLANNING -> SAFETY_REVIEW when ready; opens a review round bound
-- to the current arrangement version and notifies every active Safety Officer.
CREATE OR REPLACE FUNCTION public.submit_event_for_safety_review(
  p_event_id integer,
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
  v_operation constant text := 'event.submit_for_safety_review';
  v_event public.event;
  v_failures text[];
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
  PERFORM public._check_event_transition(v_event, 'submit_for_safety_review', p_actor_id, p_expected_version);

  v_failures := public._event_readiness(p_event_id);
  IF cardinality(v_failures) > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'READINESS_BLOCKED', DETAIL = array_to_string(v_failures, ',');
  END IF;

  v_event := public._apply_event_transition(v_event, 'submit_for_safety_review', p_actor_id, 'Submitted for safety review.');

  INSERT INTO public.safety_reviews (event_id, round_number, arrangement_version, submitted_by)
  VALUES (
    p_event_id,
    COALESCE((SELECT max(round_number) FROM public.safety_reviews WHERE event_id = p_event_id), 0) + 1,
    v_event.arrangement_version,
    p_actor_id
  );

  PERFORM public._notify_event_users(
    p_event_id,
    'Event awaiting safety review',
    format('Event REQ-%s "%s" is waiting in the safety review queue.', lpad(p_event_id::text, 6, '0'), v_event.title),
    public._active_users_with_role('SAFETY_OFFICER')
  );

  RETURN public._store_idempotent_response(p_actor_id, v_operation, p_idempotency_key, jsonb_build_object('event', to_jsonb(v_event)));
END;
$$;

-- AC10 (T10): SAFETY_REVIEW -> CONFIRMED when the latest round is APPROVED for
-- the current arrangement version and the event is still ready. Stores the
-- confirmation snapshot and notifies the owner and staff; registered attendees
-- are told only when a reconfirmation changed what they were last told.
CREATE OR REPLACE FUNCTION public.confirm_event(
  p_event_id integer,
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
  v_operation constant text := 'event.confirm';
  v_event public.event;
  v_failures text[];
  v_previous jsonb;
  v_snapshot jsonb;
  v_request_id text;
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
  PERFORM public._check_event_transition(v_event, 'confirm', p_actor_id, p_expected_version);

  IF NOT EXISTS (
    SELECT 1 FROM public.safety_reviews AS r
     WHERE r.event_id = p_event_id
       AND r.status = 'APPROVED'
       AND r.arrangement_version = v_event.arrangement_version
       AND r.round_number = (SELECT max(round_number) FROM public.safety_reviews WHERE event_id = p_event_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SAFETY_APPROVAL_REQUIRED';
  END IF;

  v_failures := public._event_readiness(p_event_id);
  IF cardinality(v_failures) > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'READINESS_BLOCKED', DETAIL = array_to_string(v_failures, ',');
  END IF;

  SELECT snapshot INTO v_previous
    FROM public.event_confirmation_snapshots
   WHERE event_id = p_event_id
   ORDER BY snapshot_id DESC
   LIMIT 1;

  v_event := public._apply_event_transition(v_event, 'confirm', p_actor_id, 'Event confirmed.');
  v_snapshot := public._event_attendee_snapshot(v_event);

  INSERT INTO public.event_confirmation_snapshots (event_id, event_version, arrangement_version, snapshot, confirmed_by)
  VALUES (p_event_id, v_event.version, v_event.arrangement_version, v_snapshot, p_actor_id);

  v_request_id := 'REQ-' || lpad(p_event_id::text, 6, '0');
  PERFORM public._notify_event_users(
    p_event_id,
    'Event confirmed',
    format('Your event "%s" (%s) is confirmed.', v_event.title, v_request_id),
    ARRAY[v_event.organiser_id]
  );
  PERFORM public._notify_event_users(
    p_event_id,
    'Event confirmed',
    format('Event %s "%s" is confirmed.', v_request_id, v_event.title),
    public._event_staff_recipients(p_event_id)
  );
  IF v_previous IS NOT NULL AND v_previous IS DISTINCT FROM v_snapshot THEN
    PERFORM public._notify_event_users(
      p_event_id,
      'Event details updated',
      format('The details of "%s" have changed. Please check the latest information.', v_event.title),
      ARRAY(SELECT attendee_id FROM public.registration WHERE event_id = p_event_id AND registration_status = 'REGISTERED')
    );
  END IF;

  RETURN public._store_idempotent_response(p_actor_id, v_operation, p_idempotency_key, jsonb_build_object('event', to_jsonb(v_event)));
END;
$$;

-- AC11 (T11): CONFIRMED -> PREPARATION; Venue Staff and Technical Support on
-- the event are notified. Their preparation updates accept only PREPARATION.
CREATE OR REPLACE FUNCTION public.start_event_preparation(
  p_event_id integer,
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
  v_operation constant text := 'event.start_preparation';
  v_event public.event;
  v_replay jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_actor_id, v_operation, p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  v_event := public._transition_event(p_event_id, 'start_preparation', p_actor_id, p_expected_version, 'Preparation started.');

  PERFORM public._notify_event_users(
    p_event_id,
    'Event preparation started',
    format('Preparation has started for event REQ-%s "%s".', lpad(p_event_id::text, 6, '0'), v_event.title),
    public._event_staff_recipients(p_event_id)
  );

  RETURN public._store_idempotent_response(p_actor_id, v_operation, p_idempotency_key, jsonb_build_object('event', to_jsonb(v_event)));
END;
$$;

-- AC12 (T12), manual: the assigned coordinator completes a CONFIRMED or
-- PREPARATION event whose end has passed (database time). Registration closes
-- with the state: registration is open only in CONFIRMED and PREPARATION.
CREATE OR REPLACE FUNCTION public.complete_event(
  p_event_id integer,
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
  v_operation constant text := 'event.complete';
  v_event public.event;
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
  PERFORM public._check_event_transition(v_event, 'complete', p_actor_id, p_expected_version);
  IF v_event.end_datetime IS NULL OR v_event.end_datetime > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_ENDED';
  END IF;

  v_event := public._apply_event_transition(v_event, 'complete', p_actor_id, 'Event completed.');

  RETURN public._store_idempotent_response(p_actor_id, v_operation, p_idempotency_key, jsonb_build_object('event', to_jsonb(v_event)));
END;
$$;

-- AC12 (T12), automatic: completes up to p_limit ended events per call, oldest
-- end first, recorded as "System". SKIP LOCKED lets several backend processes
-- run it at once without double work; a late run simply completes more.
CREATE OR REPLACE FUNCTION public.complete_due_events(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
  v_count integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_BATCH_SIZE';
  END IF;

  FOR v_event IN
    SELECT * FROM public.event
     WHERE status IN ('CONFIRMED', 'PREPARATION')
       AND end_datetime <= now()
     ORDER BY end_datetime, event_id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM public._check_event_transition(v_event, 'complete', NULL, NULL);
    PERFORM public._apply_event_transition(v_event, 'complete', NULL, 'Completed automatically after the event ended.');
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ---------- submission (T01) through the shared transition ----------

-- Identical to the live definition (20261007130000_defer_coordinator_assignment)
-- except that the status change and its history entry now come from
-- _apply_event_transition, a new request is first inserted as a DRAFT, and every
-- active Lead is notified (AC7: submission notifies the owner and every Lead).
CREATE OR REPLACE FUNCTION public.submit_event_request(
  p_organiser_id integer,
  p_event_id integer,
  p_event jsonb,
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
  v_event public.event;
  v_title text;
  v_purpose text;
  v_description text;
  v_start_datetime timestamptz;
  v_end_datetime timestamptz;
  v_expected_attendance integer;
  v_preferred_layout_type text;
  v_accessibility_needs text;
  v_is_registration_enabled boolean;
  v_registration_capacity integer;
  v_request_id text;
  v_errors text[] := ARRAY[]::text[];
  v_replay jsonb;
BEGIN
  IF jsonb_typeof(p_event) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EVENT_PATCH';
  END IF;

  PERFORM 1
    FROM public."user"
   WHERE user_id = p_organiser_id
     AND role = 'ORGANISER'
     AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  IF p_event_id IS NULL THEN
    IF p_idempotency_key IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
    END IF;
    v_replay := public._claim_idempotency_key(
      p_organiser_id, 'event.create_and_submit', p_idempotency_key, p_request_hash
    );
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  ELSE
    SELECT * INTO v_event
      FROM public.event
     WHERE event_id = p_event_id
       AND organiser_id = p_organiser_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
    END IF;
    IF v_event.status <> 'DRAFT' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_DRAFT';
    END IF;
  END IF;

  v_title := CASE WHEN p_event ? 'title' THEN NULLIF(BTRIM(p_event->>'title'), '') ELSE v_event.title END;
  v_purpose := CASE WHEN p_event ? 'purpose' THEN NULLIF(BTRIM(p_event->>'purpose'), '') ELSE v_event.purpose END;
  v_description := CASE WHEN p_event ? 'description' THEN NULLIF(BTRIM(p_event->>'description'), '') ELSE v_event.description END;
  v_start_datetime := CASE WHEN p_event ? 'start_datetime' THEN NULLIF(p_event->>'start_datetime', '')::timestamptz ELSE v_event.start_datetime END;
  v_end_datetime := CASE WHEN p_event ? 'end_datetime' THEN NULLIF(p_event->>'end_datetime', '')::timestamptz ELSE v_event.end_datetime END;
  v_expected_attendance := CASE WHEN p_event ? 'expected_attendance' THEN NULLIF(p_event->>'expected_attendance', '')::integer ELSE v_event.expected_attendance END;
  v_preferred_layout_type := CASE WHEN p_event ? 'preferred_layout_type' THEN NULLIF(BTRIM(p_event->>'preferred_layout_type'), '') ELSE v_event.preferred_layout_type END;
  v_accessibility_needs := CASE WHEN p_event ? 'accessibility_needs' THEN p_event->>'accessibility_needs' ELSE v_event.accessibility_needs END;
  v_is_registration_enabled := CASE WHEN p_event ? 'is_registration_enabled' THEN COALESCE(NULLIF(p_event->>'is_registration_enabled', '')::boolean, false) ELSE COALESCE(v_event.is_registration_enabled, false) END;
  v_registration_capacity := CASE WHEN p_event ? 'registration_capacity' THEN NULLIF(p_event->>'registration_capacity', '')::integer ELSE v_event.registration_capacity END;

  IF v_title IS NULL THEN v_errors := array_append(v_errors, 'title:REQUIRED'); END IF;
  IF v_purpose IS NULL THEN v_errors := array_append(v_errors, 'purpose:REQUIRED'); END IF;
  IF v_description IS NULL THEN v_errors := array_append(v_errors, 'description:REQUIRED'); END IF;
  IF v_start_datetime IS NULL THEN
    v_errors := array_append(v_errors, 'startDatetime:REQUIRED');
  ELSIF v_start_datetime < now() + interval '48 hours' THEN
    v_errors := array_append(v_errors, 'startDatetime:LEAD_TIME');
  END IF;
  IF v_end_datetime IS NULL THEN
    v_errors := array_append(v_errors, 'endDatetime:REQUIRED');
  ELSIF v_start_datetime IS NOT NULL AND v_end_datetime <= v_start_datetime THEN
    v_errors := array_append(v_errors, 'endDatetime:END_BEFORE_START');
  END IF;
  IF v_expected_attendance IS NULL THEN
    v_errors := array_append(v_errors, 'expectedAttendance:REQUIRED');
  ELSIF v_expected_attendance <= 0 THEN
    v_errors := array_append(v_errors, 'expectedAttendance:INVALID');
  END IF;
  IF v_preferred_layout_type IS NULL THEN
    v_errors := array_append(v_errors, 'preferredLayoutType:REQUIRED');
  ELSIF v_preferred_layout_type <> 'NO_PREFERENCE' AND NOT EXISTS (
    SELECT 1 FROM public.room WHERE layout_type = v_preferred_layout_type
  ) THEN
    v_errors := array_append(v_errors, 'preferredLayoutType:INVALID');
  END IF;
  IF v_is_registration_enabled AND v_registration_capacity IS NULL THEN
    v_errors := array_append(v_errors, 'registrationCapacity:REQUIRED');
  ELSIF v_registration_capacity IS NOT NULL AND v_registration_capacity <= 0 THEN
    v_errors := array_append(v_errors, 'registrationCapacity:INVALID');
  END IF;

  IF cardinality(v_errors) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'INVALID_EVENT_SUBMISSION',
      DETAIL = array_to_string(v_errors, ',');
  END IF;

  IF p_event_id IS NULL THEN
    INSERT INTO public.event (
      organiser_id, coordinator_id, title, purpose, description, start_datetime,
      end_datetime, expected_attendance, preferred_layout_type, accessibility_needs,
      is_registration_enabled, registration_capacity, status, updated_at
    ) VALUES (
      p_organiser_id, NULL, v_title, v_purpose, v_description,
      v_start_datetime, v_end_datetime, v_expected_attendance,
      v_preferred_layout_type, v_accessibility_needs, v_is_registration_enabled,
      v_registration_capacity, 'DRAFT', now()
    ) RETURNING * INTO v_event;
  ELSE
    UPDATE public.event
       SET coordinator_id = NULL,
           title = v_title,
           purpose = v_purpose,
           description = v_description,
           start_datetime = v_start_datetime,
           end_datetime = v_end_datetime,
           expected_attendance = v_expected_attendance,
           preferred_layout_type = v_preferred_layout_type,
           accessibility_needs = v_accessibility_needs,
           is_registration_enabled = v_is_registration_enabled,
           registration_capacity = v_registration_capacity,
           updated_at = now()
     WHERE event_id = p_event_id
       AND organiser_id = p_organiser_id
       AND status = 'DRAFT'
     RETURNING * INTO v_event;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_NOT_DRAFT';
    END IF;
  END IF;

  PERFORM public._replace_event_requirements(
    v_event.event_id,
    p_venue_preferences,
    p_equipment_requirements
  );

  PERFORM public._check_event_transition(v_event, 'submit', p_organiser_id, NULL);
  v_event := public._apply_event_transition(
    v_event,
    'submit',
    p_organiser_id,
    CASE WHEN p_event_id IS NULL
      THEN 'Event request created and submitted.'
      ELSE 'Draft submitted for review.'
    END
  );

  v_request_id := 'REQ-' || lpad(v_event.event_id::text, 6, '0');

  PERFORM public._notify_event_users(
    v_event.event_id,
    'Event request received',
    format('Your event request "%s" (%s) has been submitted and is pending coordinator assignment.', v_event.title, v_request_id),
    ARRAY[p_organiser_id]
  );
  PERFORM public._notify_event_users(
    v_event.event_id,
    'New event request in the queue',
    format('Event request %s "%s" is waiting for coordinator assignment.', v_request_id, v_event.title),
    public._active_users_with_role('COORDINATOR_LEAD')
  );

  RETURN public._store_idempotent_response(
    p_organiser_id, 'event.create_and_submit', p_idempotency_key, public._event_response(v_event)
  );
END;
$$;

-- ---------- privileges ----------

REVOKE ALL ON FUNCTION public._lifecycle_transitions() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._check_event_transition(public.event, text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._apply_event_transition(public.event, text, integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._transition_event(integer, text, integer, integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_readiness(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_staff_recipients(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._notify_event_users(integer, text, text, integer[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._active_users_with_role(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_attendee_snapshot(public.event) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_event_readiness(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_event_for_safety_review(integer, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_event(integer, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.start_event_preparation(integer, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_event(integer, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_due_events(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_event_request(integer, integer, jsonb, jsonb, jsonb, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_event_readiness(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_event_for_safety_review(integer, integer, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_event(integer, integer, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.start_event_preparation(integer, integer, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_event(integer, integer, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_due_events(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_event_request(integer, integer, jsonb, jsonb, jsonb, text, text) TO service_role;
