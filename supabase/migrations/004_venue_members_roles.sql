-- ============================================================================
-- VAOS — Phase 6A
-- Migration: 004_venue_members_roles.sql
--
-- Replaces the single-owner model (`venues.owner_user_id`) with a real
-- membership + role system.
--
-- Backward compatibility:
--   - `venues.owner_user_id` is preserved, NOT dropped. Existing code that
--     reads it continues to work; helpers in lib/auth/* will prefer
--     `venue_members` and fall back to `owner_user_id`.
--   - All existing venue owners are seeded into `venue_members` with
--     role='owner' so the new path produces the same result on day 1.
--
-- Roles (text check, NOT a Postgres enum — easier to extend later):
--   owner          full control, billing, deletion, member management
--   admin          full control except destructive billing/delete actions
--   sales_manager  CRUD leads/conversations/tours, run AI actions
--   coordinator    CRUD leads/conversations/tours, no settings changes
--   viewer         read-only
--
-- RLS recursion: any policy on `venue_members` that needs to know "is this
-- user a member of this venue" would re-enter the same table and recurse.
-- We solve this with SECURITY DEFINER helper functions (`is_venue_member`,
-- `has_venue_role`) that bypass RLS internally.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------

create table if not exists public.venue_members (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references public.venues(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('owner', 'admin', 'sales_manager', 'coordinator', 'viewer')),
  invited_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (venue_id, user_id)
);

create table if not exists public.venue_invitations (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references public.venues(id) on delete cascade,
  email        text not null,
  role         text not null check (role in ('owner', 'admin', 'sales_manager', 'coordinator', 'viewer')),
  token        text not null unique,
  invited_by   uuid references auth.users(id),
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. Indexes
-- ----------------------------------------------------------------------------

create index if not exists venue_members_user_id_idx     on public.venue_members(user_id);
create index if not exists venue_members_venue_id_idx    on public.venue_members(venue_id);
create index if not exists venue_invitations_email_idx   on public.venue_invitations(email);
create index if not exists venue_invitations_venue_id_idx on public.venue_invitations(venue_id);

-- ----------------------------------------------------------------------------
-- 3. updated_at trigger on venue_members
-- ----------------------------------------------------------------------------

drop trigger if exists venue_members_updated_at on public.venue_members;
create trigger venue_members_updated_at
  before update on public.venue_members
  for each row execute function public.update_updated_at();

-- ----------------------------------------------------------------------------
-- 4. SECURITY DEFINER helpers — break the RLS recursion loop.
-- ----------------------------------------------------------------------------

create or replace function public.is_venue_member(check_venue_id uuid, check_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.venue_members vm
    where vm.venue_id = check_venue_id
      and vm.user_id  = check_user_id
  );
$$;

create or replace function public.has_venue_role(check_venue_id uuid, check_user_id uuid, allowed_roles text[])
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.venue_members vm
    where vm.venue_id = check_venue_id
      and vm.user_id  = check_user_id
      and vm.role     = any(allowed_roles)
  );
$$;

-- Allow the authenticated role to call these helpers (the RLS policies below
-- depend on them). The functions themselves are SECURITY DEFINER, so the
-- invoker's RLS doesn't affect the internal query.
grant execute on function public.is_venue_member(uuid, uuid)            to authenticated;
grant execute on function public.has_venue_role(uuid, uuid, text[])     to authenticated;

-- ----------------------------------------------------------------------------
-- 5. RLS
-- ----------------------------------------------------------------------------

alter table public.venue_members     enable row level security;
alter table public.venue_invitations enable row level security;

-- venue_members:
--   SELECT — any member of the same venue can see siblings
--   INSERT/UPDATE/DELETE — owner+admin only
drop policy if exists "venue_members: select for venue members" on public.venue_members;
create policy "venue_members: select for venue members"
  on public.venue_members
  for select
  to authenticated
  using ( public.is_venue_member(venue_id, auth.uid()) );

drop policy if exists "venue_members: write for owners/admins" on public.venue_members;
create policy "venue_members: write for owners/admins"
  on public.venue_members
  for all
  to authenticated
  using      ( public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin']) )
  with check ( public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin']) );

-- venue_invitations:
--   only owners/admins of the venue can see or mutate
drop policy if exists "venue_invitations: owner/admin access" on public.venue_invitations;
create policy "venue_invitations: owner/admin access"
  on public.venue_invitations
  for all
  to authenticated
  using      ( public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin']) )
  with check ( public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin']) );

-- Service role bypasses RLS by default in Supabase — no extra policy needed.

-- ----------------------------------------------------------------------------
-- 6. Seed existing owners — idempotent.
-- ----------------------------------------------------------------------------

insert into public.venue_members (venue_id, user_id, role)
select id, owner_user_id, 'owner'
from public.venues
where owner_user_id is not null
on conflict (venue_id, user_id) do nothing;

-- ----------------------------------------------------------------------------
-- DOWN (kept as comment for safe manual rollback):
--
-- drop policy if exists "venue_invitations: owner/admin access" on public.venue_invitations;
-- drop policy if exists "venue_members: write for owners/admins" on public.venue_members;
-- drop policy if exists "venue_members: select for venue members" on public.venue_members;
-- drop function if exists public.has_venue_role(uuid, uuid, text[]);
-- drop function if exists public.is_venue_member(uuid, uuid);
-- drop table if exists public.venue_invitations;
-- drop table if exists public.venue_members;
-- ----------------------------------------------------------------------------
