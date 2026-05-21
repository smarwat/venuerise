-- Phase GTM-Meta-OAuth — Meta Messenger OAuth token storage
--
-- Tokens are deliberately stored OUTSIDE
-- `venue_channel_connections.metadata` because that column has a
-- sanitizer (lib/integrations/channels/meta-connections.ts) that
-- explicitly REJECTS any key containing the substrings 'token',
-- 'secret', 'access_token', 'refresh_token', etc. That posture is
-- correct — the metadata column is operator-readable + admin-RPC-
-- writable, and pasting a token in there would be a leak vector.
--
-- This table is the dedicated home: deny-all RLS for any
-- authenticated role; only the service-role client (which bypasses
-- RLS) can read/write. Routes that need tokens (the outbound send
-- helper) MUST go through `createServiceClient()`.
--
-- Schema design:
--   - One row per (channel_connection_id, token_type). A venue can
--     have multiple Page Access Tokens if they connect multiple
--     Pages. The user access token is short-lived (~1h, exchanged
--     immediately for a long-lived ~60-day Page token) and we
--     intentionally do not persist it.
--   - `granted_scopes` records which Meta permissions the venue
--     actually granted at OAuth time. Drift detection: if the app
--     starts requesting `instagram_manage_comments` later, this
--     tells us which connections need a re-OAuth.
--   - `expires_at` is the Meta-reported expiry. Long-lived Page
--     tokens are typically 60 days; we refresh proactively at 50.
--   - `last_used_at` updates lazily from the send helper so a
--     dormant connection can be surfaced for cleanup.
--   - `revoked_at` lets the operator (or a future Meta revocation
--     webhook) mark the token unusable without deleting the row —
--     the connection still exists for audit forensics.

-- ── public.meta_oauth_tokens ──────────────────────────────────────────
create table if not exists public.meta_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  channel_connection_id uuid not null
    references public.venue_channel_connections(id) on delete cascade,
  venue_id uuid not null
    references public.venues(id) on delete cascade,
  page_id text not null,
  -- token_type: 'page' is the long-lived Page Access Token used for
  -- send-on-behalf. Reserved 'system_user' for future Business Manager
  -- system-user tokens (advanced flow).
  token_type text not null default 'page',
  access_token text not null,
  -- Comma-separated list of scopes Meta actually granted. NOT what
  -- we asked for — what they returned. (User-side scope screens
  -- can reduce the set.)
  granted_scopes text[] not null default '{}',
  expires_at timestamptz not null,
  last_refreshed_at timestamptz null,
  last_used_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Defensive value constraints.
  constraint meta_oauth_tokens_type_chk check (token_type in ('page', 'system_user')),
  constraint meta_oauth_tokens_page_id_len_chk
    check (char_length(page_id) between 1 and 200),
  -- Tokens are bounded — Meta's long-lived Page tokens fit comfortably
  -- under 1KB. Reject anything larger as suspicious.
  constraint meta_oauth_tokens_access_token_len_chk
    check (char_length(access_token) between 32 and 4096)
);

create index if not exists meta_oauth_tokens_connection_idx
  on public.meta_oauth_tokens(channel_connection_id);
create index if not exists meta_oauth_tokens_venue_idx
  on public.meta_oauth_tokens(venue_id);
create index if not exists meta_oauth_tokens_page_idx
  on public.meta_oauth_tokens(page_id);
-- Refresh job will scan for tokens approaching expiry.
create index if not exists meta_oauth_tokens_expires_at_idx
  on public.meta_oauth_tokens(expires_at)
  where revoked_at is null;
-- One non-revoked Page token per Page per connection.
create unique index if not exists meta_oauth_tokens_active_unique_idx
  on public.meta_oauth_tokens(channel_connection_id, page_id, token_type)
  where revoked_at is null;

-- Updated-at trigger reuses the project's `update_updated_at`
-- function shipped in migration 001 (same fn used by leads, venues,
-- tours, etc.). It sets NEW.updated_at = now() on every UPDATE.
drop trigger if exists meta_oauth_tokens_set_updated_at
  on public.meta_oauth_tokens;
create trigger meta_oauth_tokens_set_updated_at
  before update on public.meta_oauth_tokens
  for each row execute function public.update_updated_at();

-- ── RLS — deny-all to authenticated roles ─────────────────────────────
-- Only the service-role client (which BYPASSES RLS) can touch this
-- table. The outbound send helper, the OAuth callback, and any
-- token-refresh cron MUST use createServiceClient(). Authenticated
-- dashboard users (even owners) never read tokens through the API.
alter table public.meta_oauth_tokens enable row level security;

drop policy if exists meta_oauth_tokens_deny_all on public.meta_oauth_tokens;
create policy meta_oauth_tokens_deny_all on public.meta_oauth_tokens
  for all
  to authenticated
  using (false)
  with check (false);

-- Comments — explicit table documentation so a future code-reviewer
-- can grep for the rationale without having to find this file.
comment on table public.meta_oauth_tokens is
  'Phase GTM-Meta-OAuth. Long-lived Meta Page Access Tokens. Service-role-only access — RLS denies all authenticated reads. Token storage is deliberately separated from venue_channel_connections.metadata because that column has a sanitizer that rejects token-shaped keys.';
comment on column public.meta_oauth_tokens.access_token is
  'Long-lived Meta Page Access Token (~60d expiry). NEVER mirror into logs, audit metadata, or response bodies. Read only inside the send helper.';
comment on column public.meta_oauth_tokens.granted_scopes is
  'Scopes Meta actually returned at OAuth time. May be a subset of what we requested if the user reduced permissions at consent.';
