    -- SPM-181 development data: fills the fields added by migration
-- 20261020070631_spm181_venue_booking_details for the existing organiser and
-- coordinator mock bookings, so the Venue Staff review shows real values.
-- Updates existing rows by explicit ID only; it creates nothing, so there is
-- nothing to clean up. Safe to re-run.

BEGIN;

-- Event type for the events that have venue bookings. Fixture events whose
-- titles do not describe a kind of event are OTHER.
UPDATE public.event SET event_type = 'CONFERENCE' WHERE event_id = 1 AND event_type IS DISTINCT FROM 'CONFERENCE';
UPDATE public.event SET event_type = 'WORKSHOP' WHERE event_id = 2 AND event_type IS DISTINCT FROM 'WORKSHOP';
UPDATE public.event SET event_type = 'SEMINAR' WHERE event_id = 442 AND event_type IS DISTINCT FROM 'SEMINAR';
UPDATE public.event SET event_type = 'OTHER'
WHERE event_type IS NULL
  AND event_id IN (SELECT DISTINCT event_id FROM public.venue_booking);

-- Pending requests awaiting Venue Staff review.
UPDATE public.venue_booking
SET label = 'Main workshop room',
    required_facilities = ARRAY['Projector', 'Whiteboards', 'Power at every table'],
    accessibility_requirements = ARRAY['Step-free access', 'Accessible restroom'],
    special_requirements = 'Tables arranged in clusters of six; coffee station near the entrance.'
WHERE booking_id = 2;

UPDATE public.venue_booking
SET label = 'Plenary hall',
    required_facilities = ARRAY['Stage', 'PA system', 'Lectern microphone'],
    accessibility_requirements = ARRAY['Wheelchair seating', 'Hearing loop'],
    special_requirements = 'Reserved front row for speakers.'
WHERE booking_id = 110;

UPDATE public.venue_booking
SET label = 'Breakout A',
    expected_attendance = 60,
    required_facilities = ARRAY['Projector', 'Whiteboard'],
    accessibility_requirements = ARRAY['Step-free access'],
    special_requirements = NULL
WHERE booking_id = 111;

-- The rejected alternative for the same event keeps its history.
UPDATE public.venue_booking
SET label = 'Breakout B'
WHERE booking_id = 112;

COMMIT;
