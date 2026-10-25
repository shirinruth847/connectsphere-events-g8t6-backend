-- SPM-41: request clarification and resubmit (Master sections 5.2, 7.1 and 8).
--
-- Both actions run on the SPM-173 transition table: _check_event_transition
-- decides role, relationship (404), version (409) and state (403), and
-- _apply_event_transition writes the new state and its history entry. These
-- functions add the clarification round, the owner's amendments and the
-- notification, all in one transaction (Master 7.1, "Clarification/resubmission"):
-- any failure rolls back the round, the amendments and the state together.

-- ---------- idempotency operations ----------

-- Rebuilt from the live constraint as read on 2026-10-24, which also holds
-- operations added on other branches (safety.decide, event.suggest_venue).
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
    'event.resubmit'
  ]));

-- ---------- request clarification (assigned coordinator, UNDER_REVIEW) ----------

CREATE FUNCTION public.request_event_clarification(
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
  PERFORM public._check_event_transition(v_event, 'request_clarification', p_actor_id, p_expected_version);

  -- Required, at most 2,000 characters (team decision, 2026-10-20).
  IF v_message IS NULL OR v_message = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_CLARIFICATION', DETAIL = 'message:REQUIRED';
  END IF;
  IF char_length(v_message) > 2000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_CLARIFICATION', DETAIL = 'message:TOO_LONG';
  END IF;

  -- The event row lock serialises rounds, so the next number cannot be taken twice.
  INSERT INTO public.clarifications (event_id, round_number, message, requested_by)
  VALUES (
    p_event_id,
    COALESCE((SELECT max(round_number) FROM public.clarifications WHERE event_id = p_event_id), 0) + 1,
    v_message,
    p_actor_id
  )
  RETURNING * INTO v_round;

  -- The history entry keeps the full question (SPM-41 AC5).
  v_event := public._apply_event_transition(
    v_event,
    'request_clarification',
    p_actor_id,
    format('Clarification requested (round %s): %s', v_round.round_number, v_message)
  );

  -- TODO(SPM-155): switch to the keyed _notify_event_users overload once its
  -- action-key format is agreed, so a notification is never duplicated.
  PERFORM public._notify_event_users(
    p_event_id,
    'Clarification requested',
    format(
      'Your event coordinator returned event request REQ-%s "%s" with a question: %s Amend the request if needed, then respond and resubmit.',
      lpad(p_event_id::text, 6, '0'), v_event.title, v_message
    ),
    ARRAY[v_event.organiser_id]
  );

  RETURN public._store_idempotent_response(
    p_actor_id, v_operation, p_idempotency_key,
    public._event_response(v_event) || jsonb_build_object('clarification', to_jsonb(v_round))
  );
END;
$$;

-- ---------- resubmit (owner, AWAITING_CLARIFICATION with an open round) ----------

-- p_changes uses column names and may hold only the submission fields below;
-- registration settings and the organisation are not amendable here. NULL
-- requirement arguments leave venue preferences or equipment unchanged.
CREATE FUNCTION public.resubmit_event_after_clarification(
  p_event_id integer,
  p_actor_id integer,
  p_expected_version integer,
  p_response text,
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
  v_operation constant text := 'event.resubmit';
  v_changes_in jsonb := COALESCE(p_changes, '{}'::jsonb);
  v_event public.event;
  v_before public.event;
  v_before_requirements jsonb;
  v_after_requirements jsonb;
  v_changes jsonb;
  v_round public.clarifications;
  v_response text := NULLIF(btrim(p_response), '');
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
  PERFORM public._check_event_transition(v_event, 'resubmit', p_actor_id, p_expected_version);

  -- Master 5.2: "Respond/resubmit" needs an open clarification.
  SELECT * INTO v_round
    FROM public.clarifications
   WHERE event_id = p_event_id AND status = 'OPEN'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CLARIFICATION_NOT_OPEN';
  END IF;

  IF char_length(v_response) > 2000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_CLARIFICATION', DETAIL = 'response:TOO_LONG';
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

  -- Significant fields may change here without a change request (Master 5.2,
  -- "except when explicitly amended during the clarification loop").
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

  -- A response, at least one amended field, or both. Sending the stored values
  -- again is not an amendment; raising here also undoes the rewrite above.
  IF v_response IS NULL AND v_changes = '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RESUBMIT_EMPTY';
  END IF;

  -- The amended request must still be a complete submission (Master 5.2). The
  -- backend validates field by field first; this guards the merged row. End
  -- after start is the table's event_datetime_order_check.
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

  IF v_changes <> '{}'::jsonb THEN
    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
    VALUES (
      p_actor_id, 'event', p_event_id, 'CLARIFICATION_AMENDED',
      format('Request amended in response to clarification round %s.', v_round.round_number),
      'ORGANISER', v_changes, 'ORGANISER_SAFE'
    );
  END IF;

  UPDATE public.clarifications
     SET status = 'RESPONDED', response = v_response, responded_by = p_actor_id, responded_at = now()
   WHERE clarification_id = v_round.clarification_id
   RETURNING * INTO v_round;

  -- Back to UNDER_REVIEW with the same coordinator, not the unassigned queue.
  v_event := public._apply_event_transition(
    v_event,
    'resubmit',
    p_actor_id,
    CASE
      WHEN v_response IS NULL THEN format('Resubmitted after clarification round %s with amendments only.', v_round.round_number)
      ELSE format('Resubmitted after clarification round %s. Response: %s', v_round.round_number, v_response)
    END
  );

  -- TODO(SPM-155): switch to the keyed _notify_event_users overload once its
  -- action-key format is agreed, so a notification is never duplicated.
  PERFORM public._notify_event_users(
    p_event_id,
    'Event request resubmitted',
    format(
      'The organiser resubmitted event request REQ-%s "%s" after clarification round %s%s.',
      lpad(p_event_id::text, 6, '0'), v_event.title, v_round.round_number,
      CASE
        WHEN v_response IS NOT NULL AND v_changes <> '{}'::jsonb THEN ' with a response and amendments'
        WHEN v_response IS NOT NULL THEN ' with a response'
        ELSE ' with amendments'
      END
    ),
    ARRAY[v_event.coordinator_id]
  );

  RETURN public._store_idempotent_response(
    p_actor_id, v_operation, p_idempotency_key,
    public._event_response(v_event) || jsonb_build_object('clarification', to_jsonb(v_round))
  );
END;
$$;

-- ---------- events returned before rounds existed ----------

-- Seed data has events in AWAITING_CLARIFICATION with no round, which the owner
-- could never resubmit. Each gets one OPEN round so it follows the normal path.
-- The original question was never stored, and the message says so.
INSERT INTO public.clarifications (event_id, round_number, message, requested_by, requested_at)
SELECT e.event_id,
       COALESCE((SELECT max(c.round_number) FROM public.clarifications AS c WHERE c.event_id = e.event_id), 0) + 1,
       'This request was returned for clarification before questions were recorded, so the original question is not available. Review the request, amend anything that needs it, then respond and resubmit, or contact your event coordinator.',
       e.coordinator_id,
       LEAST(COALESCE(e.updated_at, now()), now())
  FROM public.event AS e
 WHERE e.status = 'AWAITING_CLARIFICATION'
   AND e.coordinator_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.clarifications AS c WHERE c.event_id = e.event_id AND c.status = 'OPEN'
   );

-- ---------- access ----------

REVOKE ALL ON FUNCTION public.request_event_clarification(integer, integer, integer, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resubmit_event_after_clarification(integer, integer, integer, text, jsonb, jsonb, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_event_clarification(integer, integer, integer, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resubmit_event_after_clarification(integer, integer, integer, text, jsonb, jsonb, jsonb, text, text) TO service_role;
