-- SPM-32: the Express backend connects as service_role, which had no DML
-- privileges on application tables (every query failed with 42501).
-- Grants go to service_role only; anon and authenticated stay without access
-- so the browser cannot bypass the backend. New tables must grant explicitly
-- in their own migration; no default privileges are set.

grant select, insert, update, delete on table
  public."user",
  public.organisation,
  public.organisation_membership,
  public.event,
  public.event_comment,
  public.event_document,
  public.event_change_request,
  public.venue,
  public.room,
  public.venue_booking,
  public.equipment,
  public.equipment_request,
  public.registration,
  public.notification,
  public.notification_recipient
to service_role;

-- Audit history is append-only for the application runtime (Master 4.3).
grant select, insert on table public.activity_log to service_role;
