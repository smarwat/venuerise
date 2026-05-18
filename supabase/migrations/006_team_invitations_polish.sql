-- ============================================================================
-- VAOS — Phase 6D
-- Migration: 006_team_invitations_polish.sql
--
-- Adds a `revoked_at` audit column to `venue_invitations` so admins can
-- revoke an outstanding invite without losing the record (vs. hard-delete).
-- Also indexes `token` for O(log n) accept-by-token lookups.
--
-- Both statements are idempotent — safe to re-run.
-- ============================================================================

alter table public.venue_invitations
  add column if not exists revoked_at timestamptz;

create index if not exists venue_invitations_token_idx
  on public.venue_invitations(token);

-- ----------------------------------------------------------------------------
-- DOWN (manual rollback only — comment-only, not auto-applied):
--
-- drop index if exists public.venue_invitations_token_idx;
-- alter table public.venue_invitations drop column if exists revoked_at;
-- ----------------------------------------------------------------------------
