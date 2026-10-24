-- SPM-243 review fixes (AC16; Master 6.3, 7.1).
--
-- 1. A decided or superseded round, and a recorded booking rejection, can no
--    longer change. The safety functions only ever update OPEN rounds; the
--    trigger holds that for every writer, and the backend's service role loses
--    direct UPDATE because every write goes through the SECURITY DEFINER
--    functions. INSERT stays for test fixtures.
-- 2. A round can be claimed only while its event is in SAFETY_REVIEW, so a
--    round left open on an event that has left review is never picked up.
-- 3. The booking side of a rejection is indexed for its foreign key.

CREATE OR REPLACE FUNCTION public._refuse_closed_safety_review_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'safety_reviews' THEN
    IF OLD.status = 'OPEN' THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SAFETY_REVIEW_CLOSED', DETAIL = TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER safety_reviews_closed_round_unchanged
  BEFORE UPDATE ON public.safety_reviews
  FOR EACH ROW EXECUTE FUNCTION public._refuse_closed_safety_review_change();

CREATE TRIGGER safety_review_rejected_bookings_unchanged
  BEFORE UPDATE ON public.safety_review_rejected_bookings
  FOR EACH ROW EXECUTE FUNCTION public._refuse_closed_safety_review_change();

REVOKE ALL ON FUNCTION public._refuse_closed_safety_review_change() FROM PUBLIC, anon, authenticated, service_role;
REVOKE UPDATE ON public.safety_reviews, public.safety_review_rejected_bookings FROM service_role;

-- AC4, now also requiring the event to be awaiting its safety review.
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

  UPDATE public.safety_reviews AS r
     SET claimed_by = p_actor_id,
         claimed_at = now()
   WHERE r.review_id = p_review_id
     AND r.status = 'OPEN'
     AND r.claimed_by IS NULL
     AND EXISTS (SELECT 1 FROM public.event AS e WHERE e.event_id = r.event_id AND e.status = 'SAFETY_REVIEW')
  RETURNING r.* INTO v_round;
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

CREATE INDEX IF NOT EXISTS safety_review_rejected_bookings_booking_id
  ON public.safety_review_rejected_bookings (booking_id);
