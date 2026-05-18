-- ============================================================================
-- VAOS — Phase 4B
-- Migration: 003_outbound_and_suppression.sql
--
-- Adds two outbound-email tables:
--   1. email_suppressions — global, system-owned list of addresses that must
--      NEVER receive another send (hard bounces, complaints, manual blocks,
--      unsubscribes).
--   2. outbound_messages  — per-tenant log of every message we attempted to
--      send. Status is driven by both our local send code (queued / failed /
--      suppressed at send time) and the Resend webhook (delivered / bounced /
--      complained later).
--
-- Both are additive. Existing tables and policies are untouched.
-- ============================================================================

-- 0. Required extensions.
create extension if not exists citext;
-- pgcrypto already enabled in 001 for gen_random_uuid()

-- ============================================================================
-- 1. email_suppressions — global suppression list
-- ============================================================================

create table if not exists public.email_suppressions (
  id          uuid primary key default gen_random_uuid(),
  email       citext unique not null,
  reason      text   not null check (reason in ('bounce_hard', 'complaint', 'manual', 'unsubscribe')),
  source      text,
  created_at  timestamptz not null default now()
);

create index if not exists email_suppressions_email_idx
  on public.email_suppressions (email);

-- RLS: read-only for authenticated users (dashboard may want to display the
-- list later); only the service role can insert/update/delete. This is a
-- SYSTEM list — never tenant-scoped — so any logged-in operator can see
-- whether an address has been suppressed.
alter table public.email_suppressions enable row level security;

drop policy if exists "email_suppressions: read for authenticated"
  on public.email_suppressions;
create policy "email_suppressions: read for authenticated"
  on public.email_suppressions
  for select
  to authenticated
  using (true);

-- Writes intentionally NOT exposed to authenticated. Service-role only.

-- ============================================================================
-- 2. outbound_messages — per-tenant attempted-send log
-- ============================================================================

create table if not exists public.outbound_messages (
  id                    uuid primary key default gen_random_uuid(),
  venue_id              uuid not null references public.venues(id) on delete cascade,
  lead_id               uuid references public.leads(id) on delete set null,
  channel               text not null default 'email' check (channel in ('email', 'sms')),
  to_address            text not null,
  subject               text,
  body                  text,
  provider              text,
  provider_message_id   text unique,
  status                text not null default 'queued'
    check (status in ('queued', 'delivered', 'bounced', 'complained', 'failed', 'suppressed')),
  delivered_at          timestamptz,
  error                 text,
  related_table         text,
  related_id            uuid,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

create index if not exists outbound_messages_venue_created_idx
  on public.outbound_messages (venue_id, created_at desc);

create index if not exists outbound_messages_provider_message_id_idx
  on public.outbound_messages (provider_message_id);

create index if not exists outbound_messages_status_idx
  on public.outbound_messages (status, created_at desc);

-- RLS: scoped through venues.owner_user_id (no venue_members table exists yet
-- per Phase 4B inspection; switch to a join through venue_members when that
-- table arrives).
alter table public.outbound_messages enable row level security;

drop policy if exists "outbound_messages: venue owner access"
  on public.outbound_messages;
create policy "outbound_messages: venue owner access"
  on public.outbound_messages
  for all
  to authenticated
  using (
    exists (
      select 1 from public.venues v
      where v.id = outbound_messages.venue_id
        and v.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.venues v
      where v.id = outbound_messages.venue_id
        and v.owner_user_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- DOWN (kept as a comment; apply manually if a rollback is needed):
--
-- drop table if exists public.outbound_messages;
-- drop table if exists public.email_suppressions;
-- -- citext extension intentionally NOT dropped (other tables may depend on it).
-- ----------------------------------------------------------------------------
