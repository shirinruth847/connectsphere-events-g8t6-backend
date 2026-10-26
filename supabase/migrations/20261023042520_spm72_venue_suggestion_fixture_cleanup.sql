-- SPM-72/SPM-74: test fixtures remove their own events, and an event with a
-- suggestion cannot be deleted while the suggestion row exists (ON DELETE
-- RESTRICT). Same grant as the other event-linked tables (event_assignments,
-- event_venue_preference); inserts and updates still go only through
-- suggest_event_venue.
GRANT DELETE ON public.event_venue_suggestion TO service_role;
