-- =============================================================================
-- Migration 022 — search_messages_for_dashboard RPC (Phase 8AN)
--
-- Phase 8AM added a pg_trgm GIN index on `messages.content` + a vanilla
-- ILIKE query in /api/dashboard/search. That returned matches ordered by
-- `created_at DESC`, which surfaced "newest first" rather than "most
-- relevant first" — a query like "photographer" on a venue with hundreds
-- of conversations would burn the 5-slot result cap on the latest
-- mentions even when older, more on-point matches existed.
--
-- This RPC closes the gap by ranking on pg_trgm similarity AND falling
-- back to ILIKE so a short non-trigram term (e.g. "ok") still surfaces.
-- The route invokes this RPC only for the messages sub-query; leads /
-- conversations / tours stay on their existing PostgREST chains.
--
-- ── SECURITY POSTURE ──────────────────────────────────────────────────────
-- - SECURITY DEFINER + `set search_path = public` (same pattern as
--   `search_tour_status_events` from migration 014).
-- - Hard WHERE clause on `m.venue_id = p_venue_id` so a leaked anon key
--   can't enumerate cross-tenant messages even if the route gate were
--   bypassed (defense in depth — `/api/dashboard/search` already does
--   `getCurrentVenueForUser` + SALES_ROLES).
-- - `REVOKE ALL FROM PUBLIC`; only `service_role` granted execute.
--   `authenticated` and `anon` never get execute, so the function is
--   route-mediated by design.
-- - `p_q` is bind-parameterized; the `%` wildcards are added inside the
--   expression (not concatenated into a query string) so SQL injection
--   is impossible.
-- - The lead relation is joined via `inner join` so a message with a
--   null lead reference (shouldn't happen, but defensive) is filtered
--   out — the search surface only returns rows with a known
--   lead_name/lead_email for the CommandPalette result row.
-- =============================================================================

create or replace function public.search_messages_for_dashboard(
  p_venue_id uuid,
  p_q        text,
  p_limit    integer default 5
)
returns table (
  id              uuid,
  conversation_id uuid,
  lead_id         uuid,
  lead_name       text,
  lead_email      text,
  role            text,
  content         text,
  created_at      timestamptz,
  similarity      real
)
language sql
stable
security definer
set search_path = public
as $$
  -- Clamp the limit defensively. The route asks for 5 but we hard-cap
  -- at 20 so a future caller (operator console, script) can't whale
  -- on the trigram index.
  with clamped as (
    select least(greatest(coalesce(p_limit, 5), 1), 20) as effective_limit
  ),
  -- Normalize the search term once so the predicates stay readable.
  -- Empty / whitespace-only `p_q` returns zero rows (the route already
  -- short-circuits sub-2-char terms, but defensively belt-and-suspenders).
  needle as (
    select case
      when p_q is null then null
      when length(trim(p_q)) = 0 then null
      else trim(p_q)
    end as q
  )
  select
    m.id,
    m.conversation_id,
    m.lead_id,
    l.name        as lead_name,
    l.email       as lead_email,
    m.role::text  as role,
    m.content,
    m.created_at,
    -- Similarity is computed against the trimmed term. For very short
    -- terms (< 3 chars) pg_trgm scores poorly and the ILIKE fallback
    -- in the WHERE keeps the row alive; we surface 0.0 in that case
    -- so the ORDER BY still degrades gracefully to recency.
    coalesce(similarity(m.content, (select q from needle)), 0)::real as similarity
  from public.messages m
    inner join public.leads l on l.id = m.lead_id
    , clamped, needle
  where needle.q is not null
    and m.venue_id = p_venue_id
    and (
      m.content % needle.q
      or m.content ilike '%' || needle.q || '%'
    )
  order by
    similarity desc,
    m.created_at desc
  limit (select effective_limit from clamped);
$$;

-- Lock down execute privileges.
revoke all on function public.search_messages_for_dashboard(
  uuid, text, integer
) from public;

-- Service role is the only grantable role — keeps the function route-
-- mediated. The route uses the service client to call this AFTER
-- enforcing auth + SALES_ROLES + venue resolution.
grant execute on function public.search_messages_for_dashboard(
  uuid, text, integer
) to service_role;

-- ----------------------------------------------------------------------------
-- Rollback (manual — for ops reference only):
--   revoke all on function public.search_messages_for_dashboard(
--     uuid, text, integer
--   ) from service_role;
--   drop function if exists public.search_messages_for_dashboard(
--     uuid, text, integer
--   );
-- ----------------------------------------------------------------------------
