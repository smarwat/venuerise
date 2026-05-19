-- =============================================================================
-- Migration 015 — indexed metadata audit search (Phase 8S)
--
-- Phase 8R's `search_tour_status_events` RPC searched `metadata::text`
-- via an unindexed sequential ILIKE. Works fine at < ~1k rows; gets
-- linear-slower past that. This migration adds the data + index needed
-- for fast substring search.
--
-- ── ROLLOUT ───────────────────────────────────────────────────────────────
--   1. Ensure pg_trgm (idempotent — Supabase usually ships it pre-loaded).
--   2. Add a generated stored column `metadata_text`. Populating it on
--      existing rows happens implicitly during the ALTER (Postgres
--      rewrites the table).
--   3. Create a GIN trigram index on the generated column.
--   4. Replace the Phase 8R RPC body so it queries `metadata_text`
--      instead of the inline cast — keeps the same signature + grants.
--
-- ── INDEX TYPE RATIONALE ──────────────────────────────────────────────────
-- `gin (… gin_trgm_ops)` is the standard fit for `ILIKE '%term%'`
-- substring search on text. A B-tree index doesn't help substring
-- matches; a `to_tsvector` GIN would require operator changes from
-- ILIKE → `@@`. The trigram index keeps the RPC predicate unchanged.
--
-- If `pg_trgm` is somehow unavailable in a target environment, fall
-- back: drop this index, add `using gin (to_tsvector('simple',
-- metadata_text))`, and switch the RPC predicate to
-- `to_tsvector('simple', metadata_text) @@ websearch_to_tsquery(...)`.
-- The trade-off is exact-substring vs token-bounded matches; documented
-- in BILLING-QA §7v.
--
-- ── WRITE AMPLIFICATION ───────────────────────────────────────────────────
-- A generated stored column means every INSERT/UPDATE touching
-- `metadata` re-computes the cast + writes the GIN entry. For the
-- audit-event volume (a handful of rows per venue per day at the high
-- end), the overhead is negligible. The Phase 8M write paths
-- (`recordTourStatusEvent`) are unaffected — they don't reference the
-- new column.
-- =============================================================================

create extension if not exists pg_trgm;

-- The generated column is for operator search ONLY. It carries no
-- additional information beyond the existing `metadata` jsonb — every
-- read path other than `search_tour_status_events` continues to use
-- `metadata` directly. Documented in the comment so a future operator
-- doesn't try to query it from the JSONB-aware code paths.
alter table public.tour_status_events
  add column if not exists metadata_text text
  generated always as (coalesce(metadata::text, '')) stored;

comment on column public.tour_status_events.metadata_text is
  'Phase 8S — operator-search-only mirror of metadata::text. ' ||
  'Powers the trigram GIN index used by search_tour_status_events. ' ||
  'DO NOT read this column directly from application code; use the ' ||
  'RPC or the jsonb `metadata` column instead.';

create index if not exists tour_status_events_metadata_text_trgm_idx
  on public.tour_status_events
  using gin (metadata_text gin_trgm_ops);

-- Re-issue the Phase 8R RPC with the predicate swapped from
-- `metadata::text` to `metadata_text`. Signature, return shape,
-- security posture, and grants are all unchanged.
create or replace function public.search_tour_status_events(
  p_venue_id        uuid,
  p_tour_id         uuid default null,
  p_lead_id         uuid default null,
  p_actor_kind      text default null,
  p_action          text default null,
  p_q               text default null,
  p_occurred_before timestamptz default null,
  p_limit           integer default 50
)
returns table (
  id              uuid,
  venue_id        uuid,
  tour_id         uuid,
  lead_id         uuid,
  actor_kind      text,
  actor_id        text,
  action          text,
  previous_status text,
  new_status      text,
  source_ip       text,
  user_agent      text,
  reason          text,
  metadata        jsonb,
  occurred_at     timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with clamped as (
    select least(greatest(coalesce(p_limit, 50), 1), 200) as effective_limit
  ),
  needle as (
    select case
      when p_q is null then null
      when length(trim(p_q)) = 0 then null
      else '%' || trim(p_q) || '%'
    end as pattern
  )
  select
    e.id, e.venue_id, e.tour_id, e.lead_id, e.actor_kind, e.actor_id, e.action,
    e.previous_status, e.new_status, e.source_ip, e.user_agent, e.reason,
    e.metadata, e.occurred_at
  from public.tour_status_events e, clamped, needle
  where e.venue_id = p_venue_id
    and (p_tour_id is null or e.tour_id = p_tour_id)
    and (p_lead_id is null or e.lead_id = p_lead_id)
    and (p_actor_kind is null or e.actor_kind = p_actor_kind)
    and (p_action is null or e.action = p_action)
    and (p_occurred_before is null or e.occurred_at < p_occurred_before)
    and (
      needle.pattern is null
      or e.actor_id        ilike needle.pattern
      or e.action          ilike needle.pattern
      or e.previous_status ilike needle.pattern
      or e.new_status      ilike needle.pattern
      or e.reason          ilike needle.pattern
      or e.source_ip       ilike needle.pattern
      or e.user_agent      ilike needle.pattern
      -- Phase 8S — swapped from `metadata::text ilike` to
      -- `metadata_text ilike` so the planner can use the trigram GIN
      -- index. Same behavior; just indexed now.
      or e.metadata_text   ilike needle.pattern
    )
  order by e.occurred_at desc
  limit (select effective_limit from clamped);
$$;

-- Re-issue grants — `create or replace function` preserves them in
-- recent Postgres, but defense in depth.
revoke all on function public.search_tour_status_events(
  uuid, uuid, uuid, text, text, text, timestamptz, integer
) from public;
grant execute on function public.search_tour_status_events(
  uuid, uuid, uuid, text, text, text, timestamptz, integer
) to service_role;

-- ----------------------------------------------------------------------------
-- Rollback recipe (manual — for ops reference only).
-- ----------------------------------------------------------------------------
--   drop index if exists public.tour_status_events_metadata_text_trgm_idx;
--   alter table public.tour_status_events drop column if exists metadata_text;
--   -- (re-apply migration 014 to restore the previous RPC body)
-- ----------------------------------------------------------------------------
