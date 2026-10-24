-- SPM-250 (SPM-243 AC12; Master 5.2, 5.9, T7): an arrangement change invalidates
-- the event's safety review.
--
-- Stories that change an event's venue bookings, booking decisions, blocking
-- incidents, technical arrangements or expected attendance (SPM-172, SPM-186,
-- SPM-195, the equipment stories) call _supersede_safety_review inside their own
-- transaction:
--
--   PERFORM public._supersede_safety_review(p_event_id, p_actor_id, 'Venue blocked.');
--
-- It increases event.arrangement_version. When the event is in SAFETY_REVIEW it
-- closes an OPEN round as SUPERSEDED (an APPROVED round keeps its status and
-- stops counting, because its arrangement_version no longer matches), returns the
-- event to PLANNING through the shared transition (T09 safety_superseded), and
-- notifies the claimant and the coordinator. Events in other states only get the
-- new version: a confirmed event goes back to planning through change acceptance.
--
-- p_actor_id may be NULL for system work. The caller has already authorised the
-- change; this function only keeps the review consistent with it.

-- Closes the review for an arrangement change that has already raised the
-- version. p_event must be the row the caller locked FOR UPDATE. Returns
-- { supersededReviewId, statusChanged, event }.
CREATE OR REPLACE FUNCTION public._close_safety_review_for_change(p_event public.event, p_actor_id integer, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event := p_event;
  v_open public.safety_reviews;
  v_approved boolean;
  v_request_id text := 'REQ-' || lpad(p_event.event_id::text, 6, '0');
  v_reason text := left(COALESCE(NULLIF(btrim(p_reason), ''), 'The event''s arrangements changed.'), 500);
BEGIN
  IF p_event.status <> 'SAFETY_REVIEW' THEN
    RETURN jsonb_build_object('supersededReviewId', NULL, 'statusChanged', false, 'event', to_jsonb(v_event));
  END IF;

  SELECT * INTO v_open FROM public.safety_reviews
   WHERE event_id = p_event.event_id AND status = 'OPEN'
   FOR UPDATE;
  IF FOUND THEN
    UPDATE public.safety_reviews
       SET status = 'SUPERSEDED',
           superseded_at = now()
     WHERE review_id = v_open.review_id;
  END IF;
  v_approved := v_open.review_id IS NULL AND EXISTS (
    SELECT 1 FROM public.safety_reviews
     WHERE event_id = p_event.event_id AND status = 'APPROVED'
       AND round_number = (SELECT max(round_number) FROM public.safety_reviews WHERE event_id = p_event.event_id)
  );

  PERFORM public._check_event_transition(p_event, 'safety_superseded', p_actor_id, NULL);
  v_event := public._apply_event_transition(p_event, 'safety_superseded', p_actor_id, 'Safety review superseded: ' || v_reason);

  PERFORM public._notify_event_users(
    p_event.event_id,
    'Safety review superseded',
    format(
      'The arrangements of event %s "%s" changed, so %s. The event is back in planning. Reason: %s',
      v_request_id, p_event.title,
      CASE WHEN v_approved THEN 'its safety approval no longer counts' ELSE 'its safety review was closed' END,
      v_reason
    ),
    array_remove(ARRAY[v_open.claimed_by, p_event.coordinator_id], NULL)
  );

  RETURN jsonb_build_object('supersededReviewId', v_open.review_id, 'statusChanged', true, 'event', to_jsonb(v_event));
END;
$$;

-- Records an arrangement change on the event: raises arrangement_version and
-- closes the safety review. Call inside the transaction that made the change.
CREATE OR REPLACE FUNCTION public._supersede_safety_review(p_event_id integer, p_actor_id integer, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.event;
BEGIN
  UPDATE public.event
     SET arrangement_version = arrangement_version + 1,
         updated_at = now()
   WHERE event_id = p_event_id
  RETURNING * INTO v_event;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;
  RETURN public._close_safety_review_for_change(v_event, p_actor_id, p_reason);
END;
$$;

-- The same for backend code that changes arrangements outside a database
-- function (safetyModel.recordArrangementChange). The caller has authorised the
-- change; an actor, when given, must be an active user.
CREATE OR REPLACE FUNCTION public.record_arrangement_change(p_event_id integer, p_actor_id integer, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_actor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."user" WHERE user_id = p_actor_id AND is_active) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN';
  END IF;
  RETURN public._supersede_safety_review(p_event_id, p_actor_id, p_reason);
END;
$$;

REVOKE ALL ON FUNCTION public._close_safety_review_for_change(public.event, integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._supersede_safety_review(integer, integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_arrangement_change(integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_arrangement_change(integer, integer, text) TO service_role;
