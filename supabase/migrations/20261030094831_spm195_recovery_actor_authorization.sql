-- SPM-195: authorize the current recovery requester independently from the
-- original actor recorded in the backend-owned MongoDB intent. Do not require
-- that historical actor to retain their former role or active account.
-- Existing direct writes still require active Venue Staff. The effects helper
-- is private: neither API roles nor the venue lock role can call it directly.

CREATE OR REPLACE FUNCTION public._record_venue_block_change_effects(
  p_actor_id integer,
  p_venue_id integer,
  p_block_id text,
  p_action text,
  p_before jsonb,
  p_after jsonb,
  p_setup integer,
  p_turnaround integer,
  p_event_ids integer[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_venue public.venue;
  v_before text;
  v_after text;
  v_verb text;
  v_change_ref text;
  v_event public.event;
  v_event_id integer;
  v_request_id text;
  v_open jsonb;
BEGIN
  -- Attribution is historical. The public entry point authorizes the current
  -- requester; an earlier actor may since have been deactivated or reassigned.
  IF p_actor_id IS NULL OR NOT EXISTS (SELECT 1 FROM public."user" WHERE user_id = p_actor_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_BLOCK';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('SHORTENED', 'LIFTED') OR p_block_id IS NULL OR p_block_id !~ '^[0-9a-f]{24}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_BLOCK';
  END IF;
  SELECT * INTO v_venue FROM public.venue WHERE venue_id = p_venue_id FOR UPDATE;
  IF NOT FOUND OR NOT v_venue.is_active THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'VENUE_NOT_FOUND';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.resource_incidents
     WHERE calendar_block_id = p_block_id AND type = 'VENUE_BLOCK' AND status = 'OPEN'
       AND NOT (event_id = ANY (COALESCE(p_event_ids, ARRAY[]::integer[])))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AFFECTED_SET_CHANGED';
  END IF;

  BEGIN
    v_before := format('%s to %s', public._venue_local_time((p_before ->> 'start')::timestamptz),
                       public._venue_local_time((p_before ->> 'end')::timestamptz));
    v_after := CASE WHEN p_action = 'LIFTED' THEN 'Lifted'
                    ELSE format('%s to %s', public._venue_local_time((p_after ->> 'start')::timestamptz),
                                public._venue_local_time((p_after ->> 'end')::timestamptz)) END;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_BLOCK';
  END;
  v_verb := CASE WHEN p_action = 'LIFTED' THEN 'lifted' ELSE 'shortened' END;
  -- One notice per change: a block can be shortened more than once.
  v_change_ref := md5(p_action || ':' || COALESCE(p_after::text, ''));

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'venue', p_venue_id, 'VENUE_BLOCK_' || p_action,
    format('Block on %s %s.', v_venue.name, v_verb),
    'VENUE_STAFF',
    jsonb_build_object('block', jsonb_build_object('before', v_before, 'after', v_after)),
    'STAFF_ONLY'
  );

  FOR v_event_id IN
    SELECT DISTINCT unnest(COALESCE(p_event_ids, ARRAY[]::integer[])) ORDER BY 1
  LOOP
    SELECT * INTO v_event FROM public.event WHERE event_id = v_event_id;
    v_request_id := 'REQ-' || lpad(v_event_id::text, 6, '0');

    INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
    VALUES (
      p_actor_id, 'event', v_event_id, 'VENUE_BLOCK_' || p_action,
      format('The block on %s was %s. Venue Staff confirm whether the booking can be restored.', v_venue.name, v_verb),
      'VENUE_STAFF',
      jsonb_build_object('venueBlock', jsonb_build_object('before', v_before, 'after', v_after)),
      'STAFF_ONLY'
    );

    PERFORM public._notify_event_users(
      v_event_id,
      format('Venue block %s', v_verb),
      format('The block on %s for %s "%s" was %s (%s, was %s). Venue Staff will confirm whether the booking can be restored.',
             v_venue.name, v_request_id, v_event.title, v_verb, v_after, v_before),
      public._event_coordinator_recipients(v_event),
      'BOOKING_UPDATE',
      format('VENUE_BLOCK_%s:%s:%s:%s:COORDINATOR', p_action, p_block_id, v_event_id, v_change_ref),
      NULL
    );
    PERFORM public._notify_event_users(
      v_event_id,
      format('Venue block %s', v_verb),
      format('The block on %s was %s (%s, was %s). %s "%s" may now be restorable.',
             v_venue.name, v_verb, v_after, v_before, v_request_id, v_event.title),
      ARRAY(SELECT user_id FROM public."user"
             WHERE role = 'VENUE_STAFF' AND is_active AND user_id <> p_actor_id ORDER BY user_id),
      'BOOKING_UPDATE',
      format('VENUE_BLOCK_%s:%s:%s:%s:VENUE_STAFF', p_action, p_block_id, v_event_id, v_change_ref),
      NULL
    );
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'incidentId', i.incident_id,
           'eventId', i.event_id,
           'bookingId', i.booking_id,
           'calendarHoldId', i.calendar_hold_id,
           'occupiedStart', lower(occupied.range),
           'occupiedEnd', upper(occupied.range)
         ) ORDER BY i.incident_id), '[]'::jsonb)
    INTO v_open
    FROM public.resource_incidents AS i
    LEFT JOIN public.venue_booking AS b ON b.booking_id = i.booking_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(
               b.occupied_range,
               tstzrange(b.start_datetime - make_interval(mins => COALESCE(p_setup, 0)),
                         b.end_datetime + make_interval(mins => COALESCE(p_turnaround, 0)), '[)')
             ) AS range
    ) AS occupied ON b.booking_id IS NOT NULL
   WHERE i.calendar_block_id = p_block_id AND i.type = 'VENUE_BLOCK' AND i.status = 'OPEN';

  RETURN jsonb_build_object('openIncidents', v_open);
