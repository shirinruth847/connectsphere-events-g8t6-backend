-- SPM-32: link application users to Supabase Auth and add verified organisation membership.
-- Additive only: existing rows keep working, and new columns are nullable or defaulted.

-- Link by Auth user ID rather than email, which the Auth user can change.
-- Deleting an Auth account must not cascade into event or audit history.
alter table public."user"
  add column auth_user_id uuid unique references auth.users (id) on delete set null,
  add column is_active boolean not null default true;

create table public.organisation (
  organisation_id integer generated always as identity primary key,
  name varchar(200) not null,
  created_at timestamptz not null default now()
);

create unique index organisation_name_lower_key on public.organisation (lower(name));

-- Membership is trusted pre-provisioned data (Master D07); users cannot self-assert it.
create table public.organisation_membership (
  organisation_id integer not null references public.organisation (organisation_id) on delete restrict,
  user_id integer not null references public."user" (user_id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (organisation_id, user_id)
);

create index organisation_membership_user_id_idx on public.organisation_membership (user_id);

-- Nullable: an organiser may submit without an organisation.
alter table public.event
  add column organisation_id integer references public.organisation (organisation_id) on delete restrict;

create index event_organisation_id_idx on public.event (organisation_id);

-- Business data is reached only through the Express backend.
alter table public.organisation enable row level security;
alter table public.organisation_membership enable row level security;
revoke all on public.organisation, public.organisation_membership from anon, authenticated;
