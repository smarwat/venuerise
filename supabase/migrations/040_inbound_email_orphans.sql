-- Phase 8BQ — Unmatched inbound email queue.
--
-- 8BO introduced /api/inbound/email which captures lead replies
-- to composer-sent (8BN) emails. Replies that can be matched by
-- In-Reply-To header (HIGH) or by recent-recipient lookup
-- (MEDIUM) are inserted as `role:'lead'` into the conversation
-- thread. Replies that match neither are currently dropped with
-- a pino warning + safe 200 to the upstream provider.
--
-- This migration creates a persistent dead-letter / review queue
-- for those orphan replies so operators can manually link them
-- to the correct conversation (or dismiss them) instead of
-- losing them.
--
-- Honesty rules:
--   - Orphans are NEVER auto-inserted as messages. Linking is a
--     deliberate operator action.
--   - AI never fires on an orphan, even after linking.
--   - We store body PREVIEW + stripped reply text, not the raw
--     payload. No attachments. No full headers.
--   - venue_id may be NULL when the platform could not infer a
--     tenant. NULL-venue rows are NOT exposed to operators —
--     they live in the table for infra-side cross-tenant review
--     (matches the abuse_events posture from migration 029).

create table if not exists public.inbound_email_orphans (
  id uuid primary key default gen_random_uuid(),

  -- Tenant scoping. NULL when we couldn't infer any venue —
  -- those rows are platform-orphan + service-role-only.
  venue_id uuid references public.venues(id) on delete cascade,

  status text not null default 'unresolved'
    check (status in ('unresolved', 'linked', 'dismissed', 'ignored')),

  -- Provider context — used for dedupe + observability.
  provider text not null default 'unknown',
  provider_inbound_id text,
  -- The Resend/Postmark/etc message-id this inbound is in reply
  -- to (extracted from In-Reply-To header). Stored even when
  -- the match failed, so a future re-scan can re-attempt.
  provider_message_id text,

  -- Safe envelope. NEVER raw headers, NEVER attachments.
  from_email text,
  from_name text,
  to_email text,
  subject text,
  -- Reply-quote-stripped operator-visible body (cap 8000).
  stripped_body text,
  -- First 500 chars of the raw body, kept for forensic audit.
  raw_body_preview text,

  received_at timestamptz,
  parsed_at timestamptz not null default now(),

  -- Confidence scoring from the inbound matcher.
  match_confidence integer not null default 0,
  match_reasons text[] not null default '{}',
  -- Operator-facing suggestions surfaced in the queue card so
  -- the operator can one-click link.
  suggested_conversation_ids uuid[] not null default '{}',
  suggested_lead_ids uuid[] not null default '{}',

  -- Set when an operator links the orphan to a conversation.
  linked_conversation_id uuid references public.conversations(id) on delete set null,
  linked_lead_id uuid references public.leads(id) on delete set null,
  linked_message_id uuid references public.messages(id) on delete set null,
  linked_at timestamptz,
  linked_by uuid references auth.users(id) on delete set null,

  -- Set when an operator dismisses the orphan. We never delete
  -- — the row remains for audit + future re-link.
  dismissed_at timestamptz,
  dismissed_by uuid references auth.users(id) on delete set null,
  dismiss_reason text
    check (dismiss_reason is null or dismiss_reason in (
      'spam', 'wrong_venue', 'duplicate', 'not_relevant', 'auto_responder', 'other'
    )),

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────────────────

-- Primary operator query: list venue's unresolved orphans newest first.
create index if not exists inbound_email_orphans_venue_status_idx
  on public.inbound_email_orphans (venue_id, status, created_at desc);

-- Dedupe lookups + operational queries by provider message id.
create index if not exists inbound_email_orphans_provider_inbound_idx
  on public.inbound_email_orphans (provider, provider_inbound_id);

-- Sender history lookups (find all orphans from this lead).
create index if not exists inbound_email_orphans_from_email_idx
  on public.inbound_email_orphans (from_email, created_at desc);

-- Retention cron / cross-venue scans.
create index if not exists inbound_email_orphans_created_idx
  on public.inbound_email_orphans (created_at desc);

-- Hard dedupe — same provider + same provider_inbound_id can only
-- yield one row. Partial because not every provider populates the
-- field; non-id-bearing payloads dedupe via a soft hash in the
-- helper (see lib/integrations/inbound/orphans.ts).
create unique index if not exists inbound_email_orphans_provider_inbound_unique_idx
  on public.inbound_email_orphans (provider, provider_inbound_id)
  where provider_inbound_id is not null;

-- ────────────────────────────────────────────────────────────────────────
-- Updated-at trigger
-- ────────────────────────────────────────────────────────────────────────

create or replace function public.touch_inbound_email_orphans_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_inbound_email_orphans_updated_at
  on public.inbound_email_orphans;
create trigger trg_touch_inbound_email_orphans_updated_at
  before update on public.inbound_email_orphans
  for each row execute function public.touch_inbound_email_orphans_updated_at();

-- ────────────────────────────────────────────────────────────────────────
-- RLS
-- ────────────────────────────────────────────────────────────────────────
--
-- Read: venue sales roles can see their venue's orphans. NULL-
-- venue rows are invisible via PostgREST (infra-team query only).
--
-- Write: no INSERT / UPDATE / DELETE policies. The webhook
-- creates rows via service role; link / dismiss routes also use
-- service role after enforcing tenant ownership in app code.
-- This matches the abuse_events posture in migration 029.

alter table public.inbound_email_orphans enable row level security;

drop policy if exists "inbound_email_orphans: select for venue sales roles"
  on public.inbound_email_orphans;

create policy "inbound_email_orphans: select for venue sales roles"
  on public.inbound_email_orphans
  for select
  using (
    venue_id is not null
    and public.has_venue_role(
      venue_id,
      auth.uid(),
      array['owner', 'admin', 'sales_manager', 'coordinator']
    )
  );

-- Rollback (commented; do not run unless explicitly requested):
-- drop policy if exists "inbound_email_orphans: select for venue sales roles"
--   on public.inbound_email_orphans;
-- drop trigger if exists trg_touch_inbound_email_orphans_updated_at
--   on public.inbound_email_orphans;
-- drop function if exists public.touch_inbound_email_orphans_updated_at();
-- drop index if exists public.inbound_email_orphans_provider_inbound_unique_idx;
-- drop index if exists public.inbound_email_orphans_created_idx;
-- drop index if exists public.inbound_email_orphans_from_email_idx;
-- drop index if exists public.inbound_email_orphans_provider_inbound_idx;
-- drop index if exists public.inbound_email_orphans_venue_status_idx;
-- drop table if exists public.inbound_email_orphans;
