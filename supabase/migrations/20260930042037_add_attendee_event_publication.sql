alter table public.event
  add column if not exists is_published boolean not null default false,
  add column if not exists registration_open_at timestamptz,
  add column if not exists registration_close_at timestamptz;

alter table public.event
  drop constraint if exists event_registration_window_check;

alter table public.event
  add constraint event_registration_window_check
  check (
    registration_open_at is null
    or registration_close_at is null
    or registration_close_at > registration_open_at
  );

create index if not exists event_attendee_discovery_idx
  on public.event (start_datetime, event_id)
  where status = 'CONFIRMED' and is_published = true;
