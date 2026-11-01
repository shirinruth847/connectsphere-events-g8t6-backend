-- SPM-72/SPM-74 follow-up (developer request, 1 November 2026): the assigned
-- coordinator keeps a list of venues for the organiser instead of one
-- suggestion. A venue from the organiser's own choices is "selected"; any
-- other venue is "suggested", and suggesting one returns the request to the
-- organiser through a clarification (SPM-41), so they can see it and amend
-- their venue choices. Suggestions stay advice: nothing is held or booked
-- (Master 5.2, 5.4).
--
-- Non-destructive: the SPM-72 table and function stay in place. The current
-- suggestion of each event is copied into the new list, and the old function
-- is no longer callable by the runtime.

DO $idempotency_operations$
DECLARE
  v_existing_check text;
BEGIN
  LOCK TABLE public.idempotency_records IN ACCESS EXCLUSIVE MODE;
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT v_existing_check
    FROM pg_constraint
   WHERE conrelid = 'public.idempotency_records'::regclass
     AND conname = 'idempotency_records_operation_check'
     AND contype = 'c';

  EXECUTE format(
    'ALTER TABLE public.idempotency_records
       DROP CONSTRAINT idempotency_records_operation_check,
       ADD CONSTRAINT idempotency_records_operation_check CHECK ((%s) OR operation = %L)',
    v_existing_check, 'event.suggest_venues'
  );
END;
$idempotency_operations$;

-- One row per venue ever put on an event's list; withdrawn_at marks a venue
-- the coordinator took off it. History is the activity_log entries.
CREATE TABLE IF NOT EXISTS public.event_suggested_venue (
  event_id integer NOT NULL REFERENCES public.event (event_id) ON DELETE RESTRICT,
  venue_id integer NOT NULL REFERENCES public.venue (venue_id) ON DELETE RESTRICT,
  suggested_by integer NOT NULL REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  suggested_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  PRIMARY KEY (event_id, venue_id)
);

CREATE INDEX IF NOT EXISTS event_suggested_venue_venue_idx ON public.event_suggested_venue (venue_id);

ALTER TABLE public.event_suggested_venue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_suggested_venue FROM PUBLIC, anon, authenticated, service_role;
-- The runtime reads it; every write goes through suggest_event_venues.
GRANT SELECT ON public.event_suggested_venue TO service_role;

INSERT INTO public.event_suggested_venue (event_id, venue_id, suggested_by, suggested_at)
SELECT event_id, venue_id, suggested_by, suggested_at
  FROM public.event_venue_suggestion
ON CONFLICT (event_id, venue_id) DO NOTHING;

REVOKE EXECUTE ON FUNCTION public.suggest_event_venue(integer, integer, integer, integer, text, text) FROM service_role;

-- Venue names in the order given, e.g. "Hall A, Studio 2"; NULL for none.
CREATE OR REPLACE FUNCTION public._venue_names(p_venue_ids integer[])
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT string_agg(v.name, ', ' ORDER BY u.position)
    FROM unnest(p_venue_ids) WITH ORDINALITY AS u(venue_id, position)
    JOIN public.venue v ON v.venue_id = u.venue_id;
$$;

