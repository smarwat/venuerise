-- =============================================================================
-- Migration 012 — tour_action_events (Phase 8L)
--
-- Append-only audit + single-use enforcement for the Phase 8K public
-- tour action surface (`/tour/confirm` + `/tour/cancel`). Before this
-- migration, tokens were stateless HMAC — replay-able within the 7-day
-- TTL until the tour transitioned out of an eligible status. After this
-- migration, every redeemed token writes exactly one row here, and the
-- `unique (tour_id, token_nonce)` constraint atomically defeats replay.
--
-- WRITE PATH: service-role only, from the Phase 8K route handler.
--   INSERT … ON CONFLICT DO NOTHING is the single-use claim. Conflict =
--   token already redeemed → handler short-circuits to "already handled"
--   without touching the tour status a second time.
--
-- READ PATH:
--   - Admins/owners of the row's venue can SELECT via RLS.
--   - The Phase 8L rewrite of /api/admin/tours/recent-token-actions
--     joins this table to `leads` for the operator UI.
--
-- PII POSTURE:
--   - `source_ip` stored already CIDR-masked by the handler
--     (192.168.1.42 → 192.168.1.0; first-4-hextets for v6). The DB never
--     sees the raw IP.
--   - `user_agent` capped at 500 chars at the handler boundary.
--   - `token_nonce` is the random hex from the signed token payload; not
--     PII, but never returned by the admin endpoint either (kept here
--     only for the unique-constraint claim).
-- =============================================================================

-- We rely on `gen_random_uuid()` from the pgcrypto extension already
-- enabled by migration 001.
create table if not exists public.tour_action_events (
  id            uuid        primary key default gen_random_uuid(),
  venue_id      uuid        not null references public.venues(id) on delete cascade,
  tour_id       uuid        not null references public.tours(id) on delete cascade,
  lead_id       uuid        references public.leads(id) on delete set null,
  token_nonce   text        not null,
  action        text        not null check (action in ('confirm', 'cancel')),
  source_ip     text,
  user_agent    text,
  occurred_at   timestamptz not null default now(),
  -- Single-use claim. Same nonce will never insert twice for the same tour.
  unique (tour_id, token_nonce)
);

-- Operator queries: "recent token activity for this venue".
create index if not exists tour_action_events_venue_occurred_idx
  on public.tour_action_events (venue_id, occurred_at desc);

-- Triage: "what's happened to this specific tour?"
create index if not exists tour_action_events_tour_occurred_idx
  on public.tour_action_events (tour_id, occurred_at desc);

-- Aggregate / monitoring: "how many confirms in the last day?"
create index if not exists tour_action_events_action_occurred_idx
  on public.tour_action_events (action, occurred_at desc);

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------

alter table public.tour_action_events enable row level security;

-- SELECT: admins/owners of the venue can read their own rows.
-- has_venue_role() is the membership-aware helper from migration 004;
-- it checks venue_members first and falls back to legacy
-- venues.owner_user_id for pre-migration-004 venues.
drop policy if exists "tour_action_events: select for admins"
  on public.tour_action_events;
create policy "tour_action_events: select for admins"
  on public.tour_action_events
  for select
  using ( public.has_venue_role(venue_id, auth.uid(), array['owner', 'admin']) );

-- NO insert / update / delete policies for authenticated callers.
-- All writes come from the Phase 8K route handler using the service-role
-- client (which bypasses RLS by design). This keeps the audit append-only
-- from the dashboard's perspective — no operator can fabricate or erase
-- a row through the UI.

-- ----------------------------------------------------------------------------
-- Rollback recipe (manual — for ops reference only).
-- ----------------------------------------------------------------------------
--   drop policy if exists "tour_action_events: select for admins"
--     on public.tour_action_events;
--   drop index if exists public.tour_action_events_action_occurred_idx;
--   drop index if exists public.tour_action_events_tour_occurred_idx;
--   drop index if exists public.tour_action_events_venue_occurred_idx;
--   drop table if exists public.tour_action_events;
