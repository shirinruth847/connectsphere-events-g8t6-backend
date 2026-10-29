-- SPM-193 AC7: the coordinator's safety-outcome notice names what needs rework
-- and why: each requested change, or each rejected venue booking with its
-- reason, plus the organiser-visible comment when there is one. Internal notes
-- are never included. The outcome stays as Master 5.2/5.9 define it: an
-- approval keeps the event in SAFETY_REVIEW until the coordinator confirms.
--
-- decide_safety_review (SPM-243/249) is rebuilt from its live definition
-- (last defined in 20261020160033_spm249_safety_decisions). Only the coordinator's
-- message changes; the staff notice, checks, locks and idempotency are as before.

CREATE OR REPLACE FUNCTION public.decide_safety_review(p_review_id bigint, p_actor_id integer, p_decision jsonb, p_expected_arrangement_version integer, p_idempotency_key text, p_request_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_operation constant text := 'safety.decide';
  v_replay jsonb;
  v_event_id integer;
  v_event public.event;
  v_round public.safety_reviews;
  v_outcome text;
  v_checklist jsonb;
  v_changes jsonb;
  v_rejected jsonb;
  v_organiser_comment text;
  v_internal_notes text;
  v_failures text[] := ARRAY[]::text[];
  v_unsatisfied text[];
  v_closed jsonb;
  v_action text;
  v_label text;
  v_request_id text;
  v_venue_staff integer[];
BEGIN
  PERFORM public._require_safety_officer(p_actor_id);

  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_idempotency_key(p_actor_id, v_operation, p_idempotency_key, p_request_hash);
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  SELECT event_id INTO v_event_id FROM public.safety_reviews WHERE review_id = p_review_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'REVIEW_NOT_FOUND';
  END IF;
  SELECT * INTO v_event FROM public.event WHERE event_id = v_event_id FOR UPDATE;
  v_round := public._lock_claimed_round(p_review_id, p_actor_id);

  -- AC11: the arrangements changed after the round opened. A change that already
  -- superseded the round left it no longer OPEN (refused above); one that only
  -- raised the version is caught here, and the round is superseded now.
  IF v_round.arrangement_version <> v_event.arrangement_version THEN
    v_closed := public._close_safety_review_for_change(v_event, p_actor_id, 'The arrangements changed after the review opened.');
    RETURN public._store_idempotent_response(p_actor_id, v_operation, p_idempotency_key, jsonb_build_object(
      'superseded', true,
      'review', (SELECT to_jsonb(r) FROM public.safety_reviews AS r WHERE r.review_id = p_review_id),
      'event', v_closed -> 'event'
    ));
  END IF;
  IF p_expected_arrangement_version IS DISTINCT FROM v_event.arrangement_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ARRANGEMENTS_CHANGED', DETAIL = v_event.status::text;
  END IF;
  IF v_event.status <> 'SAFETY_REVIEW' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TRANSITION_NOT_ALLOWED', DETAIL = v_event.status::text;
  END IF;

  -- AC7-AC10: a complete checklist and what each outcome needs.
  IF p_decision IS NULL OR jsonb_typeof(p_decision) <> 'object'
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_decision) AS key
        WHERE key NOT IN ('outcome', 'checklist', 'organiserComment', 'internalNotes', 'requestedChanges', 'rejectedBookings')
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_SAFETY_REVIEW', DETAIL = 'body:INVALID';
  END IF;
  v_outcome := p_decision ->> 'outcome';
  v_checklist := NULLIF(p_decision -> 'checklist', 'null'::jsonb);
  v_changes := NULLIF(p_decision -> 'requestedChanges', 'null'::jsonb);
  v_rejected := NULLIF(p_decision -> 'rejectedBookings', 'null'::jsonb);
  v_organiser_comment := NULLIF(btrim(p_decision ->> 'organiserComment'), '');
  v_internal_notes := NULLIF(btrim(p_decision ->> 'internalNotes'), '');

  IF v_outcome IS NULL OR v_outcome NOT IN ('APPROVED', 'CHANGES_REQUESTED', 'REJECTED') THEN
    v_failures := array_append(v_failures, 'outcome:INVALID');
  END IF;
  v_failures := v_failures
             || public._safety_checklist_failures(v_checklist, true)
             || public._safety_requested_changes_failures(v_changes);
  IF jsonb_typeof(p_decision -> 'organiserComment') NOT IN ('string', 'null') OR char_length(v_organiser_comment) > 2000 THEN
    v_failures := array_append(v_failures, 'organiserComment:INVALID');
  END IF;
  IF jsonb_typeof(p_decision -> 'internalNotes') NOT IN ('string', 'null') OR char_length(v_internal_notes) > 4000 THEN
    v_failures := array_append(v_failures, 'internalNotes:INVALID');
  END IF;
  IF v_outcome = 'CHANGES_REQUESTED' AND (v_changes IS NULL OR jsonb_array_length(v_changes) = 0) THEN
    v_failures := array_append(v_failures, 'requestedChanges:REQUIRED');
  END IF;
  IF v_outcome = 'REJECTED' THEN
    IF v_rejected IS NULL OR jsonb_typeof(v_rejected) <> 'array' OR jsonb_array_length(v_rejected) = 0 THEN
      v_failures := array_append(v_failures, 'rejectedBookings:REQUIRED');
    ELSIF jsonb_array_length(v_rejected) > 20 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_rejected) AS item
       WHERE jsonb_typeof(item) <> 'object'
          OR jsonb_typeof(item -> 'bookingId') <> 'number'
          OR jsonb_typeof(item -> 'reason') <> 'string'
          OR char_length(btrim(item ->> 'reason')) NOT BETWEEN 1 AND 1000
          OR EXISTS (SELECT 1 FROM jsonb_object_keys(item) AS key WHERE key NOT IN ('bookingId', 'reason'))
    ) THEN
      v_failures := array_append(v_failures, 'rejectedBookings:INVALID');
    ELSIF (SELECT count(DISTINCT item ->> 'bookingId') FROM jsonb_array_elements(v_rejected) AS item) <> jsonb_array_length(v_rejected)
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_rejected) AS item
          WHERE NOT EXISTS (
            SELECT 1 FROM public.venue_booking AS b
             WHERE b.booking_id::text = item ->> 'bookingId'
               AND b.event_id = v_event.event_id
               AND b.status IN ('PENDING', 'APPROVED')
          )
       ) THEN
      -- TC-16: only active bookings of this event, each named once.
      v_failures := array_append(v_failures, 'rejectedBookings:NOT_ACTIVE_ON_EVENT');
    END IF;
  END IF;
  IF cardinality(v_failures) > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_SAFETY_REVIEW', DETAIL = array_to_string(v_failures, ',');
  END IF;

  -- AC8: approval needs every factor satisfactory or not applicable.
  IF v_outcome = 'APPROVED' THEN
    SELECT array_agg(key ORDER BY key) INTO v_unsatisfied
      FROM jsonb_each(v_checklist) AS entry(key, value)
     WHERE value ->> 'result' = 'NOT_SATISFACTORY';
    IF v_unsatisfied IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SAFETY_FACTOR_NOT_SATISFACTORY', DETAIL = array_to_string(v_unsatisfied, ',');
    END IF;
  ELSE
    v_action := CASE v_outcome WHEN 'CHANGES_REQUESTED' THEN 'safety_changes_requested' ELSE 'safety_rejected' END;
    PERFORM public._check_event_transition(v_event, v_action, p_actor_id, NULL);
  END IF;

  UPDATE public.safety_reviews
     SET status = v_outcome,
         checklist = v_checklist,
         organiser_comment = v_organiser_comment,
         internal_notes = v_internal_notes,
         requested_changes = CASE WHEN v_outcome = 'CHANGES_REQUESTED' THEN v_changes ELSE NULL END,
         decided_by = p_actor_id,
         decided_at = now()
   WHERE review_id = p_review_id
  RETURNING * INTO v_round;

  IF v_outcome = 'REJECTED' THEN
    INSERT INTO public.safety_review_rejected_bookings (review_id, booking_id, reason)
    SELECT p_review_id, (item ->> 'bookingId')::integer, btrim(item ->> 'reason')
      FROM jsonb_array_elements(v_rejected) AS item;
  END IF;

  -- AC16: one history entry per decision; the comments and notes stay on the round.
  IF v_outcome = 'APPROVED' THEN
    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
    VALUES (p_actor_id, 'event', v_event.event_id, 'SAFETY_REVIEW_APPROVED',
            format('Safety review round %s approved.', v_round.round_number), 'SAFETY_OFFICER', NULL, 'ORGANISER_SAFE');
  ELSE
    v_event := public._apply_event_transition(
      v_event, v_action, p_actor_id,
      CASE v_outcome
        WHEN 'CHANGES_REQUESTED' THEN format('Safety review round %s requested changes.', v_round.round_number)
        ELSE format('Safety review round %s rejected %s venue booking(s).', v_round.round_number, jsonb_array_length(v_rejected))
      END
    );
  END IF;

  -- AC14: coordinator, Venue Staff for the affected venues, Technical Support for
  -- the event's technical arrangements.
  v_request_id := 'REQ-' || lpad(v_event.event_id::text, 6, '0');
  v_label := CASE v_outcome
    WHEN 'APPROVED' THEN 'approved'
    WHEN 'CHANGES_REQUESTED' THEN 'changes requested'
    ELSE 'venue bookings rejected'
  END;
  PERFORM public._notify_event_users(
    v_event.event_id,
    'Safety review ' || v_label,
    CASE v_outcome
      WHEN 'APPROVED' THEN format('Event %s "%s" passed its safety review. You can now confirm it.', v_request_id, v_event.title)
      WHEN 'CHANGES_REQUESTED' THEN format(
        'The safety review of event %s "%s" requested changes. The event is back in planning. Changes needed: %s.%s',
        v_request_id, v_event.title,
        (SELECT string_agg(rtrim(btrim(c.item #>> '{}'), '.'), '; ' ORDER BY c.ord)
           FROM jsonb_array_elements(v_changes) WITH ORDINALITY AS c(item, ord)),
        COALESCE(' Comment: ' || v_organiser_comment, '')
      )
      ELSE format(
        'The safety review of event %s "%s" rejected %s venue booking(s). The event is back in planning. %s.%s',
        v_request_id, v_event.title, jsonb_array_length(v_rejected),
        (SELECT string_agg(
                  format('%s: %s', COALESCE(NULLIF(btrim(b.label), '') || ' at ' || v.name, v.name), rtrim(rb.reason, '.')),
                  '; ' ORDER BY rb.booking_id)
           FROM public.safety_review_rejected_bookings AS rb
           JOIN public.venue_booking AS b ON b.booking_id = rb.booking_id
           JOIN public.room AS r ON r.room_id = b.room_id
           JOIN public.venue AS v ON v.venue_id = r.venue_id
          WHERE rb.review_id = p_review_id),
        COALESCE(' Comment: ' || v_organiser_comment, '')
      )
    END,
    ARRAY[v_event.coordinator_id]
  );

  SELECT COALESCE(array_agg(DISTINCT b.reviewed_by), ARRAY[]::integer[]) INTO v_venue_staff
    FROM public.venue_booking AS b
    JOIN public."user" AS u ON u.user_id = b.reviewed_by AND u.is_active
   WHERE b.event_id = v_event.event_id
     AND b.reviewed_by IS NOT NULL
     AND CASE
           WHEN v_outcome = 'REJECTED' THEN b.booking_id IN (SELECT booking_id FROM public.safety_review_rejected_bookings WHERE review_id = p_review_id)
           ELSE b.status IN ('PENDING', 'APPROVED')
         END;
  PERFORM public._notify_event_users(
    v_event.event_id,
    'Safety review ' || v_label,
    format('Safety review outcome for event %s "%s": %s.', v_request_id, v_event.title, v_label),
    v_venue_staff || ARRAY(
      SELECT DISTINCT e.reviewed_by
        FROM public.equipment_request AS e
        JOIN public."user" AS u ON u.user_id = e.reviewed_by AND u.is_active
       WHERE e.event_id = v_event.event_id AND e.status = 'APPROVED' AND e.reviewed_by IS NOT NULL
    )
  );

  RETURN public._store_idempotent_response(p_actor_id, v_operation, p_idempotency_key, jsonb_build_object(
    'superseded', false,
    'review', to_jsonb(v_round),
    'event', to_jsonb(v_event)
  ));
END;
$function$;
