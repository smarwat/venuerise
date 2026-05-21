-- Phase 8AM (021): message-body search + ai_actions variant memory
--
-- Two additive changes:
--
-- 1. Trigram index on public.messages.content.
--    The Phase 8AL CommandPalette already searches leads,
--    conversations, and tours. Operators routinely ask "what did Sarah
--    say about her photographer last week?" — that's a content-level
--    search. Without a trigram index a naive ILIKE would scan every
--    message in the venue; with the index the lookup stays bounded.
--    pg_trgm is already provisioned by the Phase 8S migration 015
--    (tour_status_events metadata search) but we guard with
--    `if not exists` so reapplying this file remains safe.
--
-- 2. ai_actions.metadata jsonb column.
--    Phase 8AM persists multi-variant regenerate offers into
--    ai_actions.metadata so the audit trail can replay "operator was
--    offered 3 variants, chose option 2." The original 001 schema
--    didn't include a metadata column; the rest of the codebase
--    follows the same `metadata jsonb` convention used on
--    messages / outbound_messages / venue_members so we adopt it
--    here too. Nullable; default empty object so existing rows
--    don't need a backfill.
--
-- All operations are idempotent.

-- 1. Trigram index on messages.content -----------------------------

create extension if not exists pg_trgm;

create index if not exists messages_content_trgm_idx
  on public.messages
  using gin (content gin_trgm_ops);

-- 2. ai_actions.metadata jsonb -------------------------------------

alter table public.ai_actions
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- Lightweight GIN index for any future filter on metadata keys
-- (variant_count, instruction, etc.). Cheap to maintain on the
-- relatively low-volume ai_actions table.
create index if not exists ai_actions_metadata_gin_idx
  on public.ai_actions
  using gin (metadata jsonb_path_ops);
