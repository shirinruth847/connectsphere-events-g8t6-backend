-- SPM-179 (Master 1.6.2 sections 2.7.2, 4.3, 7.4, T33): the least-privilege role
-- behind VENUE_LOCK_DATABASE_URL. It can only call the two venue booking
-- functions, which hold the venue lock while the backend reads MongoDB.
--
-- Privilege administration is an owner action (Master 10.3.1): run this file in
-- the Supabase SQL editor, not through an agent. Then, in the SQL editor only
-- (never committed, never pasted into chat or Jira), give the role a login:
--   ALTER ROLE venue_calendar_writer WITH LOGIN PASSWORD '<generated password>';
-- and set VENUE_LOCK_DATABASE_URL in the backend .env to the session pooler URL
-- for user venue_calendar_writer.rvwiflsedoujspmzfrbq, port 5432, sslmode=require.

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'venue_calendar_writer') THEN
    CREATE ROLE venue_calendar_writer NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$role$;

ALTER ROLE venue_calendar_writer CONNECTION LIMIT 10;
-- A request never waits long: lock waits are bounded per transaction by the
-- backend (lock_timeout), and no statement may run away.
ALTER ROLE venue_calendar_writer SET statement_timeout = '15s';

GRANT USAGE ON SCHEMA public TO venue_calendar_writer;
GRANT EXECUTE ON FUNCTION public.begin_venue_booking_request(integer, integer, integer[], text, text) TO venue_calendar_writer;
GRANT EXECUTE ON FUNCTION public.request_venue_bookings(integer, integer, jsonb, jsonb, jsonb, text, text) TO venue_calendar_writer;
