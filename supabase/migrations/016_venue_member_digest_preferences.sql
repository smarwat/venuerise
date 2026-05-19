-- =============================================================================
-- Migration 016 — per-user digest preferences on venue_members (Phase 8U)
--
-- Phase 8T stored digest cadence on `subscriptions.metadata.digest_cadence`,
-- which means every admin/owner of a venue shared one setting. Phase 8U
-- promotes this to a per-user preference by adding a metadata jsonb
-- column to `venue_members`. The cron's effective-preference resolver
-- prefers member metadata first, then falls back to subscription
-- metadata, then to the legacy `digest_disabled` flag, then to the
-- default cadence ('daily').
--
-- ── SHAPE ─────────────────────────────────────────────────────────────────
-- A typical member row's metadata will look like:
--
--   {
--     "digest_cadence":   "weekly",         -- 'daily' | 'weekly' | 'off'
--     "digest_weekly_day":"wed",            -- 'sun'..'sat' (only when weekly)
--     "digest_disabled_at":"2026-05-19T08:00:00.000Z"  -- set when cadence=off
--   }
--
-- Application code keys off the strings; the DB doesn't enforce a JSON
-- schema. The Phase 8U `lib/billing/operator-digest-preferences.ts`
-- helpers coerce unknown values to safe defaults so a manually-tampered
-- row can't crash the cron.
--
-- ── INDEX RATIONALE ───────────────────────────────────────────────────────
-- A GIN index over the whole jsonb column is the cheapest insurance:
-- the cron's per-venue loop reads every member row anyway, but a
-- future feature ("show me every member opted-in to weekly") would
-- want either `metadata @> '{"digest_cadence":"weekly"}'` lookups or a
-- generated/expression index. The plain GIN supports the former
-- pattern without committing to a specific query shape.
--
-- ── RLS ───────────────────────────────────────────────────────────────────
-- We don't touch the existing `venue_members` RLS policies. Reads from
-- the admin route + the cron use the service-role client (which bypasses
-- RLS). Writes go through the route's admin gate and the
-- `setMemberDigestPreference` helper, which targets exactly one
-- (venue_id, user_id) row. No SELECT policy change needed.
-- =============================================================================

alter table public.venue_members
  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column public.venue_members.metadata is
  'Phase 8U — per-user preferences scoped to this venue. Keys: ' ||
  'digest_cadence (daily|weekly|off), digest_weekly_day (sun..sat), ' ||
  'digest_disabled_at (iso). Future per-user preferences live here too.';

create index if not exists venue_members_metadata_digest_idx
  on public.venue_members using gin (metadata);

-- ----------------------------------------------------------------------------
-- Rollback recipe (manual — for ops reference only).
-- ----------------------------------------------------------------------------
--   drop index if exists public.venue_members_metadata_digest_idx;
--   alter table public.venue_members drop column if exists metadata;
-- ----------------------------------------------------------------------------
