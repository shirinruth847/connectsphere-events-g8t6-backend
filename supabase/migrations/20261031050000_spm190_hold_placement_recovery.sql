-- SPM-190: allow a same-key retry to recover an acknowledged-orphan hold.
-- The backend verifies the deterministic ID and MongoDB write identity under
-- event -> venue locks. This function proves no committed placement owns it.
-- No data changes/backfill; apply before deploying the recovery code.
CREATE FUNCTION public.can_recover_venue_hold_placement(
  p_actor_id integer, p_request_id integer, p_hold_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_request public.venue_hold_request;
BEGIN
  PERFORM public._require_venue_staff(p_actor_id);
  IF p_hold_id IS NULL OR p_hold_id !~ '^[0-9a-f]{24}$' THEN
    RAISE EXCEPTION 'INVALID_HOLD';
  END IF;
  -- Reentrant locks: placement has already claimed the key and checked the
  -- current event/request/venue in begin_venue_hold_placement.
  v_request := public._lock_venue_hold_request(p_request_id);
  PERFORM 1 FROM public.venue WHERE venue_id = v_request.venue_id FOR UPDATE;
  IF v_request.status <> 'PENDING' THEN RETURN false; END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM public.venue_hold_request WHERE calendar_hold_id = p_hold_id
  );
END;
$$;
REVOKE ALL ON FUNCTION public.can_recover_venue_hold_placement(integer,integer,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_recover_venue_hold_placement(integer,integer,text) TO venue_calendar_writer;
