-- ============================================================================
-- Phase 9J — Demo mode foundation.
--
-- Adds four columns to public.venues that let an owner mark the
-- venue as being in "demo mode" — a visual / operator-safety
-- marker shown as a dashboard watermark. This does NOT anonymize
-- production data by itself; it's an attention signal.
--
-- Use cases:
--   - Operator running an enterprise demo on a real venue: flips
--     demo_mode on for the duration so screenshots / shared
--     screens carry a "DEMO MODE — Acme" banner.
--   - QA / staging environments where the venue is meant to be
--     non-production.
--
-- Behavior:
--   - All fields nullable EXCEPT demo_mode_enabled (default false).
--   - demo_mode_label is the operator-facing string (≤120 chars).
--   - demo_mode_started_at + demo_mode_started_by stamp the toggle
--     event; the Phase 9J audit row (DEMO_MODE_UPDATED) carries the
--     full forensic context.
--   - Existing venue RLS continues to apply — no new policies; the
--     toggle endpoint enforces owner-only via application gate.
-- ============================================================================

alter table public.venues
  add column if not exists demo_mode_enabled boolean not null default false;

alter table public.venues
  add column if not exists demo_mode_label text;

-- Length guard — the watermark renders inline in the dashboard
-- top bar; keep the label short enough that it fits without
-- wrapping. 120 chars covers operator-named scenarios like
-- "Enterprise Demo — Acme Property Group, May 2026 review."
alter table public.venues
  drop constraint if exists venues_demo_mode_label_length;
alter table public.venues
  add constraint venues_demo_mode_label_length
  check (demo_mode_label is null or length(demo_mode_label) <= 120);

alter table public.venues
  add column if not exists demo_mode_started_at timestamptz;

alter table public.venues
  add column if not exists demo_mode_started_by uuid
  references auth.users(id) on delete set null;

-- Index helps the dashboard shell quickly check "is this venue in
-- demo mode?" without scanning the whole row — keeps the topbar
-- render path tight.
create index if not exists venues_demo_mode_enabled_idx
  on public.venues (id)
  where demo_mode_enabled = true;

-- Rollback (commented; do not run unless explicitly requested):
-- drop index if exists public.venues_demo_mode_enabled_idx;
-- alter table public.venues drop column if exists demo_mode_started_by;
-- alter table public.venues drop column if exists demo_mode_started_at;
-- alter table public.venues drop constraint if exists venues_demo_mode_label_length;
-- alter table public.venues drop column if exists demo_mode_label;
-- alter table public.venues drop column if exists demo_mode_enabled;
