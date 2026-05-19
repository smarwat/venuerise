-- =============================================================================
-- Migration 014 — search_tour_status_events RPC (Phase 8R)
--
-- Phase 8Q's `?q=` server-side search on /api/admin/tours/status-events is
-- limited to scalar columns because PostgREST's chainable `.or()` builder
-- can't cleanly express `metadata::text ILIKE`. This RPC closes that gap:
-- one SECURITY DEFINER function that accepts the same filter set as the
-- route AND searches `metadata::text` for the `q` term.
--
-- The route invokes this RPC ONLY when `q` is present. The non-`q` path
-- continues to use the existing PostgREST select chain (which has better
-- index hints + simpler typing).
--
-- ── SECURITY POSTURE ──────────────────────────────────────────────────────
-- - SECURITY DEFINER so it runs with the function-owner's privileges. The
--   function body explicitly applies `p_venue_id` as a WHERE clause so it
--   can't return cross-tenant rows even if the calling client somehow
--   bypassed the route's tenant check (defense in depth — the route's
--   `requireAdmin()` + cross-venue `requireVenueRole(ADMIN_ROLES)` are the
--   primary access boundary).
-- - `search_path = public` pinned to prevent search-path injection.
-- - REVOKE ALL FROM PUBLIC so no schema-cataloged role gets execute by
--   default; only `service_role` is granted. `authenticated` and `anon`
--   never get execute, so a leaked anon key can't enumerate the audit log.
-- - The `p_q` value is passed straight into `metadata::text ILIKE
--   '%' || p_q || '%'`. SQL injection is impossible because Postgres
--   parameterizes the bind; the `%` wildcards are added inside the
--   expression, NOT concatenated into a query string.
-- =============================================================================

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
  -- Clamp the limit defensively. The route already enforces 1..200 via
  -- Zod, but a future caller (operator SQL console, ad-hoc script) might
  -- not. Hard ceiling = 200, matching the public endpoint contract.
  with clamped as (
    select least(greatest(coalesce(p_limit, 50), 1), 200) as effective_limit
  ),
  -- Normalize the search term ONCE so the predicate is short.
  needle as (
    select case
      when p_q is null then null
      when length(trim(p_q)) = 0 then null
      else '%' || trim(p_q) || '%'
    end as pattern
  )
  select
    e.id,
    e.venue_id,
    e.tour_id,
    e.lead_id,
    e.actor_kind,
    e.actor_id,
    e.action,
    e.previous_status,
    e.new_status,
    e.source_ip,
    e.user_agent,
    e.reason,
    e.metadata,
    e.occurred_at
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
      or e.metadata::text  ilike needle.pattern
    )
  order by e.occurred_at desc
  limit (select effective_limit from clamped);
$$;

-- Lock down execute privileges.
revoke all on function public.search_tour_status_events(
  uuid, uuid, uuid, text, text, text, timestamptz, integer
) from public;

-- Service role is the ONLY grantable role. Authenticated/anon users
-- never get execute — the audit feed remains route-mediated, with the
-- route enforcing requireAdmin() + tenant binding before invoking
-- this function via the service-role client.
grant execute on function public.search_tour_status_events(
  uuid, uuid, uuid, text, text, text, timestamptz, integer
) to service_role;

-- ----------------------------------------------------------------------------
-- Rollback (manual — for ops reference only):
--   revoke all on function public.search_tour_status_events(
--     uuid, uuid, uuid, text, text, text, timestamptz, integer
--   ) from service_role;
--   drop function if exists public.search_tour_status_events(
--     uuid, uuid, uuid, text, text, text, timestamptz, integer
--   );
-- ----------------------------------------------------------------------------
