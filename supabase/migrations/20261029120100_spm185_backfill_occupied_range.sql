-- SPM-185 backfill (2026-10-29). Stores the occupied range of the active
-- bookings made before SPM-179 stored one, at venues whose setup/turnaround
-- minutes are recorded in MongoDB venue_details. The minutes below were read
-- from venue_details on 2026-10-28; they are set once (Master 5.4.1), so they
-- cannot have changed since.
--   venue  setup  turnaround  active bookings on 2026-10-29
--   1      45     45          1
--   2      30     30          2
--   45     30     45          110, 3195
--   46     15     15          111, 119
--   48     0      0           114, 116, 117
--   49     30     30          3196
--   50     30     30          3197
-- The other active bookings are at spm32-* test fixture venues without a
-- venue_details document; they keep no range and the exclusion constraint
-- ignores them (Master 5.4.1: such venues cannot receive bookings).
-- Requires 20261029120000_spm185_booking_no_overlap. Not applied to the shared
-- database yet; run it in the same transaction as that file.

CREATE TEMP TABLE spm185_venue_minutes (
  venue_id integer PRIMARY KEY,
  setup_minutes integer NOT NULL,
  turnaround_minutes integer NOT NULL
);

INSERT INTO spm185_venue_minutes (venue_id, setup_minutes, turnaround_minutes)
VALUES (1, 45, 45), (2, 30, 30), (45, 30, 45), (46, 15, 15), (48, 0, 0), (49, 30, 30), (50, 30, 30);

-- Re-check before writing: no two active bookings at one venue may overlap
-- once setup and turnaround are added. Bookings left without minutes are
-- compared on their booking window.
DO $$
DECLARE
  v_pairs text;
BEGIN
  WITH candidate AS (
    SELECT b.booking_id,
           b.venue_id,
           coalesce(
             b.occupied_range,
             public.venue_occupied_range(b.start_datetime, b.end_datetime, m.setup_minutes, m.turnaround_minutes),
             tstzrange(b.start_datetime, b.end_datetime, '[)')
           ) AS occupied_range
      FROM public.venue_booking AS b
      LEFT JOIN spm185_venue_minutes AS m ON m.venue_id = b.venue_id
     WHERE b.status IN ('PENDING', 'APPROVED')
  )
  SELECT string_agg(format('venue %s: bookings %s and %s', a.venue_id, a.booking_id, c.booking_id), '; ')
    INTO v_pairs
    FROM candidate AS a
    JOIN candidate AS c ON c.venue_id = a.venue_id AND c.booking_id > a.booking_id
   WHERE a.occupied_range && c.occupied_range;
  IF v_pairs IS NOT NULL THEN
    RAISE EXCEPTION 'SPM-185 backfill stopped, active bookings overlap with setup/turnaround: %', v_pairs;
  END IF;
END;
$$;

-- The backfill is not an edit, so "Last edited" (updated_at) is left alone.
ALTER TABLE public.venue_booking DISABLE TRIGGER venue_booking_touch_updated_at;
UPDATE public.venue_booking AS b
   SET occupied_range = public.venue_occupied_range(b.start_datetime, b.end_datetime, m.setup_minutes, m.turnaround_minutes)
  FROM spm185_venue_minutes AS m
 WHERE m.venue_id = b.venue_id
   AND b.status IN ('PENDING', 'APPROVED')
   AND b.occupied_range IS NULL;
ALTER TABLE public.venue_booking ENABLE TRIGGER venue_booking_touch_updated_at;

DO $$
DECLARE
  v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
    FROM public.venue_booking AS b
    JOIN spm185_venue_minutes AS m ON m.venue_id = b.venue_id
   WHERE b.status IN ('PENDING', 'APPROVED')
     AND b.occupied_range IS NULL;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'SPM-185 backfill stopped, % active bookings at venues with minutes have no range', v_missing;
  END IF;
END;
$$;

DROP TABLE spm185_venue_minutes;
