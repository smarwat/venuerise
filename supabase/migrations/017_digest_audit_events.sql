-- ============================================================================
-- Phase 8AC — digest_audit_events
--
-- Append-only audit table for operator + cron actions against the digest
-- system. Sister table to:
--   - tour_action_events  (Phase 8L; lead-token tour-action audit)
--   - tour_status_events  (Phase 8M; unified tour status audit)
--
-- Why a dedicated table:
--   Per Phase 8AA-8AB structured-log breadcrumbs were the forensic trail
--   for suppression removals + retention runs. That worked when call
--   volume was low, but operators on the billing page need an in-app
--   "who removed Sara's suppression last Tuesday?" view that doesn't
--   require log shipping or Sentry deep links.
--
-- Writes are service-role only (no RLS insert/update/delete policies).
-- Reads are gated to owner/admin via the existing has_venue_role helper
-- (migration 004), matching the rest of the billing-page surfaces.
-- ============================================================================

create table if not exists public.digest_audit_events (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            uuid not null references public.venues(id) on delete cascade,
  actor_user_id       uuid references auth.users(id) on delete set null,
  -- Mirrors the Phase 8M tour_status_events.actor_kind vocabulary so
  -- log/audit consumers can use the same string-set across both
  -- audit surfaces. `system` is reserved for future one-off scripts
  -- or manual SQL backfills.
  actor_kind          text not null check (actor_kind in ('operator', 'cron', 'system')),
  -- Free-text action code. Initial vocabulary (Phase 8AC):
  --   'suppression_remove'        — single suppression delete succeeded
  --   'suppression_remove_noop'   — single suppression delete idempotent no-op
  --   'suppression_remove_all'    — bulk summary row
  --   'digest_retention_archive'  — retention cron summary row
  -- Future surfaces (manual digest sends, cadence flips, etc.) can
  -- extend without a schema change.
  action              text not null,
  -- Optional target user for actions that target an admin/owner
  -- (suppression removes). NULL for venue-level actions like
  -- retention summaries.
  target_user_id      uuid references auth.users(id) on delete set null,
  -- Always masked. The audit table NEVER stores raw emails — keeps the
  -- Phase 8Y/8AA PII contract intact even when an operator dumps the
  -- table directly via psql.
  target_email_masked text,
  -- Optional free-text operator-supplied reason (capped 240 by the
  -- helper). Useful for "verified with recipient" / "domain
  -- reconfigured" breadcrumbs.
  reason              text,
  -- Action-specific payload. The helper sanitizes shape; consumers
  -- should treat unknown keys as forward-compatible.
  metadata            jsonb not null default '{}'::jsonb,
  occurred_at         timestamptz not null default now()
);

-- Primary access patterns:
--   1. Billing-page card: most recent N events for THIS venue.
--   2. Filter chip: most recent N events for THIS venue + action prefix.
--   3. Forensic: most recent N events by actor_kind across all venues.
create index if not exists digest_audit_events_venue_occurred_idx
  on public.digest_audit_events (venue_id, occurred_at desc);

create index if not exists digest_audit_events_action_occurred_idx
  on public.digest_audit_events (action, occurred_at desc);

create index if not exists digest_audit_events_actor_occurred_idx
  on public.digest_audit_events (actor_kind, occurred_at desc);

-- RLS — read-only for owner/admin members; no insert/update/delete
-- policies (writes flow exclusively through the service-role helper).
alter table public.digest_audit_events enable row level security;

drop policy if exists "digest_audit_events: read for admins"
  on public.digest_audit_events;
create policy "digest_audit_events: read for admins"
  on public.digest_audit_events
  for select
  to authenticated
  using (
    public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin'])
  );

-- Down (commented):
-- drop policy if exists "digest_audit_events: read for admins"
--   on public.digest_audit_events;
-- drop index if exists public.digest_audit_events_actor_occurred_idx;
-- drop index if exists public.digest_audit_events_action_occurred_idx;
-- drop index if exists public.digest_audit_events_venue_occurred_idx;
-- drop table if exists public.digest_audit_events;
