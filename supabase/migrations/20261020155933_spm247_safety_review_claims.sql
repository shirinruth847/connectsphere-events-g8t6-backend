-- SPM-247 (SPM-243 AC4, AC5, AC7, AC16): claiming a safety review round,
-- handing it back to the queue, and saving checklist progress (Master 5.9, T6).
--
-- Claims are first come, first served: the claim is one conditional UPDATE, so of
-- two simultaneous claims the second finds the round already claimed and gets
-- ROUND_NOT_CLAIMABLE. There is no review timeout. A hand-back clears the saved
-- progress and returns the round to the shared queue. Claims and hand-backs each
-- write a staff-only history entry; saving progress is not history.
--
-- The checklist is stored as the API sends it: one object per factor, keyed by
-- attendanceCapacity, layout, emergencyAccess, accessibility, equipmentPlacement
-- and venueRestrictions, each { "result": ..., "comment": ... }. The decision
-- function (SPM-249) checks it complete; progress may be partial.

-- ---------- helpers ----------

-- Failing "<field>:<reason>" codes for a checklist; empty when it is acceptable.
-- p_complete demands every factor with a result, and a comment unless SATISFACTORY.
CREATE OR REPLACE FUNCTION public._safety_checklist_failures(p_checklist jsonb, p_complete boolean)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_factors constant text[] := ARRAY['attendanceCapacity', 'layout', 'emergencyAccess', 'accessibility', 'equipmentPlacement', 'venueRestrictions'];
  v_failures text[] := ARRAY[]::text[];
  v_factor text;
  v_entry jsonb;
  v_result text;
BEGIN
  IF p_checklist IS NULL OR jsonb_typeof(p_checklist) = 'null' THEN
    IF p_complete THEN
      RETURN ARRAY(SELECT factor || ':REQUIRED' FROM unnest(v_factors) AS factor);
    END IF;
    RETURN v_failures;
  END IF;
  IF jsonb_typeof(p_checklist) <> 'object' THEN
    RETURN ARRAY['checklist:INVALID'];
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_checklist) AS key WHERE NOT key = ANY (v_factors)) THEN
    v_failures := array_append(v_failures, 'checklist:UNKNOWN_FACTOR');
  END IF;

  FOREACH v_factor IN ARRAY v_factors LOOP
    v_entry := p_checklist -> v_factor;
    IF v_entry IS NULL OR jsonb_typeof(v_entry) = 'null' THEN
      IF p_complete THEN
        v_failures := array_append(v_failures, v_factor || ':REQUIRED');
      END IF;
      CONTINUE;
    END IF;
    IF jsonb_typeof(v_entry) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_entry) AS key WHERE key NOT IN ('result', 'comment'))
       OR (v_entry ? 'result' AND jsonb_typeof(v_entry -> 'result') NOT IN ('string', 'null'))
       OR (v_entry ? 'comment' AND jsonb_typeof(v_entry -> 'comment') NOT IN ('string', 'null')) THEN
      v_failures := array_append(v_failures, v_factor || ':INVALID');
      CONTINUE;
    END IF;

    v_result := v_entry ->> 'result';
    IF v_result IS NULL THEN
      IF p_complete THEN
        v_failures := array_append(v_failures, v_factor || ':RESULT_REQUIRED');
      END IF;
    ELSIF v_result NOT IN ('SATISFACTORY', 'NOT_SATISFACTORY', 'NOT_APPLICABLE') THEN
      v_failures := array_append(v_failures, v_factor || ':INVALID_RESULT');
    END IF;

    IF char_length(v_entry ->> 'comment') > 1000 THEN
      v_failures := array_append(v_failures, v_factor || ':COMMENT_TOO_LONG');
    ELSIF p_complete
          AND v_result IN ('NOT_SATISFACTORY', 'NOT_APPLICABLE')
          AND NULLIF(btrim(v_entry ->> 'comment'), '') IS NULL THEN
      v_failures := array_append(v_failures, v_factor || ':COMMENT_REQUIRED');
    END IF;
  END LOOP;

  RETURN v_failures;
END;
$$;

