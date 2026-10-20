-- SPM-181: Venue Staff review of venue booking requests.
-- Adds the per-booking fields of Master section 6.2 ("label, booking window,
-- per-booking expected attendance/layout/requirements") that the booking list
-- and detail need, a stable booking reference, and the event type shown in the
-- list. Additive only: existing inserts keep working because every new column
-- is nullable, defaulted or generated.

BEGIN;

ALTER TABLE public.venue_booking
  ADD COLUMN booking_reference text
    GENERATED ALWAYS AS ('VB-' || lpad(booking_id::text, 6, '0')) STORED,
  ADD COLUMN label varchar(100),
  ADD COLUMN expected_attendance integer,
  ADD COLUMN layout_type varchar(100),
  ADD COLUMN required_facilities text[] NOT NULL DEFAULT '{}',
  ADD COLUMN accessibility_requirements text[] NOT NULL DEFAULT '{}',
  ADD COLUMN special_requirements text;

ALTER TABLE public.venue_booking
  ADD CONSTRAINT venue_booking_reference_key UNIQUE (booking_reference),
  ADD CONSTRAINT venue_booking_label_not_blank
    CHECK (label IS NULL OR btrim(label) <> ''),
  ADD CONSTRAINT venue_booking_expected_attendance_positive
    CHECK (expected_attendance IS NULL OR expected_attendance > 0),
  ADD CONSTRAINT venue_booking_required_facilities_bounded
    CHECK (cardinality(required_facilities) <= 20),
  ADD CONSTRAINT venue_booking_accessibility_requirements_bounded
    CHECK (cardinality(accessibility_requirements) <= 20),
  ADD CONSTRAINT venue_booking_special_requirements_length
    CHECK (special_requirements IS NULL OR char_length(special_requirements) <= 2000);

-- Existing bookings predate per-booking requirements: they were made for the
-- whole event in the booked room's layout, so those are their values.
UPDATE public.venue_booking AS b
SET expected_attendance = e.expected_attendance
FROM public.event AS e
WHERE e.event_id = b.event_id
  AND b.expected_attendance IS NULL
  AND e.expected_attendance > 0;

UPDATE public.venue_booking AS b
SET layout_type = r.layout_type
FROM public.room AS r
WHERE r.room_id = b.room_id
  AND b.layout_type IS NULL;

-- The list filters by status and orders by booking start; event_id and
-- room_id already have indexes.
CREATE INDEX venue_booking_status_start_idx
  ON public.venue_booking (status, start_datetime);

ALTER TABLE public.event
  ADD COLUMN event_type text,
  ADD CONSTRAINT event_type_valid CHECK (
    event_type IS NULL
    OR event_type IN ('CONFERENCE', 'WORKSHOP', 'SEMINAR', 'NETWORKING', 'SOCIAL', 'TRAINING', 'OTHER')
  );

COMMIT;
