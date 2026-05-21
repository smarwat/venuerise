-- ============================================================================
-- Phase 8BD — leads.metadata for the lost-reason taxonomy + reactivation queue.
--
-- Adds an opaque `metadata` jsonb column to `public.leads` so the
-- LeadDetailDrawer can stamp an operator-supplied lost reason when a
-- lead is moved to `stage='lost'`, and the reactivation helper can read
-- that reason without a separate join.
--
-- Operator-supplied only. No autonomous classification writes here.
-- The shape under `metadata.lost_reason`:
--
--   {
--     "reason":      "priced_out" | "date_unavailable" |
--                    "picked_competitor" | "ghosted" |
--                    "not_a_fit" | "other",
--     "note":        "optional free text",
--     "recorded_at": "ISO timestamp",
--     "recorded_by": "auth.users.id"
--   }
--
-- The PATCH route at /api/leads/[id] is the only path that's allowed to
-- write here; it accepts ONLY the allowlisted `metadata.lost_reason`
-- shape and merges into the existing jsonb so unrelated keys (added by
-- a future phase) are never clobbered.
--
-- A GIN index on `jsonb_path_ops` lets a future surface filter by
-- `metadata @> '{"lost_reason":{"reason":"ghosted"}}'` cheaply if it
-- needs to. The reactivation queue today reads every lost lead and
-- filters in memory; the index is forward-compatible.
-- ============================================================================

alter table public.leads
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists leads_metadata_gin_idx
  on public.leads using gin (metadata jsonb_path_ops);

-- Rollback (commented; do not run unless explicitly requested):
-- drop index if exists public.leads_metadata_gin_idx;
-- alter table public.leads drop column if exists metadata;