-- Failing codes for a requested-changes list: up to 20 non-blank texts of at
-- most 500 characters each.
CREATE OR REPLACE FUNCTION public._safety_requested_changes_failures(p_changes jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_changes IS NULL OR jsonb_typeof(p_changes) = 'null' THEN ARRAY[]::text[]
    WHEN jsonb_typeof(p_changes) <> 'array' OR jsonb_array_length(p_changes) > 20 THEN ARRAY['requestedChanges:INVALID']
    WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_changes) AS item
       WHERE jsonb_typeof(item) <> 'string'
          OR char_length(btrim(item #>> '{}')) NOT BETWEEN 1 AND 500
    ) THEN ARRAY['requestedChanges:INVALID']
    ELSE ARRAY[]::text[]
  END;
$$;

-- Raises unless the actor is an active Safety Officer.
CREATE OR REPLACE FUNCTION public._require_safety_officer(p_actor_id integer)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."user" WHERE user_id = p_actor_id AND role = 'SAFETY_OFFICER' AND is_active
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN';
  END IF;
END;
$$;

-- Locks the round and raises unless it is OPEN and held by the actor.
CREATE OR REPLACE FUNCTION public._lock_claimed_round(p_review_id bigint, p_actor_id integer)
RETURNS public.safety_reviews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_round public.safety_reviews;
BEGIN
  SELECT * INTO v_round FROM public.safety_reviews WHERE review_id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'REVIEW_NOT_FOUND';
  END IF;
  IF v_round.status <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ROUND_NOT_OPEN', DETAIL = v_round.status;
  END IF;
  IF v_round.claimed_by IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOT_CLAIMANT';
  END IF;
  RETURN v_round;
END;
$$;

-- ---------- actions ----------

-- AC4: the round moves from the shared queue to this officer's reviews.
CREATE OR REPLACE FUNCTION public.claim_safety_review(p_review_id bigint, p_actor_id integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_round public.safety_reviews;
BEGIN
  PERFORM public._require_safety_officer(p_actor_id);

  UPDATE public.safety_reviews
     SET claimed_by = p_actor_id,
         claimed_at = now()
   WHERE review_id = p_review_id
     AND status = 'OPEN'
     AND claimed_by IS NULL
  RETURNING * INTO v_round;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.safety_reviews WHERE review_id = p_review_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ROUND_NOT_CLAIMABLE';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'REVIEW_NOT_FOUND';
  END IF;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', v_round.event_id, 'SAFETY_REVIEW_CLAIMED',
    format('Safety review round %s claimed.', v_round.round_number),
    'SAFETY_OFFICER', NULL, 'STAFF_ONLY'
  );

  RETURN to_jsonb(v_round);
END;
$$;

-- AC5: only the current claimant, only while undecided. Saved progress is
-- cleared and the round returns to the shared queue.
CREATE OR REPLACE FUNCTION public.hand_back_safety_review(p_review_id bigint, p_actor_id integer, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_round public.safety_reviews;
  v_note text := NULLIF(btrim(p_note), '');
BEGIN
  PERFORM public._require_safety_officer(p_actor_id);
  IF char_length(v_note) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_SAFETY_REVIEW', DETAIL = 'note:TOO_LONG';
  END IF;
  v_round := public._lock_claimed_round(p_review_id, p_actor_id);

  UPDATE public.safety_reviews
     SET claimed_by = NULL,
         claimed_at = NULL,
         checklist = NULL,
         organiser_comment = NULL,
         internal_notes = NULL,
         requested_changes = NULL
   WHERE review_id = p_review_id
  RETURNING * INTO v_round;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', v_round.event_id, 'SAFETY_REVIEW_HANDED_BACK',
    format('Safety review round %s handed back to the queue.', v_round.round_number)
      || COALESCE(' Note: ' || v_note, ''),
    'SAFETY_OFFICER', NULL, 'STAFF_ONLY'
  );

  RETURN to_jsonb(v_round);
END;
$$;

-- AC7: saves any of checklist, organiserComment, internalNotes and
-- requestedChanges for the claimant; a key that is present replaces the stored
-- value (null clears it), an absent key keeps it.
CREATE OR REPLACE FUNCTION public.save_safety_review_progress(p_review_id bigint, p_actor_id integer, p_progress jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_round public.safety_reviews;
  v_checklist jsonb;
  v_changes jsonb;
  v_organiser_comment text;
  v_internal_notes text;
  v_failures text[];
BEGIN
  PERFORM public._require_safety_officer(p_actor_id);
  IF p_progress IS NULL OR jsonb_typeof(p_progress) <> 'object'
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_progress) AS key
        WHERE key NOT IN ('checklist', 'organiserComment', 'internalNotes', 'requestedChanges')
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_SAFETY_REVIEW', DETAIL = 'body:INVALID';
  END IF;
  v_round := public._lock_claimed_round(p_review_id, p_actor_id);

  v_checklist := CASE WHEN p_progress ? 'checklist' THEN NULLIF(p_progress -> 'checklist', 'null'::jsonb) ELSE v_round.checklist END;
  v_changes := CASE WHEN p_progress ? 'requestedChanges' THEN NULLIF(p_progress -> 'requestedChanges', 'null'::jsonb) ELSE v_round.requested_changes END;
  v_organiser_comment := CASE WHEN p_progress ? 'organiserComment' THEN NULLIF(btrim(p_progress ->> 'organiserComment'), '') ELSE v_round.organiser_comment END;
  v_internal_notes := CASE WHEN p_progress ? 'internalNotes' THEN NULLIF(btrim(p_progress ->> 'internalNotes'), '') ELSE v_round.internal_notes END;

  v_failures := public._safety_checklist_failures(v_checklist, false)
             || public._safety_requested_changes_failures(v_changes);
  IF jsonb_typeof(p_progress -> 'organiserComment') NOT IN ('string', 'null') OR char_length(v_organiser_comment) > 2000 THEN
    v_failures := array_append(v_failures, 'organiserComment:INVALID');
  END IF;
  IF jsonb_typeof(p_progress -> 'internalNotes') NOT IN ('string', 'null') OR char_length(v_internal_notes) > 4000 THEN
    v_failures := array_append(v_failures, 'internalNotes:INVALID');
  END IF;
  IF cardinality(v_failures) > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_SAFETY_REVIEW', DETAIL = array_to_string(v_failures, ',');
  END IF;

  UPDATE public.safety_reviews
     SET checklist = v_checklist,
         requested_changes = v_changes,
         organiser_comment = v_organiser_comment,
         internal_notes = v_internal_notes
   WHERE review_id = p_review_id
  RETURNING * INTO v_round;

  RETURN to_jsonb(v_round);
END;
$$;

-- ---------- privileges ----------

REVOKE ALL ON FUNCTION public._safety_checklist_failures(jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._safety_requested_changes_failures(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._require_safety_officer(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._lock_claimed_round(bigint, integer) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.claim_safety_review(bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hand_back_safety_review(bigint, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_safety_review_progress(bigint, integer, jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_safety_review(bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.hand_back_safety_review(bigint, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_safety_review_progress(bigint, integer, jsonb) TO service_role;