CREATE OR REPLACE FUNCTION public._event_venue_suggestions_response(p_event_id integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object('suggestions', COALESCE(jsonb_agg(jsonb_build_object(
      'venueId', s.venue_id,
      'name', v.name,
      'address', v.address,
      'maxCapacity', v.max_capacity,
      'suggestedAt', s.suggested_at,
      'suggestedBy', u.name,
      'fromOrganiserChoices', EXISTS (
        SELECT 1 FROM public.event_venue_preference p
         WHERE p.event_id = s.event_id AND p.venue_id = s.venue_id
      )
    ) ORDER BY s.suggested_at, s.venue_id), '[]'::jsonb))
    FROM public.event_suggested_venue s
    JOIN public.venue v ON v.venue_id = s.venue_id
    JOIN public."user" u ON u.user_id = s.suggested_by
   WHERE s.event_id = p_event_id
     AND s.withdrawn_at IS NULL;
$$;

-- p_venue_ids is the whole list the coordinator wants; p_expected_venue_ids is
-- the list they loaded, so a list changed in another tab is not overwritten.
-- p_note is optional and is added to the clarification message.
-- Lock order: event, then venues (Master 7).
CREATE OR REPLACE FUNCTION public.suggest_event_venues(
  p_actor_id integer,
  p_event_id integer,
  p_venue_ids integer[],
  p_expected_venue_ids integer[],
  p_note text,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_operation constant text := 'event.suggest_venues';
  v_event public.event;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_current integer[];
  v_added integer[];
  v_removed integer[];
  v_outside integer[];
  v_before text;
  v_after text;
  v_message text;
  v_round public.clarifications;
  v_clarification jsonb;
  v_notification_id integer;
  v_replay jsonb;
BEGIN
  IF p_venue_ids IS NULL OR p_expected_venue_ids IS NULL
     OR array_position(p_venue_ids, NULL) IS NOT NULL
     OR cardinality(p_venue_ids) > 10
     OR (SELECT count(DISTINCT venue_id) FROM unnest(p_venue_ids) AS venue_id) <> cardinality(p_venue_ids)
     OR char_length(v_note) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_SUGGESTION';
  END IF;
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  PERFORM 1
    FROM public."user"
   WHERE user_id = p_actor_id
     AND role = 'COORDINATOR'
     AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  -- Only the coordinator assigned right now.
  SELECT * INTO v_event
    FROM public.event
   WHERE event_id = p_event_id
     AND coordinator_id = p_actor_id
     AND status::text <> 'DRAFT'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  v_replay := public._claim_idempotency_key(p_actor_id, v_operation, p_idempotency_key, p_request_hash);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;

  -- The organiser can amend their choices only before planning (SPM-41); in
  -- planning the coordinator books venues directly (SPM-179).
  IF v_event.status::text NOT IN ('UNDER_REVIEW', 'AWAITING_CLARIFICATION') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_SUGGESTION_NOT_ALLOWED_IN_STATUS';
  END IF;

  SELECT COALESCE(array_agg(venue_id ORDER BY venue_id), '{}') INTO v_current
    FROM public.event_suggested_venue
   WHERE event_id = p_event_id
     AND withdrawn_at IS NULL;
  IF v_current <> ARRAY(SELECT DISTINCT venue_id FROM unnest(p_expected_venue_ids) AS venue_id ORDER BY venue_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_SUGGESTION_VERSION_CONFLICT';
  END IF;

  v_added := ARRAY(
    SELECT u.venue_id FROM unnest(p_venue_ids) WITH ORDINALITY AS u(venue_id, position)
     WHERE NOT (u.venue_id = ANY (v_current))
     ORDER BY u.position
  );
  v_removed := ARRAY(SELECT venue_id FROM unnest(v_current) AS venue_id WHERE NOT (venue_id = ANY (p_venue_ids)));

  -- Only venues that can be chosen for new requests (Master 6.2), large
  -- enough for the expected attendance (Master 5.4).
  PERFORM 1 FROM public.venue WHERE venue_id = ANY (v_added) ORDER BY venue_id FOR SHARE;
  IF EXISTS (
    SELECT 1 FROM unnest(v_added) AS added(venue_id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.venue v
        WHERE v.venue_id = added.venue_id AND v.is_active AND v.status = 'ACTIVE'
     )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_NOT_SELECTABLE';
  END IF;
  IF v_event.expected_attendance IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.venue
     WHERE venue_id = ANY (v_added)
       AND max_capacity < v_event.expected_attendance
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_CAPACITY_TOO_SMALL';
  END IF;

  -- The same list again changes nothing and notifies no one.
  IF cardinality(v_added) = 0 AND cardinality(v_removed) = 0 THEN
    RETURN public._store_idempotent_response(
      p_actor_id, v_operation, p_idempotency_key,
      public._event_venue_suggestions_response(p_event_id) || jsonb_build_object('clarification', NULL)
    );
  END IF;

  v_before := public._venue_names(ARRAY(
    SELECT venue_id FROM public.event_suggested_venue
     WHERE event_id = p_event_id AND withdrawn_at IS NULL
     ORDER BY suggested_at, venue_id
  ));

  INSERT INTO public.event_suggested_venue (event_id, venue_id, suggested_by, suggested_at)
  SELECT p_event_id, venue_id, p_actor_id, now()
    FROM unnest(v_added) AS venue_id
  ON CONFLICT (event_id, venue_id) DO UPDATE
     SET suggested_by = EXCLUDED.suggested_by,
         suggested_at = EXCLUDED.suggested_at,
         withdrawn_at = NULL;
  UPDATE public.event_suggested_venue
     SET withdrawn_at = now()
   WHERE event_id = p_event_id
     AND venue_id = ANY (v_removed);

  v_after := public._venue_names(p_venue_ids);
  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', p_event_id, 'VENUE_SUGGESTED',
    format('Coordinator updated the venues for the organiser: %s.', COALESCE(v_after, 'none')),
    'COORDINATOR',
    jsonb_build_object('suggestedVenue', jsonb_build_object('before', v_before, 'after', COALESCE(v_after, 'No venues'))),
    'ORGANISER_SAFE'
  );

  -- Venues outside the organiser's choices go to them as a clarification, so
  -- they can amend their choices; their own choices need no answer.
  v_outside := ARRAY(
    SELECT u.venue_id FROM unnest(v_added) WITH ORDINALITY AS u(venue_id, position)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.event_venue_preference p
        WHERE p.event_id = p_event_id AND p.venue_id = u.venue_id
     )
     ORDER BY u.position
  );

  IF cardinality(v_outside) > 0 THEN
    v_message := format(
      'Suggested %s: %s. See %s under Venue arrangements, and amend your venue choices if %s.',
      CASE WHEN cardinality(v_outside) = 1 THEN 'venue' ELSE 'venues' END,
      public._venue_names(v_outside),
      CASE WHEN cardinality(v_outside) = 1 THEN 'it' ELSE 'them' END,
      CASE WHEN cardinality(v_outside) = 1 THEN 'it suits your event' ELSE 'one suits your event' END
    );
    IF v_note IS NOT NULL THEN
      v_message := v_message || E'\n\n' || v_note;
    END IF;

    IF v_event.status::text = 'UNDER_REVIEW' THEN
      -- Opens a thread and notifies the owner; the event lock is already held.
      v_clarification := public.request_event_clarification(
        p_event_id, p_actor_id, v_event.version, v_message, NULL, NULL
      ) -> 'clarification';
    ELSE
      SELECT * INTO v_round
        FROM public.clarifications
       WHERE event_id = p_event_id AND status = 'OPEN'
       ORDER BY round_number DESC
       LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CLARIFICATION_NOT_OPEN';
      END IF;
      PERFORM public.post_clarification_message(p_event_id, v_round.round_number, p_actor_id, v_message, NULL, NULL);
      v_clarification := to_jsonb(v_round);
    END IF;
  ELSIF cardinality(v_added) > 0 THEN
    INSERT INTO public.notification (event_id, title, message, type)
    VALUES (
      p_event_id,
      'Venue selected',
      format(
        'Your event coordinator selected %s from your venue choices for event request REQ-%s. Open the request to see the venue.',
        public._venue_names(v_added), lpad(p_event_id::text, 6, '0')
      ),
      'VENUE_SUGGESTION'
    )
    RETURNING notification_id INTO v_notification_id;
    INSERT INTO public.notification_recipient (notification_id, recipient_id)
    VALUES (v_notification_id, v_event.organiser_id);
  END IF;

  RETURN public._store_idempotent_response(
    p_actor_id, v_operation, p_idempotency_key,
    public._event_venue_suggestions_response(p_event_id) || jsonb_build_object('clarification', v_clarification)
  );
END;
$$;

REVOKE ALL ON FUNCTION public._venue_names(integer[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_venue_suggestions_response(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.suggest_event_venues(integer, integer, integer[], integer[], text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suggest_event_venues(integer, integer, integer[], integer[], text, text, text) TO service_role;
