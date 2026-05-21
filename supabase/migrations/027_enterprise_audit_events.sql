-- ============================================================================
-- Phase 9A — Enterprise audit events.
--
-- One row per sensitive write across the system. The Phase 9A goal is to
-- give an operator (and eventually an auditor) a single place to answer
-- "who did what, when, on which lead/tour/setting, from where" without
-- having to grep raw logs.
--
-- Safety / privacy posture (the recordAuditEvent helper enforces these,
-- but the schema is built defensively too):
--
--   - No raw message bodies. Snapshots are small + allowlisted.
--   - No secrets, tokens, API keys, or webhook payloads.
--   - IP is stored HASHED (never raw) so a future audit-export still
--     provides linkability without leaking client IPs.
--   - Best-effort writes — a failure in `recordAuditEvent` never blocks
--     the originating business action. The route's success / failure
--     posture is unchanged.
--
-- This is NOT SOC 2 by itself. It is the evidence-foundation a future
-- SOC 2 / ISO posture will build on.
-- ============================================================================

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  -- `actor_user_id` is nullable so cron / system writes can land in the
  -- log without a synthetic user row. The `actor_kind` discriminator
  -- ('operator' | 'system' | 'cron' | 'webhook') makes the audit
  -- semantically explicit even when actor_user_id is null.
  actor_user_id uuid null references auth.users(id) on delete set null,
  actor_kind text not null default 'operator',
  route text not null,
  action text not null,
  target_table text null,
  target_id text null,
  request_id text null,
  -- Hashed IP only. The helper computes sha256(ip + secret) before
  -- write; the raw IP never reaches the row.
  ip_hash text null,
  user_agent text null,
  before_snapshot jsonb null,
  after_snapshot jsonb null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Per-venue scroll: the AuditEventsCard scrolls
-- `(venue_id, created_at desc)`. Composite index keeps that path cheap
-- as the table grows.
create index if not exists audit_events_venue_created_idx
  on public.audit_events (venue_id, created_at desc);

-- Per-actor: an admin investigating "what did this operator do in the
-- last week" benefits from a separate index.
create index if not exists audit_events_actor_created_idx
  on public.audit_events (actor_user_id, created_at desc);

-- Per-action: the card's "filter by action" path uses this.
create index if not exists audit_events_action_created_idx
  on public.audit_events (action, created_at desc);

-- Per-target: the card's "what happened to this row" forensic path
-- (e.g. "show me every audit_event where target was lead X").
create index if not exists audit_events_target_idx
  on public.audit_events (target_table, target_id);

-- ---------------------------------------------------------------------------
-- RLS — owner/admin SELECT only. No INSERT/UPDATE/DELETE policies; every
-- write goes through `recordAuditEvent` (service-role).
-- ---------------------------------------------------------------------------

alter table public.audit_events enable row level security;

drop policy if exists "audit_events: select for venue admins"
  on public.audit_events;

create policy "audit_events: select for venue admins"
  on public.audit_events
  for select
  using (
    public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin'])
  );

-- Rollback (commented; do not run unless explicitly requested):
-- drop policy if exists "audit_events: select for venue admins"
--   on public.audit_events;
-- drop index if exists public.audit_events_target_idx;
-- drop index if exists public.audit_events_action_created_idx;
-- drop index if exists public.audit_events_actor_created_idx;
-- drop index if exists public.audit_events_venue_created_idx;
-- drop table if exists public.audit_events;
