-- ============================================================================
-- VAOS — Phase 3
-- Migration: 002_email_delivery_metadata.sql
--
-- Adds delivery telemetry to follow_up_schedules and widens the status check
-- to distinguish "generated but not sent" from real delivery vs. failure.
--
-- Status meaning after this migration:
--   pending    — not yet processed
--   sent       — generated AND accepted by Resend (has delivery_provider='resend')
--   skipped    — eligibility gate (booked / lost / AI paused / missing email)
--                OR console-fallback dev mode (no real Resend send)
--   failed     — transient or permanent send error; delivery_error populated
--   cancelled  — operator intervention or row is no longer applicable
--
-- This migration is additive and reversible (see down section at bottom).
-- ============================================================================

-- 1. New columns. All nullable so existing rows are unaffected.
alter table public.follow_up_schedules
  add column if not exists delivered_at          timestamptz,
  add column if not exists delivery_provider     text,
  add column if not exists delivery_message_id   text,
  add column if not exists delivery_error        text;

-- 2. Widen the status check.
--    Drop the old single-value constraint and recreate with the new set.
alter table public.follow_up_schedules
  drop constraint if exists follow_up_schedules_status_check;

alter table public.follow_up_schedules
  add constraint follow_up_schedules_status_check
  check (status in ('pending', 'sent', 'failed', 'cancelled', 'skipped'));

-- 3. Soft validation: delivery_provider only makes sense in a small set.
alter table public.follow_up_schedules
  drop constraint if exists follow_up_schedules_delivery_provider_check;

alter table public.follow_up_schedules
  add constraint follow_up_schedules_delivery_provider_check
  check (
    delivery_provider is null
    or delivery_provider in ('resend', 'console')
  );

-- 4. Index for delivery-status queries used by future admin views.
create index if not exists follow_up_schedules_delivery_idx
  on public.follow_up_schedules (status, delivered_at desc);

-- ----------------------------------------------------------------------------
-- DOWN (kept as a comment — apply manually if a rollback is needed):
--
-- alter table public.follow_up_schedules
--   drop constraint if exists follow_up_schedules_delivery_provider_check;
-- alter table public.follow_up_schedules
--   drop constraint if exists follow_up_schedules_status_check;
-- alter table public.follow_up_schedules
--   add constraint follow_up_schedules_status_check
--   check (status in ('pending', 'sent', 'cancelled'));
-- drop index if exists public.follow_up_schedules_delivery_idx;
-- alter table public.follow_up_schedules
--   drop column if exists delivery_error,
--   drop column if exists delivery_message_id,
--   drop column if exists delivery_provider,
--   drop column if exists delivered_at;
-- ----------------------------------------------------------------------------
