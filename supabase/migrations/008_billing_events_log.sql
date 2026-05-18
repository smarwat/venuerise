-- ============================================================================
-- VAOS — Phase 7F
-- Migration: 008_billing_events_log.sql
--
-- Durable audit trail for every Stripe webhook event we receive. Lets us
-- answer:
--   - What did Stripe send us, and when?
--   - Was the event handled (dispatched to the subscription sync)?
--   - Did Stripe redeliver the same event (e.g. on a 5xx retry)?
--   - For a customer-reported billing issue, what events did we get on
--     their venue's timeline?
--
-- Source of truth is still Stripe. This table is a forensic cache —
-- replay the event from the Stripe dashboard if our handler missed it.
-- ============================================================================

create table if not exists public.billing_events_log (
  id                      uuid primary key default gen_random_uuid(),
  stripe_event_id         text not null unique,
  event_type              text not null,
  venue_id                uuid references public.venues(id) on delete set null,
  stripe_customer_id      text,
  stripe_subscription_id  text,
  handled                 boolean not null default false,
  handled_at              timestamptz,
  handler_error           text,
  duplicate_count         integer not null default 0,
  payload                 jsonb not null default '{}'::jsonb,
  received_at             timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Indexes — tuned for the three common read patterns:
--   1. "events for a venue, newest first"     → (venue_id, received_at desc)
--   2. "all events of a type, newest first"   → (event_type, received_at desc)
--   3. "what failed?"                         → (handled, received_at desc)
--   4. "events for a Stripe customer"         → (stripe_customer_id)
-- ----------------------------------------------------------------------------

create index if not exists billing_events_log_venue_id_idx
  on public.billing_events_log (venue_id, received_at desc);

create index if not exists billing_events_log_event_type_idx
  on public.billing_events_log (event_type, received_at desc);

create index if not exists billing_events_log_handled_idx
  on public.billing_events_log (handled, received_at desc);

create index if not exists billing_events_log_customer_idx
  on public.billing_events_log (stripe_customer_id);

-- ----------------------------------------------------------------------------
-- Row Level Security
--
-- Reads: owner/admin of the row's venue. Rows with NULL venue_id (we
--        couldn't resolve the venue when the event landed) are intentionally
--        invisible to authenticated users — operators inspect them via the
--        service-role admin surface.
-- Writes: service role only (no policy for authenticated → effectively
--         no INSERT/UPDATE/DELETE for users).
-- ----------------------------------------------------------------------------

alter table public.billing_events_log enable row level security;

drop policy if exists "billing_events_log: select for admin roles" on public.billing_events_log;
create policy "billing_events_log: select for admin roles"
  on public.billing_events_log
  for select
  to authenticated
  using (
    venue_id is not null
    and public.has_venue_role(venue_id, auth.uid(), array['owner','admin'])
  );

-- ============================================================================
-- DOWN (manual rollback only):
--
-- drop policy if exists "billing_events_log: select for admin roles" on public.billing_events_log;
-- drop index if exists public.billing_events_log_customer_idx;
-- drop index if exists public.billing_events_log_handled_idx;
-- drop index if exists public.billing_events_log_event_type_idx;
-- drop index if exists public.billing_events_log_venue_id_idx;
-- drop table if exists public.billing_events_log;
-- ============================================================================
