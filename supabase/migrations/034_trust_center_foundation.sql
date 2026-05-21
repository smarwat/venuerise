-- ============================================================================
-- Phase 9N — Trust Center foundation.
--
-- Two tables backing the operator-managed buyer-facing trust surface:
--
--   - `public.trust_access_grants`   — bearer-token grant per buyer
--   - `public.trust_access_events`   — append-only access log
--
-- Operator discipline:
--   - Bearer tokens are sensitive. The plaintext token is returned
--     ONCE at creation and is stored only as a salted-SHA-256
--     hash. Validation hashes the inbound token and compares.
--   - Grants expire (default 14 days, max 90 days enforced in
--     application). Revocation is operator-driven.
--   - Public access page + gated artifact route NEVER expose
--     internal-only artifact bodies — the artifact builder
--     enforces this independently.
--   - autonomous_sending_still_disabled health flag stays
--     mounted.
--
-- Schema notes:
--   - `token_hash` is UNIQUE so two grants can't accidentally
--     collide and route to the wrong buyer.
--   - `ip_hash` + `user_agent_hash` on access events reuse the
--     Phase 9A salted-SHA-256 fingerprint so the access log is
--     correlatable with the rest of the audit chain without
--     ever storing raw IPs or user-agent strings.
--   - `metadata` carries small structural context only. NEVER
--     raw token values, NEVER buyer-supplied free text beyond
--     short notes.
-- ============================================================================

create table if not exists public.trust_access_grants (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid null references public.venues(id) on delete cascade,

  buyer_name text null,
  buyer_email text null,
  buyer_company text null,

  scope text not null default 'standard_packet',
  status text not null default 'active',

  -- Salted-SHA-256 hash of the bearer token. Raw token is
  -- NEVER stored. Unique to prevent grant collisions.
  token_hash text not null unique,

  expires_at timestamptz not null,

  created_by uuid null references auth.users(id) on delete set null,
  revoked_by uuid null references auth.users(id) on delete set null,
  revoked_at timestamptz null,

  -- Updated by the validate-token path when an access succeeds.
  last_accessed_at timestamptz null,
  access_count integer not null default 0,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint trust_grants_scope_chk check (
    scope in ('summary_only', 'standard_packet', 'full_packet', 'custom')
  ),
  constraint trust_grants_status_chk check (
    status in ('active', 'expired', 'revoked')
  )
);

create index if not exists trust_grants_venue_created_idx
  on public.trust_access_grants(venue_id, created_at desc);
create index if not exists trust_grants_buyer_email_idx
  on public.trust_access_grants(buyer_email);
create index if not exists trust_grants_status_expires_idx
  on public.trust_access_grants(status, expires_at);
create index if not exists trust_grants_token_hash_idx
  on public.trust_access_grants(token_hash);

alter table public.trust_access_grants enable row level security;

-- SELECT: owner / admin can read grants for their venue.
drop policy if exists trust_grants_select_venue on public.trust_access_grants;
create policy trust_grants_select_venue on public.trust_access_grants
  for select
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = trust_access_grants.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin')
    )
  );

-- INSERT: owner / admin via authenticated routes. The
-- service-role server route is the primary write path so it
-- can compute the token hash without RLS interference.
drop policy if exists trust_grants_insert_venue on public.trust_access_grants;
create policy trust_grants_insert_venue on public.trust_access_grants
  for insert
  with check (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = trust_access_grants.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin')
    )
  );

-- UPDATE: owner / admin (used for revoke + metadata edits).
drop policy if exists trust_grants_update_venue on public.trust_access_grants;
create policy trust_grants_update_venue on public.trust_access_grants
  for update
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = trust_access_grants.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin')
    )
  )
  with check (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = trust_access_grants.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin')
    )
  );

create or replace function public.trust_grants_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trust_grants_updated_at on public.trust_access_grants;
create trigger trust_grants_updated_at
  before update on public.trust_access_grants
  for each row execute function public.trust_grants_set_updated_at();


-- ── trust_access_events ───────────────────────────────────────────────────
create table if not exists public.trust_access_events (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid null references public.trust_access_grants(id) on delete cascade,
  venue_id uuid null references public.venues(id) on delete cascade,
  event_type text not null,
  artifact_type text null,
  format text null,
  -- Salted-SHA-256 fingerprints. NEVER raw IP / user-agent.
  ip_hash text null,
  user_agent_hash text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint trust_events_type_chk check (
    event_type in (
      'grant_created', 'grant_revoked', 'grant_accessed',
      'artifact_downloaded', 'grant_expired', 'access_denied'
    )
  )
);

create index if not exists trust_events_grant_created_idx
  on public.trust_access_events(grant_id, created_at desc);
create index if not exists trust_events_venue_created_idx
  on public.trust_access_events(venue_id, created_at desc);
create index if not exists trust_events_type_created_idx
  on public.trust_access_events(event_type, created_at desc);

alter table public.trust_access_events enable row level security;

-- SELECT: owner / admin can read events for their venue.
drop policy if exists trust_events_select_venue on public.trust_access_events;
create policy trust_events_select_venue on public.trust_access_events
  for select
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = trust_access_events.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin')
    )
  );

-- INSERT: service-role only. Public + gated artifact routes
-- write via the service-role server client so they can
-- record access regardless of buyer session state.

-- ── End of Phase 9N migration ────────────────────────────────────────────
