-- =============================================================================
-- Migration 023 — venues.metadata (Phase 8AQ)
--
-- The Phase 8AP "Revenue OS" thesis introduced per-venue settings that should
-- live alongside the venue row but never feed into the AI prompt context
-- directly. Examples: first-reply SLA, fit-score threshold, cold-lead window.
--
-- The original 001 schema didn't include a metadata column on venues, so we
-- add one here following the same `metadata jsonb not null default '{}'`
-- convention already used on messages / outbound_messages / venue_members /
-- ai_actions (the last added in Phase 8AM migration 021).
--
-- Storage shape (today):
--   venues.metadata.revenue_os = {
--     first_reply_sla_minutes: int,
--     high_fit_threshold:      int,
--     stale_high_fit_hours:    int,
--     cold_lead_days:          int
--   }
--
-- Read/write goes through `lib/revenue-os/settings.ts`, which clamps each
-- value defensively + falls back to DEFAULT_REVENUE_OS_SETTINGS when
-- metadata is missing or malformed. Adding new fields later is additive;
-- existing rows back-fill themselves at read time via the default.
--
-- All operations are idempotent.
-- =============================================================================

alter table public.venues
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- Light GIN index for any future filter on metadata keys. Cheap to
-- maintain on the low-write-volume venues table; speeds up an admin
-- query like "which venues have a custom revenue_os SLA?" without
-- needing a row-level scan.
create index if not exists venues_metadata_gin_idx
  on public.venues
  using gin (metadata jsonb_path_ops);
