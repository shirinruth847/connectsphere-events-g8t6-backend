-- SPM-73: venue catalog maintenance (corrective, additive)
-- Assumed baseline: public.venue (venue_id, name, address, max_capacity, operating_hours,
-- accessibility_features, setup_turnaround_min). No reset/drop.

alter table public.venue
  add column if not exists status text not null default 'Active',
  add column if not exists contact_person text,
  add column if not exists contact_email text,
  add column if not exists contact_number text,
  add column if not exists version integer not null default 1,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists created_by uuid references auth.users(id) on delete restrict,
  add column if not exists updated_by uuid references auth.users(id) on delete restrict;

alter table public.venue
  add constraint venue_status_check check (status in ('Active','Inactive','Under Maintenance'));

alter table public.venue
  add constraint venue_capacity_positive check (max_capacity > 0 and max_capacity = floor(max_capacity));

create unique index if not exists venue_name_unique on public.venue (lower(name));

grant select, insert, update, delete on table public.venue to service_role;
