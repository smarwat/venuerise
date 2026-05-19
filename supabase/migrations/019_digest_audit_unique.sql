-- ============================================================================
-- Phase 8AF — digest_audit_events cron-send daily uniqueness
--
-- Prevents accidental duplicate `digest_send_cron` rows for the same
-- venue + recipient + UTC date. Two routes can produce duplicates in
-- principle:
--   1. A retry of the operator-activity-digest cron after a partial
--      failure (Inngest's `retries: 1` config).
--   2. A future bug-fix landing without a coordinated audit clear.
--
-- Unique partial index on `action = 'digest_send_cron'` is the
-- cheapest defense; the cron's send branch already short-circuits on
-- per-recipient idempotency via outbound_messages (Phase 8W
-- send_kind probe), so the audit dedupe is belt-and-suspenders. Other
-- action families (suppression_remove, retention_archive, preview)
-- are explicitly NOT covered — those surfaces can legitimately
-- produce multiple rows per (venue, target, day) under normal
-- operator usage.
--
-- ── INDEX EXPRESSION ──────────────────────────────────────────────────────
-- `(occurred_at at time zone 'utc')::date` projects the timestamptz to
-- a UTC date. Postgres accepts this in a unique-index expression in
-- the project's pinned Postgres 17 because the `at time zone <const>`
-- form is effectively immutable when the timezone literal is constant
-- (despite the function being declared STABLE). Verified on apply via
-- Supabase MCP — no rejection.
--
-- ── HELPER BEHAVIOR ──────────────────────────────────────────────────────
-- `recordDigestAuditEvent` (lib/billing/digest-audit-events.ts) maps
-- the Postgres unique-violation 23505 to a typed
-- `{ ok: false, error: 'duplicate' }` outcome so the cron's send loop
-- can ignore the harmless duplicate without surfacing it to Sentry.
-- ============================================================================

create unique index if not exists digest_audit_events_cron_send_daily_unique_idx
on public.digest_audit_events (
  venue_id,
  target_user_id,
  action,
  ((occurred_at at time zone 'utc')::date)
)
where action = 'digest_send_cron';

-- Down (commented):
-- drop index if exists public.digest_audit_events_cron_send_daily_unique_idx;
