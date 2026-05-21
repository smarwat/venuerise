-- ============================================================================
-- Phase 9F — Abuse events table.
--
-- Records every rate-limit BLOCK across the platform so an operator
-- can answer "what's being hammered?" without grepping logs. Best-
-- effort: the `recordAbuseEvent` helper wraps every step in try/catch
-- and NEVER throws, so a failed insert can't deny the request that
-- was already blocked.
--
-- Schema notes:
--   - `venue_id` is NULLABLE — public/widget/CSP-report routes have
--     no venue context. Admin routes always populate it.
--   - `ip_hash` reuses the Phase 9A `maskIpForAudit` salted-SHA-256
--     fingerprint so primary audit + abuse rows are linkable by
--     fingerprint without ever storing raw IPs.
--   - `limiter_key` is the EXACT key the rate limiter saw
--     (prefix + identifier), so an operator can grep abuse rows for
--     a specific user / IP / venue without joining tables.
--   - `metadata` carries small structural context (retry-after,
--     remaining tokens at block time, route variant). NEVER raw
--     payloads, NEVER cookies, NEVER auth headers.
--
-- ── KNOWN LIMITATION ──────────────────────────────────────────────────────
-- Like `audit_events`, this is not WORM. An admin with direct
-- database access can delete rows. RLS only blocks the REST surface.
-- The Phase 9C audit_event_mirror does NOT mirror abuse_events —
-- the data set is denser and primarily operational; tamper-evidence
-- via mirror is reserved for the primary `audit_events` feed.
-- ============================================================================

create table if not exists public.abuse_events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid null references public.venues(id) on delete cascade,
  -- The user that hit the limit, when authenticated. Null for
  -- anonymous/public routes (widget, CSP report, public token
  -- routes that bind to a token not a user).
  user_id uuid null references auth.users(id) on delete set null,
  route text not null,
  method text not null,
  limiter_key text not null,
  -- Salted-SHA-256 fingerprint via lib/enterprise/audit-events.maskIpForAudit.
  -- Same format as audit_events.ip_hash so cross-feed correlation
  -- works without storing raw IPs anywhere.
  ip_hash text null,
  -- Discriminator for WHY the block fired. Today: 'rate_limited'.
  -- Reserved for future expansion (e.g. 'signature_failed',
  -- 'token_invalid') so a single table can carry the full abuse
  -- signal without adding more tables.
  reason text not null default 'rate_limited',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Per-venue scroll: the AbuseMonitorCard scrolls
-- `(venue_id, created_at desc)`. Composite index keeps that path
-- cheap as the table grows.
create index if not exists abuse_events_venue_created_idx
  on public.abuse_events (venue_id, created_at desc);

-- Per-route + per-reason summaries — the card derives top-N by route
-- and by reason for the last 24h.
create index if not exists abuse_events_route_created_idx
  on public.abuse_events (route, created_at desc);
create index if not exists abuse_events_reason_created_idx
  on public.abuse_events (reason, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS — owner/admin SELECT only when venue_id is set. Public-route
-- rows (venue_id IS NULL) are NOT visible via PostgREST; operators
-- investigating widget/CSP abuse must query directly via Supabase SQL
-- editor (acceptable: cross-venue abuse review is an infra-team task,
-- not a tenant-operator task).
--
-- No INSERT / UPDATE / DELETE policies. All writes go through the
-- service-role `recordAbuseEvent` helper.
-- ---------------------------------------------------------------------------

alter table public.abuse_events enable row level security;

drop policy if exists "abuse_events: select for venue admins"
  on public.abuse_events;

create policy "abuse_events: select for venue admins"
  on public.abuse_events
  for select
  using (
    venue_id is not null
    and public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin'])
  );

-- Rollback (commented; do not run unless explicitly requested):
-- drop policy if exists "abuse_events: select for venue admins"
--   on public.abuse_events;
-- drop index if exists public.abuse_events_reason_created_idx;
-- drop index if exists public.abuse_events_route_created_idx;
-- drop index if exists public.abuse_events_venue_created_idx;
-- drop table if exists public.abuse_events;
