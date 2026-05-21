-- ============================================================================
-- Phase 9C — Audit event mirror (tamper-evidence).
--
-- A separate table that receives a copy of every successful
-- `audit_events` insert. The mirror's job is to make accidental or
-- malicious mutation of audit history more visible:
--
--   - Stricter RLS than `audit_events` — owner role only (admin can
--     read the primary feed; the mirror is the owner's last word).
--   - No UPDATE or DELETE policies. The mirror can only be appended to
--     via the service-role helper; the REST surface cannot mutate it.
--   - `mirrored_at` timestamp is distinct from `created_at` (the
--     primary row's original time) so a future reconciliation job can
--     detect "primary row deleted, mirror row remains" drift.
--
-- ── KNOWN LIMITATIONS (DOCUMENTED IN docs/AUDIT-COVERAGE.md) ──────────────
-- This is NOT true WORM. An admin with direct database access (psql,
-- Supabase dashboard SQL editor) can still issue DELETE FROM
-- audit_event_mirror. The table separates primary feed from mirror
-- feed and removes the REST surface as an attack path; it doesn't
-- prevent an authorized DB operator from rewriting history. A future
-- phase may add an external append-only sink (object storage,
-- third-party log shipper) for true tamper-evidence.
--
-- ── REDACTION POSTURE ────────────────────────────────────────────────────
-- The mirror payload is the SAME jsonb the `recordAuditEvent` helper
-- already sanitized before the primary insert (sensitive keys dropped,
-- size-capped at 4 KB). The mirror does not re-sanitize on write —
-- the primary feed is the source of truth for what's safe to store.
-- ============================================================================

create table if not exists public.audit_event_mirror (
  -- Same UUID as the primary `audit_events.id` so a join is trivial.
  -- Unique constraint enforced by primary key; duplicate mirror
  -- attempts (e.g. helper retry after a transient network blip) are
  -- silently no-op via ON CONFLICT DO NOTHING in the helper.
  id uuid primary key,
  venue_id uuid not null references public.venues(id) on delete cascade,
  -- We deliberately do NOT add a foreign key to `audit_events.id`.
  -- If the primary row gets deleted (the very tamper case the mirror
  -- is meant to detect), we want the mirror row to remain. The shared
  -- UUID is the link, not a referential constraint.
  actor_user_id uuid null,
  actor_kind text not null,
  route text not null,
  action text not null,
  target_table text null,
  target_id text null,
  request_id text null,
  -- The full sanitized payload the helper stored on the primary row,
  -- collapsed into a single jsonb column. This keeps the mirror
  -- schema-stable as the primary table evolves (a new column on
  -- `audit_events` doesn't require a mirror migration; it just lands
  -- in the payload). Includes: ip_hash, user_agent, before_snapshot,
  -- after_snapshot, metadata.
  payload jsonb not null,
  -- Primary row's `created_at`. Preserved so the mirror is internally
  -- complete (operator doesn't need to join back to the primary feed
  -- to know when the original event happened).
  created_at timestamptz not null,
  -- When THIS mirror row landed. Distinct from `created_at` so a
  -- reconciliation tool can detect mirror lag or drift.
  mirrored_at timestamptz not null default now()
);

-- Per-venue scroll. Mirror queries follow the same access pattern as
-- the primary card: most-recent-first per venue.
create index if not exists audit_event_mirror_venue_created_idx
  on public.audit_event_mirror (venue_id, created_at desc);

-- Per-target. Forensic "what happened to this row" against the mirror.
create index if not exists audit_event_mirror_target_idx
  on public.audit_event_mirror (target_table, target_id);

-- ---------------------------------------------------------------------------
-- RLS — owner SELECT only. Stricter than `audit_events` (owner OR
-- admin). The mirror is the owner's last-resort record of what
-- happened on their venue; even an admin shouldn't be able to read it
-- through the REST surface.
--
-- No INSERT / UPDATE / DELETE policies. All writes go through the
-- service-role `mirrorAuditEvent` helper. The REST surface cannot
-- mutate the table at all (PostgREST will reject every non-SELECT
-- with insufficient privilege).
-- ---------------------------------------------------------------------------

alter table public.audit_event_mirror enable row level security;

drop policy if exists "audit_event_mirror: select for venue owner"
  on public.audit_event_mirror;

create policy "audit_event_mirror: select for venue owner"
  on public.audit_event_mirror
  for select
  using (
    public.has_venue_role(venue_id, auth.uid(), array['owner'])
  );

-- Rollback (commented; do not run unless explicitly requested):
-- drop policy if exists "audit_event_mirror: select for venue owner"
--   on public.audit_event_mirror;
-- drop index if exists public.audit_event_mirror_target_idx;
-- drop index if exists public.audit_event_mirror_venue_created_idx;
-- drop table if exists public.audit_event_mirror;
