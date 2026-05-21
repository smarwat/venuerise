-- ============================================================================
-- Phase 8AJ — ai_actions rejection markers
--
-- Lets operators reject a generated AI draft (typically surfaced as the
-- LeadDetailDrawer "AI drafted a reply" card) without deleting the row.
-- Soft signal: cron / orchestrator / agent flows continue to write
-- ai_actions normally; the rejection is a forensic + UI marker only.
--
-- Two nullable columns:
--   rejected_at  — timestamptz set when an operator presses Reject
--   rejected_by  — auth.users.id of the operator who pressed it
--
-- Reads stay open to existing RLS; the only write path is the
-- service-role PATCH at /api/ai/actions/[id]/reject (Phase 8AJ).
-- The drawer UI checks `rejected_at IS NOT NULL` (locally — the
-- next fetch surfaces the server truth) to render the rejected state.
-- ============================================================================

alter table public.ai_actions
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by uuid references auth.users(id) on delete set null;

-- Partial index keeps the index small (only rejected rows). Lets a
-- future audit query like "show me every draft rejected this month"
-- skip the sequential scan.
create index if not exists ai_actions_rejected_at_idx
  on public.ai_actions (rejected_at desc)
  where rejected_at is not null;

-- Down (commented):
-- drop index if exists public.ai_actions_rejected_at_idx;
-- alter table public.ai_actions
--   drop column if exists rejected_by,
--   drop column if exists rejected_at;
