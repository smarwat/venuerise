-- =============================================================================
-- Migration 013 — tour_status_events (Phase 8M)
--
-- Unified audit feed for EVERY tour status change, across every write path
-- (lead token, operator dashboard PATCH, admin bulk-cancel, billing
-- auto-pause cron, and any future system/cron paths).
--
-- This sits ALONGSIDE Phase 8L's `tour_action_events`:
--   - `tour_action_events` (012)  → narrow: single-use claim for the public
--                                    /tour/confirm + /tour/cancel handler.
--                                    Owns the `unique (tour_id, token_nonce)`
--                                    constraint that defeats lead-token replay.
--   - `tour_status_events` (013)  → broad: every status transition, regardless
--                                    of who/what caused it. Operator UIs read
--                                    from here for "who changed this tour?".
--
-- Both tables receive a row on lead-token actions for one release cycle so
-- nothing downstream breaks during cutover. The Phase 8L admin endpoint
-- `/api/admin/tours/recent-token-actions` carries a `Deprecation: true` header
-- pointing operators at the unified `/api/admin/tours/status-events`.
-- =============================================================================

create table if not exists public.tour_status_events (
  id              uuid        primary key default gen_random_uuid(),

  venue_id        uuid        not null references public.venues(id) on delete cascade,
  tour_id         uuid        not null references public.tours(id) on delete cascade,
  lead_id         uuid        references public.leads(id) on delete set null,

  -- Discriminated union over the five known actor categories. We allow
  -- 'system' for future paths (manual SQL fix-ups recorded via a script,
  -- etc.) so the audit stays useful even when an unusual event lands.
  actor_kind      text        not null check (
    actor_kind in ('lead_token', 'operator', 'cron', 'system')
  ),
  -- Polymorphic actor reference:
  --   operator  → auth.users.id (uuid as text)
  --   cron      → cron function id e.g. 'billing-tour-auto-pause'
  --   lead_token → null (no first-class actor — token IS the auth)
  --   system    → free-form ('manual-sql-fixup', 'data-migration-013', ...)
  actor_id        text        null,

  -- Semantic name for the change. Examples:
  --   'confirm', 'cancel', 'status_change', 'reschedule',
  --   'bulk_cancel', 'auto_pause_cancel'
  -- Free-form text rather than a CHECK so future write paths can add new
  -- action verbs without a schema migration.
  action          text        not null,

  previous_status text        null,
  new_status      text        not null,

  -- IP comes in already CIDR-masked by the caller (Phase 8L `maskIp`).
  -- The raw IP NEVER reaches the DB. Capped to a reasonable length on
  -- the write side too.
  source_ip       text        null,
  user_agent      text        null,

  -- Operator-supplied free-form context, e.g. bulk-cancel's `reason`
  -- field. Bounded at the handler boundary (240 chars for bulk-cancel),
  -- not at the DB.
  reason          text        null,

  -- Free-form structured context. Keep PII OUT of this — operator UIs
  -- spread it directly into the response, and we don't want a leaked
  -- screenshot to expose email addresses.
  metadata        jsonb       not null default '{}'::jsonb,

  occurred_at     timestamptz not null default now()
);

-- Operator "recent activity" feed — most common read.
create index if not exists tour_status_events_venue_occurred_idx
  on public.tour_status_events (venue_id, occurred_at desc);

-- "What has happened to this specific tour?"
create index if not exists tour_status_events_tour_occurred_idx
  on public.tour_status_events (tour_id, occurred_at desc);

-- "Show me only operator-driven changes" / "only cron cancellations".
create index if not exists tour_status_events_venue_actor_occurred_idx
  on public.tour_status_events (venue_id, actor_kind, occurred_at desc);

-- Monitoring aggregates ("how many bulk_cancels last day?").
create index if not exists tour_status_events_action_occurred_idx
  on public.tour_status_events (action, occurred_at desc);

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------

alter table public.tour_status_events enable row level security;

-- SELECT: admins/owners of the row's venue. Same posture as the
-- billing-events / tour-action-events tables. `has_venue_role` (migration
-- 004) checks venue_members + the legacy owner_user_id fallback.
drop policy if exists "tour_status_events: select for admins"
  on public.tour_status_events;
create policy "tour_status_events: select for admins"
  on public.tour_status_events
  for select
  using ( public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin']) );

-- NO insert/update/delete policies for authenticated callers. Every
-- write goes through the service-role helper `recordTourStatusEvent`,
-- which keeps the audit append-only from the dashboard's perspective.

-- ----------------------------------------------------------------------------
-- Rollback recipe (manual — for ops reference only).
-- ----------------------------------------------------------------------------
--   drop policy if exists "tour_status_events: select for admins"
--     on public.tour_status_events;
--   drop index if exists public.tour_status_events_action_occurred_idx;
--   drop index if exists public.tour_status_events_venue_actor_occurred_idx;
--   drop index if exists public.tour_status_events_tour_occurred_idx;
--   drop index if exists public.tour_status_events_venue_occurred_idx;
--   drop table if exists public.tour_status_events;