END;
$$;

REVOKE ALL ON FUNCTION public._record_venue_block_change_effects(integer, integer, text, text, jsonb, jsonb, integer, integer, integer[]) FROM PUBLIC, anon, authenticated, service_role, venue_calendar_writer;

CREATE OR REPLACE FUNCTION public.record_venue_block_change(
  p_actor_id integer, p_venue_id integer, p_block_id text, p_action text,
  p_before jsonb, p_after jsonb, p_setup integer, p_turnaround integer,
  p_event_ids integer[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public._require_venue_staff(p_actor_id);
  RETURN public._record_venue_block_change_effects(
    p_actor_id, p_venue_id, p_block_id, p_action,
    p_before, p_after, p_setup, p_turnaround, p_event_ids
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_venue_block_change_once(
  p_actor_id integer, p_original_actor_id integer, p_write_token uuid,
  p_venue_id integer, p_block_id text, p_action text,
  p_before jsonb, p_after jsonb, p_setup integer, p_turnaround integer,
  p_event_ids integer[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_receipt public.venue_block_change_receipts;
  v_hash text := md5(jsonb_build_array(p_original_actor_id, p_venue_id, p_block_id, p_action, p_before, p_after)::text);
  v_result jsonb;
BEGIN
  PERFORM public._require_venue_staff(p_actor_id);
  -- The caller already locks events then venue with begin_venue_block_change.
  PERFORM 1 FROM public.venue WHERE venue_id = p_venue_id FOR UPDATE;
  SELECT * INTO v_receipt FROM public.venue_block_change_receipts WHERE write_token = p_write_token;
  IF FOUND THEN
    IF v_receipt.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REUSED';
    END IF;
    RETURN v_receipt.result;
  END IF;
  v_result := public._record_venue_block_change_effects(
    p_original_actor_id, p_venue_id, p_block_id, p_action,
    p_before, p_after, p_setup, p_turnaround, p_event_ids
  );
  INSERT INTO public.venue_block_change_receipts(write_token, actor_id, venue_id, block_id, request_hash, result)
    VALUES (p_write_token, p_original_actor_id, p_venue_id, p_block_id, v_hash, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.record_venue_block_change_once(integer, integer, uuid, integer, text, text, jsonb, jsonb, integer, integer, integer[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_venue_block_change_once(integer, integer, uuid, integer, text, text, jsonb, jsonb, integer, integer, integer[]) TO venue_calendar_writer;
