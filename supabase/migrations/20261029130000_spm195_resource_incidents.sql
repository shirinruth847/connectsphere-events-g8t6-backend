-- SPM-195 (T33): resource_incidents, the record of a booking or hold made
-- unavailable by a venue block. Shape from the SPM-173 draft
-- supabase/drafts/20261019100400_master_resource_tables.sql, plus
-- calendar_hold_id so a hold can have an incident.
--
-- Run 20261021100000_spm173_fail_closed_incident_readiness.sql straight after
-- this file, in the same session. Before this table exists that readiness
-- version reports READINESS_DATA_PENDING for every event.
--
-- A VENUE_BLOCK incident names the MongoDB venue_calendar BLOCK document (and,
-- for a hold, the HOLD document) by ID; there is no foreign key across stores.

CREATE TABLE public.resource_incidents (
  incident_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id integer NOT NULL REFERENCES public.event (event_id) ON DELETE RESTRICT,
  type text NOT NULL CHECK (type IN ('VENUE_BLOCK', 'EQUIPMENT_UNAVAILABLE')),
  booking_id integer REFERENCES public.venue_booking (booking_id) ON DELETE RESTRICT,
  calendar_hold_id text CHECK (char_length(calendar_hold_id) <= 64),
  calendar_block_id text CHECK (char_length(calendar_block_id) <= 64),
  equipment_id integer REFERENCES public.equipment (equipment_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution text CHECK (resolution IN ('RESTORED', 'REPLACED', 'RELEASED', 'EVENT_CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  -- Not "..._resolution_check": that is the generated name of the column check above.
  CONSTRAINT resource_incidents_resolution_state_check CHECK (
    (status = 'OPEN' AND resolution IS NULL AND resolved_at IS NULL)
    OR (status = 'RESOLVED' AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  -- A VENUE_BLOCK incident names its block and exactly one of a booking or a hold.
  CONSTRAINT resource_incidents_target_check CHECK (
    (type = 'VENUE_BLOCK'
      AND calendar_block_id IS NOT NULL
      AND equipment_id IS NULL
      AND num_nonnulls(booking_id, calendar_hold_id) = 1)
    OR (type = 'EQUIPMENT_UNAVAILABLE'
      AND equipment_id IS NOT NULL
      AND calendar_block_id IS NULL
      AND calendar_hold_id IS NULL)
  )
);

-- Readiness and the organiser/coordinator views look up open incidents by event.
CREATE INDEX resource_incidents_open_by_event
  ON public.resource_incidents (event_id)
  WHERE status = 'OPEN';

-- One incident per block and booking, and per block and hold (AC13): a retried
-- or repeated block cannot create a second one.
CREATE UNIQUE INDEX resource_incidents_block_booking_key
  ON public.resource_incidents (calendar_block_id, booking_id)
  WHERE type = 'VENUE_BLOCK' AND booking_id IS NOT NULL;

CREATE UNIQUE INDEX resource_incidents_block_hold_key
  ON public.resource_incidents (calendar_block_id, calendar_hold_id)
  WHERE type = 'VENUE_BLOCK' AND calendar_hold_id IS NOT NULL;

-- Writes go through SPM-195's SECURITY DEFINER functions on the venue lock
-- connection. The backend's supabase-js client only reads (SPM-199's organiser
-- view, the coordinator Venue section).
ALTER TABLE public.resource_incidents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.resource_incidents FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.resource_incidents TO service_role;
