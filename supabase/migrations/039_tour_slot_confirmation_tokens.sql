-- Phase 8BL — Lead-Side Tour Confirmation Links
--
-- Storage for the signed, expiring, single-use tokens the AI hands to
-- a lead when it offers concrete tour slots. The lead clicks one link
-- per slot they want; the public POST route validates the token,
-- re-checks slot availability, and creates a `tours` row. The token's
-- row here flips to `used` only after that POST succeeds.
--
-- ── WHY A NEW TABLE (vs reusing `tour_action_events` from 8L) ────────────
-- The 8K/8L token system is keyed on an EXISTING `tour_id`:
-- `tour_action_events` unique(tour_id, token_nonce). That model
-- enforces single-use against a tour row that already exists. Phase
-- 8BL is the inverse: the whole point is the tour row does NOT exist
-- yet — the lead's click is the trigger that creates it. There is no
-- tour_id to anchor the single-use claim against, so we own one here
-- (unique on token_hash) and only stamp `used_tour_id` after we win
-- the claim AND succeed at creating the tour.
--
-- ── SECURITY POSTURE ─────────────────────────────────────────────────────
-- 1. We store ONLY the SHA-256 hash of the token, never the raw token.
--    A snapshot of this table leaked to an attacker yields no
--    actionable tokens.
-- 2. RLS is deny-all to every authenticated role. Only the service-
--    role client (which bypasses RLS) reads/writes — same posture as
--    `meta_oauth_tokens` (migration 038).
-- 3. expires_at defaults to NOW + 7 days. The caller can override but
--    nothing in the codebase issues longer-lived slot tokens.
-- 4. status is a constrained enum: 'active' | 'used' | 'expired' |
--    'revoked'. The route flips active→used on successful redemption;
--    the orchestrator can flip active→revoked when re-offering slots
--    (so stale links from earlier conversations don't redeem after
--    the lead picks a new time).
-- 5. The (slot_starts_at, slot_ends_at, lead_id, venue_id) tuple is
--    stored so we can re-check availability at click time without
--    decoding the JWT-style payload (defense in depth: a malicious
--    payload re-encoding can't change which slot gets booked).
--
-- ── FIELDS ───────────────────────────────────────────────────────────────
--   id                      — surrogate PK
--   venue_id                — FK to venues; ON DELETE CASCADE
--   lead_id                 — FK to leads; ON DELETE CASCADE (token
--                             becomes unredeemable if the lead is
--                             wiped, e.g. via DSR)
--   conversation_id         — FK to conversations; ON DELETE SET NULL
--                             (audit history of "where this token was
--                             issued"; survives conversation cleanup)
--   offered_by_message_id   — FK to the AI message whose
--                             `offered_tour_slots` metadata contained
--                             this slot. ON DELETE SET NULL.
--   token_hash              — SHA-256 hex (64 chars) of the raw
--                             URL-safe token. UNIQUE — claim flag.
--   slot_starts_at          — ISO UTC start of the offered slot
--   slot_ends_at            — ISO UTC end of the offered slot
--   timezone                — Venue tz at issue time (text label like
--                             "America/Los_Angeles" or NULL)
--   status                  — 'active' | 'used' | 'expired' | 'revoked'
--   used_at                 — timestamptz of successful redemption
--   used_tour_id            — FK to the tours row created on
--                             redemption; ON DELETE SET NULL so a
--                             tour-row deletion doesn't lose the
--                             token-side history
--   expires_at              — Hard expiry; checked at validation time
--                             and by a future cron that flips
--                             active→expired
--   metadata                — jsonb. Used for the redaction-safe
--                             label string (operator-readable),
--                             source IP hash on redemption, etc.
--                             NEVER stores the raw token.
--   created_at              — issue time

create table if not exists public.tour_slot_confirmation_tokens (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null
    references public.venues(id) on delete cascade,
  lead_id uuid not null
    references public.leads(id) on delete cascade,
  conversation_id uuid null
    references public.conversations(id) on delete set null,
  offered_by_message_id uuid null
    references public.messages(id) on delete set null,
  token_hash text not null,
  slot_starts_at timestamptz not null,
  slot_ends_at timestamptz not null,
  timezone text null,
  status text not null default 'active',
  used_at timestamptz null,
  used_tour_id uuid null
    references public.tours(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '7 days'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  -- Single-use enforcement: a token_hash can appear at most once in
  -- the table. The orchestrator generates a fresh random secret per
  -- slot, so collisions on the SHA-256 are computationally
  -- impossible; this uniqueness is the safety net against the
  -- (vanishingly unlikely) case of an upstream key-reuse bug.
  constraint tour_slot_confirmation_tokens_hash_unique unique (token_hash),

  -- Status enum constraint. We avoid a PostgreSQL enum type so the
  -- value can be widened without a migration (matches the
  -- convention used by `tours.status`).
  constraint tour_slot_confirmation_tokens_status_chk
    check (status in ('active', 'used', 'expired', 'revoked')),

  -- Slot interval sanity.
  constraint tour_slot_confirmation_tokens_slot_chk
    check (slot_ends_at > slot_starts_at),

  -- Hash length matches SHA-256 hex (64 chars). Reject anything
  -- else as a clear sign of a writer bug.
  constraint tour_slot_confirmation_tokens_hash_len_chk
    check (char_length(token_hash) = 64),

  -- used_at + used_tour_id coherence: either both set (after
  -- redemption) or both null (still active / expired / revoked).
  constraint tour_slot_confirmation_tokens_used_coherence_chk
    check (
      (used_at is null and used_tour_id is null)
      or (used_at is not null)
    )
);

-- Indexes ---------------------------------------------------------------
-- Look up by venue (operator audit feeds, abuse triage).
create index if not exists tour_slot_confirmation_tokens_venue_idx
  on public.tour_slot_confirmation_tokens(venue_id);
-- Look up by lead (drawer "tokens issued to this lead").
create index if not exists tour_slot_confirmation_tokens_lead_idx
  on public.tour_slot_confirmation_tokens(lead_id);
-- Future cron to flip status active→expired.
create index if not exists tour_slot_confirmation_tokens_expires_at_idx
  on public.tour_slot_confirmation_tokens(expires_at)
  where status = 'active';
-- Look up by the offering AI message (conversation thread audit).
create index if not exists tour_slot_confirmation_tokens_offered_by_msg_idx
  on public.tour_slot_confirmation_tokens(offered_by_message_id)
  where offered_by_message_id is not null;

-- ── RLS — deny-all to authenticated roles ─────────────────────────────
-- Same posture as `meta_oauth_tokens` (038). The public confirm-slot
-- route uses service-role; operator visibility surfaces read through
-- service-role-backed API routes. No authenticated dashboard user
-- ever reads this table directly.
alter table public.tour_slot_confirmation_tokens enable row level security;

drop policy if exists tour_slot_confirmation_tokens_deny_all
  on public.tour_slot_confirmation_tokens;
create policy tour_slot_confirmation_tokens_deny_all
  on public.tour_slot_confirmation_tokens
  for all
  to authenticated
  using (false)
  with check (false);

-- ── Documentation ─────────────────────────────────────────────────────
comment on table public.tour_slot_confirmation_tokens is
  'Phase 8BL. Single-use, expiring tokens that let a lead click an AI-offered tour slot link and create a tours row. Service-role-only access — RLS denies all authenticated reads. Raw token is never stored; the unique token_hash column holds a SHA-256 of the URL-safe token string.';
comment on column public.tour_slot_confirmation_tokens.token_hash is
  'SHA-256 hex digest of the raw URL token. The raw token is NEVER stored. A snapshot leak yields no actionable links.';
comment on column public.tour_slot_confirmation_tokens.status is
  'Lifecycle. active → used on successful POST. active → revoked when the orchestrator re-offers slots in a fresh AI message. active → expired by a future cron that scans expires_at < now() AND status = active.';
comment on column public.tour_slot_confirmation_tokens.used_tour_id is
  'FK to the tours row the redemption created. ON DELETE SET NULL so tour cleanup never orphans the historical token row.';
