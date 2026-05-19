-- ============================================================================
-- Phase 8AE — digest_audit_events metadata trigram search
--
-- Mirrors the Phase 8S migration 015 pattern on `tour_status_events`:
-- a generated stored column carrying the jsonb-as-text projection,
-- plus a GIN trigram index so `metadata_text ILIKE '%term%'` is
-- planner-eligible.
--
-- The Phase 8AD `?q=` search on /api/admin/digest/audit-events was
-- limited to scalar columns (action / reason / target_email_masked)
-- because no index existed for metadata search. Phase 8AE enables a
-- "3+ chars ⇒ metadata included" mode: short terms stay scalar-only
-- (trigram indexes need ≥ 3 chars to win), longer terms widen to
-- include `metadata_text` as well.
--
-- No RLS changes — the Phase 8AC SELECT policy already covers every
-- column on the table.
-- ============================================================================

create extension if not exists pg_trgm;

alter table public.digest_audit_events
add column if not exists metadata_text text
generated always as (coalesce(metadata::text, '')) stored;

create index if not exists digest_audit_events_metadata_text_trgm_idx
on public.digest_audit_events
using gin (metadata_text gin_trgm_ops);

-- Down (commented):
-- drop index if exists public.digest_audit_events_metadata_text_trgm_idx;
-- alter table public.digest_audit_events
--   drop column if exists metadata_text;
-- -- pg_trgm extension is shared (migration 015 on tour_status_events also
-- -- uses it); do NOT drop the extension in this rollback.
