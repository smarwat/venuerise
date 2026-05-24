-- Phase 8BT — Extend inbound_email_orphans to also hold SMS orphans.
--
-- Operators don't care whether an unmatched reply is email or
-- SMS; they need one queue for "replies that need review."
-- We extend the existing table instead of forking a parallel
-- inbound_sms_orphans surface so the queue UI, RLS posture,
-- link/dismiss routes, and dedupe index all stay shared.
--
-- The table name stays `inbound_email_orphans` to avoid
-- churning RLS policies + the live queue. Documented in
-- docs/SMS-ORPHAN-QUEUE.md.

-- ────────────────────────────────────────────────────────────────────────
-- New columns
-- ────────────────────────────────────────────────────────────────────────

alter table public.inbound_email_orphans
  add column if not exists channel text not null default 'email';

alter table public.inbound_email_orphans
  add column if not exists from_phone text;

alter table public.inbound_email_orphans
  add column if not exists to_phone text;

-- Channel check constraint. Guarded so re-running the migration
-- on a partial environment doesn't fail.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'inbound_email_orphans_channel_check'
  ) then
    alter table public.inbound_email_orphans
      add constraint inbound_email_orphans_channel_check
      check (channel in ('email', 'sms'));
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────────────────

-- Primary list-by-venue query: shared across channels.
create index if not exists inbound_email_orphans_venue_channel_status_idx
  on public.inbound_email_orphans (venue_id, channel, status, created_at desc);

-- Sender-history lookups by phone (mirrors the existing
-- from_email index from migration 040).
create index if not exists inbound_email_orphans_from_phone_idx
  on public.inbound_email_orphans (from_phone, created_at desc)
  where from_phone is not null;

-- Rollback (commented; do not run unless explicitly requested):
-- drop index if exists public.inbound_email_orphans_from_phone_idx;
-- drop index if exists public.inbound_email_orphans_venue_channel_status_idx;
-- alter table public.inbound_email_orphans drop constraint if exists inbound_email_orphans_channel_check;
-- alter table public.inbound_email_orphans drop column if exists to_phone;
-- alter table public.inbound_email_orphans drop column if exists from_phone;
-- alter table public.inbound_email_orphans drop column if exists channel;
