-- SPM-179 review follow-up (Master 4.3, 7.4, 10.3.1): only the venue lock
-- connection may run the booking request, and it may not sit in an open
-- transaction holding venue locks.
--
-- Privilege administration is an owner action: run this file in the Supabase
-- SQL editor. The version is recorded in supabase_migrations.schema_migrations
-- afterwards and this file renamed to match.

-- The two functions are one transaction on the venue lock connection. Called
-- through the Data API they would run as separate transactions, skipping the
-- MongoDB hold and block checks made under the lock. The backend never calls
-- them with the service role, so only venue_calendar_writer keeps EXECUTE.
REVOKE EXECUTE ON FUNCTION public.begin_venue_booking_request(integer, integer, integer[], text, text) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.request_venue_bookings(integer, integer, jsonb, jsonb, jsonb, text, text) FROM service_role;

-- statement_timeout (15s) bounds each statement, not the time between them. A
-- transaction left open (e.g. a stalled MongoDB read) is ended after 15s, which
-- releases the event and venue locks.
ALTER ROLE venue_calendar_writer SET idle_in_transaction_session_timeout = '15s';
