-- SPM-72/SPM-74: the assigned coordinator suggests one venue to the organiser
-- from the event's venue section. A suggestion is advice, not an arrangement:
-- it does not occupy the venue, create a hold or booking, or change the event's
-- version or arrangement_version (Master 5.2, 5.4). The booking request
-- (SPM-179) still goes through every venue check.

-- The VENUE_SUGGESTION notification type is added by 20261023041402, which
-- must commit first: a new enum value cannot be used in the same transaction.

-- Keeps every operation allowed on the development project on 2026-10-23
-- (including safety.decide from the safety-review branch) and adds this one.
ALTER TABLE public.idempotency_records
  DROP CONSTRAINT idempotency_records_operation_check,
  ADD CONSTRAINT idempotency_records_operation_check CHECK (operation IN (
    'event.create_draft', 'event.create_and_submit', 'event.update_draft', 'event.update_details',
    'event.submit_for_safety_review', 'event.confirm', 'event.start_preparation', 'event.complete',
    'safety.decide', 'event.suggest_venue'
  ));

-- One current suggestion per event; history is the activity_log entries.
CREATE TABLE public.event_venue_suggestion (
  event_id integer PRIMARY KEY REFERENCES public.event (event_id) ON DELETE RESTRICT,
  venue_id integer NOT NULL REFERENCES public.venue (venue_id) ON DELETE RESTRICT,
  suggested_by integer NOT NULL REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  suggested_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CONSTRAINT event_venue_suggestion_version_positive CHECK (version > 0)
);

CREATE INDEX event_venue_suggestion_venue_idx ON public.event_venue_suggestion (venue_id);

ALTER TABLE public.event_venue_suggestion ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_venue_suggestion FROM PUBLIC, anon, authenticated, service_role;
-- The runtime reads it; every write goes through suggest_event_venue.
GRANT SELECT ON public.event_venue_suggestion TO service_role;

-- p_expected_version is the suggestion's version the coordinator saw, 0 when
-- there was none. Lock order: event, then venue (Master 7).
CREATE OR REPLACE FUNCTION public.suggest_event_venue(
  p_actor_id integer,
  p_event_id integer,
  p_venue_id integer,
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
  v_event public.event;
  v_venue public.venue;
  v_current public.event_venue_suggestion;
  v_previous_name text;
  v_replay jsonb;
  v_response jsonb;
  v_notification_id integer;
BEGIN
  IF p_venue_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 0 THEN
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

  -- Only the coordinator assigned right now; one reassigned away while this
  -- waited for the lock is told the event is not found.
  SELECT * INTO v_event
    FROM public.event
   WHERE event_id = p_event_id
     AND coordinator_id = p_actor_id
     AND status::text <> 'DRAFT'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'EVENT_NOT_FOUND';
  END IF;

  v_replay := public._claim_idempotency_key(
    p_actor_id, 'event.suggest_venue', p_idempotency_key, p_request_hash
  );
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;

  IF v_event.status::text NOT IN ('UNDER_REVIEW', 'PLANNING') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_SUGGESTION_NOT_ALLOWED_IN_STATUS';
  END IF;

  -- Only venues that can be chosen for new requests (Master 6.2).
  SELECT * INTO v_venue
    FROM public.venue
   WHERE venue_id = p_venue_id
     AND is_active
     AND status = 'ACTIVE'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_NOT_SELECTABLE';
  END IF;
  -- Capacity is a blocking rule for every booking (Master 5.4), so a venue that
  -- cannot hold the expected attendance is never suggested.
  IF v_event.expected_attendance IS NOT NULL AND v_venue.max_capacity < v_event.expected_attendance THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_CAPACITY_TOO_SMALL';
  END IF;

  SELECT * INTO v_current
    FROM public.event_venue_suggestion
   WHERE event_id = p_event_id
   FOR UPDATE;
  IF COALESCE(v_current.version, 0) <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_SUGGESTION_VERSION_CONFLICT';
  END IF;

  IF v_current.venue_id IS NOT DISTINCT FROM p_venue_id THEN
    -- Suggesting the same venue again changes nothing and notifies no one.
    v_response := public._event_venue_suggestion_response(p_event_id);
    RETURN public._store_idempotent_response(p_actor_id, 'event.suggest_venue', p_idempotency_key, v_response);
  END IF;

  IF v_current.venue_id IS NOT NULL THEN
    SELECT name INTO v_previous_name FROM public.venue WHERE venue_id = v_current.venue_id;
  END IF;

  INSERT INTO public.event_venue_suggestion (event_id, venue_id, suggested_by, suggested_at, version)
  VALUES (p_event_id, p_venue_id, p_actor_id, now(), 1)
  ON CONFLICT (event_id) DO UPDATE
     SET venue_id = EXCLUDED.venue_id,
         suggested_by = EXCLUDED.suggested_by,
         suggested_at = EXCLUDED.suggested_at,
         version = public.event_venue_suggestion.version + 1;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience)
  VALUES (
    p_actor_id, 'event', p_event_id, 'VENUE_SUGGESTED',
    format('Coordinator suggested %s as the venue.', v_venue.name),
    'COORDINATOR',
    jsonb_build_object('suggestedVenue', jsonb_build_object('before', v_previous_name, 'after', v_venue.name)),
    'ORGANISER_SAFE'
  );

  INSERT INTO public.notification (event_id, title, message, type)
  VALUES (
    p_event_id,
    'Venue suggested',
    format(
      'Your event coordinator suggested %s for event request REQ-%s. Open the request to see the venue.',
      v_venue.name, lpad(p_event_id::text, 6, '0')
    ),
    'VENUE_SUGGESTION'
  )
  RETURNING notification_id INTO v_notification_id;
  INSERT INTO public.notification_recipient (notification_id, recipient_id)
  VALUES (v_notification_id, v_event.organiser_id);

  v_response := public._event_venue_suggestion_response(p_event_id);
  RETURN public._store_idempotent_response(p_actor_id, 'event.suggest_venue', p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public._event_venue_suggestion_response(p_event_id integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'suggestion', jsonb_build_object(
      'venueId', s.venue_id,
      'name', v.name,
      'address', v.address,
      'maxCapacity', v.max_capacity,
      'suggestedAt', s.suggested_at,
      'suggestedBy', jsonb_build_object('userId', s.suggested_by, 'name', u.name),
      'version', s.version
    )
  )
    FROM public.event_venue_suggestion s
    JOIN public.venue v ON v.venue_id = s.venue_id
    JOIN public."user" u ON u.user_id = s.suggested_by
   WHERE s.event_id = p_event_id;
$$;

REVOKE ALL ON FUNCTION public._event_venue_suggestion_response(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.suggest_event_venue(integer, integer, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suggest_event_venue(integer, integer, integer, integer, text, text) TO service_role;
