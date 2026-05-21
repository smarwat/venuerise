-- ============================================================================
-- Phase 9G — Enterprise SSO readiness scaffolding.
--
-- Two tables that let the platform start tracking SSO connections +
-- login attempts WITHOUT committing to a specific SAML/OIDC vendor.
-- The plumbing is real; the provider exchange is a placeholder.
--
-- Design posture:
--   - Connections default to `status='draft'` so adding a row never
--     opens an auth path; an owner must explicitly flip to 'active'.
--   - `default_role` is constrained to the LOWEST-privilege set
--     ('viewer', 'coordinator'). A future JIT-provisioned user
--     gets that role; promotion to admin/owner is an explicit
--     `/api/team/members/[userId]` PATCH (Phase 9B audited).
--   - `sso_login_events` has no UNIQUE — every attempt writes a
--     row. The endpoint rate-limit is the abuse defense; the
--     audit feed is operator-visible via SsoLoginEventsCard.
--
-- ── KNOWN LIMITATIONS ────────────────────────────────────────────────────
-- This migration adds the schema but no row inserter (other than
-- the audit helper). No real SAML/OIDC exchange ships in 9G.
-- ============================================================================

-- ── sso_connections ──────────────────────────────────────────────────────

create table if not exists public.sso_connections (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  -- Vendor identifier. Reserved values match the Phase 9G adapter
  -- registry; future vendors append to the list.
  provider text not null
    check (provider in ('workos','clerk','stytch','supabase_sso','custom_oidc')),
  -- Protocol family — `saml` or `oidc`. Some adapters support both
  -- but a connection is bound to one.
  protocol text not null
    check (protocol in ('saml','oidc')),
  -- Lowercased email domain (e.g. `acme.com`). Domain match is
  -- the primary lookup path for `/api/auth/sso/initiate`. Storage
  -- is lowercase by convention; the route also normalizes on read.
  domain text not null,
  -- Lifecycle. `draft` = visible to operator, no auth path open.
  -- `pending` = vendor handshake in progress. `active` = honored
  -- by initiate. `disabled` = retained for audit; no auth path.
  status text not null default 'draft'
    check (status in ('draft','pending','active','disabled')),
  -- Default role for JIT-provisioned users. Constrained to the
  -- lowest-privilege subset so an SSO-provisioned user can never
  -- land as owner/admin/sales_manager without explicit promotion.
  default_role text not null default 'viewer'
    check (default_role in ('viewer','coordinator')),
  jit_provisioning_enabled boolean not null default false,
  scim_enabled boolean not null default false,
  -- Free-form vendor-specific config. NEVER store raw signing
  -- certs / client secrets here — those belong in env or the
  -- vendor's own dashboard.
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One domain per venue. Operators can't accidentally configure two
-- connections for the same email domain; the lookup is unambiguous.
create unique index if not exists sso_connections_venue_domain_idx
  on public.sso_connections (venue_id, domain);

-- Hot path: list connections for a venue + filter by status.
create index if not exists sso_connections_venue_status_idx
  on public.sso_connections (venue_id, status);

-- Reverse lookup: which venues have a given domain? (Future
-- "domain claim" enforcement could surface here.)
create index if not exists sso_connections_domain_idx
  on public.sso_connections (domain);

-- Vendor + protocol filter for the cross-venue admin dashboard a
-- future phase may add.
create index if not exists sso_connections_provider_protocol_idx
  on public.sso_connections (provider, protocol);

-- updated_at trigger — reuse existing update_updated_at helper
-- (defined in migration 001).
drop trigger if exists sso_connections_updated_at on public.sso_connections;
create trigger sso_connections_updated_at
  before update on public.sso_connections
  for each row execute function update_updated_at();

-- ── RLS — owner/admin SELECT; owner-only INSERT/UPDATE/DELETE ────────────
-- The "owner only" constraint on mutations is deliberate: SSO
-- configuration is a billing-level concern (it determines who can
-- log in at all). Admin role is too permissive for this surface;
-- only the venue owner should configure it.

alter table public.sso_connections enable row level security;

drop policy if exists "sso_connections: select for venue admins"
  on public.sso_connections;
create policy "sso_connections: select for venue admins"
  on public.sso_connections
  for select
  using (
    public.has_venue_role(venue_id, auth.uid(), array['owner','admin'])
  );

drop policy if exists "sso_connections: insert for venue owner"
  on public.sso_connections;
create policy "sso_connections: insert for venue owner"
  on public.sso_connections
  for insert
  with check (
    public.has_venue_role(venue_id, auth.uid(), array['owner'])
  );

drop policy if exists "sso_connections: update for venue owner"
  on public.sso_connections;
create policy "sso_connections: update for venue owner"
  on public.sso_connections
  for update
  using (
    public.has_venue_role(venue_id, auth.uid(), array['owner'])
  )
  with check (
    public.has_venue_role(venue_id, auth.uid(), array['owner'])
  );

drop policy if exists "sso_connections: delete for venue owner"
  on public.sso_connections;
create policy "sso_connections: delete for venue owner"
  on public.sso_connections
  for delete
  using (
    public.has_venue_role(venue_id, auth.uid(), array['owner'])
  );

-- ── sso_login_events ─────────────────────────────────────────────────────

create table if not exists public.sso_login_events (
  id uuid primary key default gen_random_uuid(),
  -- All fk columns are nullable: an initiate attempt against a
  -- domain with NO connection still records an event (`outcome =
  -- 'blocked'`, `reason = 'domain_not_configured'`); a callback
  -- failure before user resolution has no user_id; a totally
  -- malformed payload may have no connection_id either.
  venue_id uuid references public.venues(id) on delete set null,
  connection_id uuid references public.sso_connections(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  email text,
  domain text,
  provider text,
  protocol text,
  outcome text not null
    check (outcome in ('initiated','success','failed','blocked')),
  -- Discriminator for why an outcome landed. Operator-facing
  -- string; no PII required. Examples documented inline below.
  reason text,
  -- Salted-SHA-256 fingerprint via maskIpForAudit (Phase 9A). Raw
  -- IPs never reach this column. Same shape as `audit_events.ip_hash`
  -- and `abuse_events.ip_hash` so cross-feed correlation works.
  ip_hash text,
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Hot path: SsoLoginEventsCard scrolls (venue_id, created_at desc).
create index if not exists sso_login_events_venue_created_idx
  on public.sso_login_events (venue_id, created_at desc);

-- Per-connection forensics — "what happened on this connection?"
create index if not exists sso_login_events_connection_created_idx
  on public.sso_login_events (connection_id, created_at desc);

-- Per-domain debugging — operator types a domain and we filter.
create index if not exists sso_login_events_domain_created_idx
  on public.sso_login_events (domain, created_at desc);

-- Outcome roll-ups for the card's "top outcomes" chip.
create index if not exists sso_login_events_outcome_created_idx
  on public.sso_login_events (outcome, created_at desc);

-- ── RLS — owner/admin SELECT; NO client write policies ───────────────────
-- Service-role writes only. The `recordSsoLoginEvent` helper goes
-- through service-role; the REST surface cannot mutate this table.

alter table public.sso_login_events enable row level security;

drop policy if exists "sso_login_events: select for venue admins"
  on public.sso_login_events;
create policy "sso_login_events: select for venue admins"
  on public.sso_login_events
  for select
  using (
    venue_id is not null
    and public.has_venue_role(venue_id, auth.uid(), array['owner','admin'])
  );

-- Rollback (commented; do not run unless explicitly requested):
-- drop policy if exists "sso_login_events: select for venue admins" on public.sso_login_events;
-- drop index if exists public.sso_login_events_outcome_created_idx;
-- drop index if exists public.sso_login_events_domain_created_idx;
-- drop index if exists public.sso_login_events_connection_created_idx;
-- drop index if exists public.sso_login_events_venue_created_idx;
-- drop table if exists public.sso_login_events;
-- drop policy if exists "sso_connections: delete for venue owner" on public.sso_connections;
-- drop policy if exists "sso_connections: update for venue owner" on public.sso_connections;
-- drop policy if exists "sso_connections: insert for venue owner" on public.sso_connections;
-- drop policy if exists "sso_connections: select for venue admins" on public.sso_connections;
-- drop trigger if exists sso_connections_updated_at on public.sso_connections;
-- drop index if exists public.sso_connections_provider_protocol_idx;
-- drop index if exists public.sso_connections_domain_idx;
-- drop index if exists public.sso_connections_venue_status_idx;
-- drop index if exists public.sso_connections_venue_domain_idx;
-- drop table if exists public.sso_connections;
