-- ============================================================================
-- VAOS — Phase 7J
-- Migration: 009_billing_event_replay_audit.sql
--
-- Tracks "who replayed this Stripe event, when, and how many times" on
-- top of the Phase 7F audit log.
--
-- Pre-Phase-7J rows get NULL/0 defaults — no backfill required.
--
-- Index notes:
--   - Partial indexes (`WHERE …_at IS NOT NULL`) keep the index tiny since
--     most rows never get replayed. Postgres uses them when the query
--     also filters on the same condition (e.g. "list recently replayed").
-- ============================================================================

alter table public.billing_events_log
  add column if not exists replayed_at  timestamptz,
  add column if not exists replayed_by  uuid references auth.users(id) on delete set null,
  add column if not exists replay_count integer not null default 0;

create index if not exists billing_events_log_replayed_at_idx
  on public.billing_events_log (replayed_at desc)
  where replayed_at is not null;

create index if not exists billing_events_log_replayed_by_idx
  on public.billing_events_log (replayed_by)
  where replayed_by is not null;

-- ----------------------------------------------------------------------------
-- record_billing_event_replay(p_event_id, p_user_id)
--
-- Atomic increment + audit-stamp in a single round-trip from the replay
-- route. Returns the NEW replay_count so the route can surface it without
-- a second SELECT.
--
-- SECURITY DEFINER so it runs with table-write privileges regardless of
-- which role the caller is using. Hardened with:
--   - explicit `search_path = public` (defends against search-path attacks
--     on schema-qualified DDL — a Postgres SECDEF best practice)
--   - REVOKE from PUBLIC + GRANT only to service_role; user-scoped clients
--     can't call this directly, only `/api/admin/billing-events/[id]/replay`
--     (which uses the service-role client) can.
-- ----------------------------------------------------------------------------

create or replace function public.record_billing_event_replay(
  p_event_id uuid,
  p_user_id  uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.billing_events_log
     set replayed_at  = now(),
         replayed_by  = p_user_id,
         replay_count = replay_count + 1
   where id = p_event_id
   returning replay_count into v_count;
  return v_count;
end;
$$;

revoke all on function public.record_billing_event_replay(uuid, uuid) from public;
grant execute on function public.record_billing_event_replay(uuid, uuid) to service_role;

-- ============================================================================
-- DOWN (manual rollback only):
--
-- revoke execute on function public.record_billing_event_replay(uuid, uuid) from service_role;
-- drop function if exists public.record_billing_event_replay(uuid, uuid);
-- drop index if exists public.billing_events_log_replayed_by_idx;
-- drop index if exists public.billing_events_log_replayed_at_idx;
-- alter table public.billing_events_log drop column if exists replay_count;
-- alter table public.billing_events_log drop column if exists replayed_by;
-- alter table public.billing_events_log drop column if exists replayed_at;
-- ============================================================================
