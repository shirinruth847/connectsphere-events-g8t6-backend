-- SPM-73: venue catalogue maintenance by Venue Staff (replaces the unapplied
-- draft 20261017120000_spm73_venue_catalog_maintenance).
--   * status is the operational state Venue Staff set (ACTIVE, INACTIVE,
--     UNDER_MAINTENANCE; Master 6.1: text with a check, not an enum). It is
--     separate from is_active (SPM-72), which is false only for a venue deleted
--     as unusable (SPM-210). Only venues with is_active AND status = 'ACTIVE'
--     can be chosen for new requests or bookings.
--   * Contact details, a version for stale-save protection (Master 6.1) and who
--     created and last changed each venue.
--   * Venue names are unique regardless of letter case.
--   * Create, update and status change each write the venue and its audit entry
--     in one transaction. Existing bookings are never touched.
-- Applied to the development project on 2026-10-20 (version 20261020090836,
-- merged into SPM-181). Verified on 2026-10-19 by a
-- dry run in a rolled-back transaction (every function path below).

ALTER TABLE public.venue
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT venue_status_check CHECK (status IN ('ACTIVE', 'INACTIVE', 'UNDER_MAINTENANCE')),
  ADD COLUMN status_reason text
    CONSTRAINT venue_status_reason_length_check CHECK (char_length(status_reason) <= 500),
  ADD COLUMN contact_person varchar(100),
  ADD COLUMN contact_email varchar(150),
  ADD COLUMN contact_number varchar(30),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CONSTRAINT venue_version_positive_check CHECK (version > 0),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  -- Profiles that changed venues are deactivated, never deleted (Master 6.1).
  ADD COLUMN created_by integer REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  ADD COLUMN updated_by integer REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT venue_max_capacity_positive_check CHECK (max_capacity > 0),
  ADD CONSTRAINT venue_maintenance_reason_check
    CHECK (status <> 'UNDER_MAINTENANCE' OR btrim(coalesce(status_reason, '')) <> '');

CREATE UNIQUE INDEX venue_name_unique ON public.venue (lower(name));

COMMENT ON COLUMN public.venue.status IS
  'Operational state set by Venue Staff. Only ACTIVE venues (with is_active) can be chosen for new requests or bookings.';
COMMENT ON COLUMN public.venue.is_active IS
  'false once the venue is deleted as unusable (SPM-210); the row stays for history. Independent of status.';

-- ---------- helpers ----------

CREATE FUNCTION public._require_venue_staff(p_actor_id integer)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
    FROM public."user"
   WHERE user_id = p_actor_id
     AND role = 'VENUE_STAFF'
     AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FORBIDDEN';
  END IF;
END;
$$;

-- Locks a venue that has not been deleted and checks the version the caller loaded.
CREATE FUNCTION public._lock_venue_for_change(p_venue_id integer, p_expected_version integer)
RETURNS public.venue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_venue public.venue;
BEGIN
  SELECT * INTO v_venue
    FROM public.venue
   WHERE venue_id = p_venue_id
     AND is_active
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'VENUE_NOT_FOUND';
  END IF;
  IF p_expected_version IS NULL OR v_venue.version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_VERSION_CONFLICT';
  END IF;
  RETURN v_venue;
END;
$$;

-- ---------- create ----------

-- p_venue keys are column names; the backend validates and trims the values.
CREATE FUNCTION public.create_venue(p_actor_id integer, p_venue jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_venue public.venue;
BEGIN
  PERFORM public._require_venue_staff(p_actor_id);

  BEGIN
    INSERT INTO public.venue (
      name, address, max_capacity, contact_person, contact_email, contact_number,
      status, status_reason, created_by, updated_by
    )
    VALUES (
      p_venue->>'name',
      p_venue->>'address',
      (p_venue->>'max_capacity')::integer,
      p_venue->>'contact_person',
      p_venue->>'contact_email',
      p_venue->>'contact_number',
      coalesce(p_venue->>'status', 'ACTIVE'),
      p_venue->>'status_reason',
      p_actor_id,
      p_actor_id
    )
    RETURNING * INTO v_venue;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_NAME_TAKEN';
  END;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, changes, audience)
  VALUES (
    p_actor_id, 'venue', v_venue.venue_id, 'VENUE_CREATED', 'Venue created',
    jsonb_build_object(
      'name', jsonb_build_object('before', NULL, 'after', v_venue.name),
      'address', jsonb_build_object('before', NULL, 'after', v_venue.address),
      'maxCapacity', jsonb_build_object('before', NULL, 'after', v_venue.max_capacity),
      'contactPerson', jsonb_build_object('before', NULL, 'after', v_venue.contact_person),
      'contactEmail', jsonb_build_object('before', NULL, 'after', v_venue.contact_email),
      'contactNumber', jsonb_build_object('before', NULL, 'after', v_venue.contact_number),
      'status', jsonb_build_object('before', NULL, 'after', v_venue.status)
    ),
    'STAFF_ONLY'
  );

  RETURN jsonb_build_object('venue', to_jsonb(v_venue), 'changed', true);
END;
$$;

-- ---------- update details ----------

-- p_changes holds only the columns the caller wants to change. Unchanged saves
-- keep the version and write no audit entry.
CREATE FUNCTION public.update_venue(
  p_actor_id integer,
  p_venue_id integer,
  p_expected_version integer,
  p_changes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_venue public.venue;
  v_before jsonb;
  v_after jsonb;
  v_diff jsonb := '{}'::jsonb;
  v_field record;
BEGIN
  PERFORM public._require_venue_staff(p_actor_id);
  IF jsonb_typeof(p_changes) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_VENUE_CHANGES';
  END IF;

  v_venue := public._lock_venue_for_change(p_venue_id, p_expected_version);
  v_before := to_jsonb(v_venue);
  v_after := v_before;

  FOR v_field IN
    SELECT * FROM (VALUES
      ('name', 'name'),
      ('address', 'address'),
      ('max_capacity', 'maxCapacity'),
      ('contact_person', 'contactPerson'),
      ('contact_email', 'contactEmail'),
      ('contact_number', 'contactNumber')
    ) AS f (column_name, api_name)
  LOOP
    IF p_changes ? v_field.column_name
       AND (p_changes->v_field.column_name) IS DISTINCT FROM (v_before->v_field.column_name) THEN
      v_after := jsonb_set(v_after, ARRAY[v_field.column_name], p_changes->v_field.column_name);
      v_diff := v_diff || jsonb_build_object(
        v_field.api_name,
        jsonb_build_object('before', v_before->v_field.column_name, 'after', p_changes->v_field.column_name)
      );
    END IF;
  END LOOP;

  IF v_diff = '{}'::jsonb THEN
    RETURN jsonb_build_object('venue', v_before, 'changed', false);
  END IF;

  BEGIN
    UPDATE public.venue
       SET name = v_after->>'name',
           address = v_after->>'address',
           max_capacity = (v_after->>'max_capacity')::integer,
           contact_person = v_after->>'contact_person',
           contact_email = v_after->>'contact_email',
           contact_number = v_after->>'contact_number',
           version = version + 1,
           updated_at = now(),
           updated_by = p_actor_id
     WHERE venue_id = p_venue_id
    RETURNING * INTO v_venue;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VENUE_NAME_TAKEN';
  END;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, changes, audience)
  VALUES (
    p_actor_id, 'venue', p_venue_id, 'VENUE_UPDATED',
    'Venue details updated: ' || (SELECT string_agg(key, ', ' ORDER BY key) FROM jsonb_object_keys(v_diff) AS key),
    v_diff,
    'STAFF_ONLY'
  );

  RETURN jsonb_build_object('venue', to_jsonb(v_venue), 'changed', true);
END;
$$;

-- ---------- status ----------

-- Taking a venue out of service while it has upcoming PENDING or APPROVED
-- bookings needs p_confirm_upcoming; without it the call fails with the count
-- and first start so the client can warn. Bookings are never changed here.
CREATE FUNCTION public.set_venue_status(
  p_actor_id integer,
  p_venue_id integer,
  p_expected_version integer,
  p_status text,
  p_reason text,
  p_confirm_upcoming boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_venue public.venue;
  v_previous public.venue;
  v_upcoming integer := 0;
  v_first_start timestamptz;
  v_reason text := CASE WHEN p_status = 'ACTIVE' THEN NULL ELSE nullif(btrim(p_reason), '') END;
BEGIN
  PERFORM public._require_venue_staff(p_actor_id);
  v_previous := public._lock_venue_for_change(p_venue_id, p_expected_version);

  IF p_status = v_previous.status AND v_reason IS NOT DISTINCT FROM v_previous.status_reason THEN
    RETURN jsonb_build_object('venue', to_jsonb(v_previous), 'changed', false, 'upcoming_bookings', 0);
  END IF;

  IF p_status <> 'ACTIVE' THEN
    SELECT count(*), min(b.start_datetime)
      INTO v_upcoming, v_first_start
      FROM public.venue_booking AS b
      JOIN public.room AS r ON r.room_id = b.room_id
     WHERE r.venue_id = p_venue_id
       AND b.status IN ('PENDING', 'APPROVED')
       AND b.end_datetime > now();
    IF v_upcoming > 0 AND NOT coalesce(p_confirm_upcoming, false) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'VENUE_HAS_UPCOMING_BOOKINGS',
        DETAIL = jsonb_build_object('upcomingBookings', v_upcoming, 'firstStart', v_first_start)::text;
    END IF;
  END IF;

  UPDATE public.venue
     SET status = p_status,
         status_reason = v_reason,
         version = version + 1,
         updated_at = now(),
         updated_by = p_actor_id
   WHERE venue_id = p_venue_id
  RETURNING * INTO v_venue;

  INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, changes, audience)
  VALUES (
    p_actor_id, 'venue', p_venue_id, 'VENUE_STATUS_CHANGED',
    'Venue status changed to ' || p_status
      || CASE WHEN v_upcoming > 0 THEN format(' with %s upcoming booking(s) kept', v_upcoming) ELSE '' END,
    jsonb_build_object(
      'status', jsonb_build_object('before', v_previous.status, 'after', v_venue.status),
      'statusReason', jsonb_build_object('before', v_previous.status_reason, 'after', v_venue.status_reason)
    ),
    'STAFF_ONLY'
  );

  RETURN jsonb_build_object('venue', to_jsonb(v_venue), 'changed', true, 'upcoming_bookings', v_upcoming);
END;
$$;

REVOKE ALL ON FUNCTION public._require_venue_staff(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._lock_venue_for_change(integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_venue(integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_venue(integer, integer, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_venue_status(integer, integer, integer, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_venue(integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_venue(integer, integer, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_venue_status(integer, integer, integer, text, text, boolean) TO service_role;
