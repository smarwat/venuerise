-- ============================================================================
-- Phase 8BE — Omnichannel inbox connector foundation.
--
-- Three tables back the multi-source inbox:
--
--   public.venue_channel_connections   — per-venue channel posture
--                                         (channel_type + status + label).
--                                         No credentials / tokens / secrets.
--   public.external_conversations      — mapping from an external thread
--                                         (Instagram DM thread, email thread,
--                                         The Knot inquiry id, etc.) to the
--                                         internal conversation + lead.
--   public.external_messages           — per-message mapping with delivery
--                                         status, direction, and external
--                                         message id for idempotency.
--
-- Safety / honesty posture (mirrored in lib/integrations/channels/*):
--   - No autonomous sending. Outbound is operator-approved.
--   - No real Meta / WeddingWire / The Knot / Gmail OAuth in this phase.
--   - `manualReplyRequired` capabilities are enforced in the UI; the DB
--     is the source of truth for which channels are connected and
--     which external threads map to which internal conversations.
--   - DELETE is intentionally NOT exposed on connections — operators
--     flip to `status = 'disconnected'` so the trail stays intact.
--   - No secrets / tokens / credential columns. Real OAuth tokens will
--     land in a separate encrypted store (future phase) — NEVER here.
--   - CHECK constraints mirror the TypeScript string unions in
--     lib/integrations/channels/types.ts so a writer cannot insert an
--     unknown channel_type / status / delivery_status.
--   - `autonomous_sending_still_disabled` health flag stays mounted.
-- ============================================================================

-- ── public.venue_channel_connections ───────────────────────────────────

create table if not exists public.venue_channel_connections (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,

  channel_type text not null,
  status text not null default 'draft',
  external_account_label text null,
  external_account_id text null,

  metadata jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz null,

  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint venue_channel_connections_type_chk check (channel_type in (
    'website','instagram','facebook','meta_lead_ads','email','sms',
    'the_knot','weddingwire','manual'
  )),
  constraint venue_channel_connections_status_chk check (status in (
    'draft','connected','degraded','disconnected','manual_only'
  )),
  constraint venue_channel_connections_label_len_chk
    check (external_account_label is null or char_length(external_account_label) <= 200)
);

create index if not exists venue_channel_connections_venue_channel_idx
  on public.venue_channel_connections(venue_id, channel_type);
create index if not exists venue_channel_connections_venue_status_idx
  on public.venue_channel_connections(venue_id, status);
create index if not exists venue_channel_connections_metadata_gin_idx
  on public.venue_channel_connections using gin (metadata);

-- Partial unique: one row per (venue, channel, external_account_id)
-- only when external_account_id is non-null. Multiple draft/manual
-- rows without an external id are intentionally allowed.
create unique index if not exists venue_channel_connections_account_unique_idx
  on public.venue_channel_connections (venue_id, channel_type, external_account_id)
  where external_account_id is not null;

alter table public.venue_channel_connections enable row level security;

-- SELECT: owner / admin / sales_manager / coordinator can read the
-- connection inventory for their venue. Read access is broader than
-- write so the dashboard surfaces the inbox source posture to all
-- operators.
drop policy if exists venue_channel_connections_select on public.venue_channel_connections;
create policy venue_channel_connections_select on public.venue_channel_connections
  for select
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = venue_channel_connections.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin','sales_manager','coordinator')
    )
  );

-- INSERT / UPDATE: owner / admin only. Mirrors the existing posture
-- for sensitive venue configuration.
drop policy if exists venue_channel_connections_insert on public.venue_channel_connections;
create policy venue_channel_connections_insert on public.venue_channel_connections
  for insert
  with check (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = venue_channel_connections.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin')
    )
  );

drop policy if exists venue_channel_connections_update on public.venue_channel_connections;
create policy venue_channel_connections_update on public.venue_channel_connections
  for update
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = venue_channel_connections.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin')
    )
  )
  with check (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = venue_channel_connections.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin')
    )
  );

-- No DELETE policy — operators flip to status='disconnected' to
-- preserve the historical trail.

create or replace function public.venue_channel_connections_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists venue_channel_connections_updated_at
  on public.venue_channel_connections;
create trigger venue_channel_connections_updated_at
  before update on public.venue_channel_connections
  for each row execute function public.venue_channel_connections_set_updated_at();


-- ── public.external_conversations ───────────────────────────────────────

create table if not exists public.external_conversations (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,

  lead_id uuid null references public.leads(id) on delete set null,
  conversation_id uuid null references public.conversations(id) on delete set null,
  channel_connection_id uuid null references public.venue_channel_connections(id) on delete set null,

  channel_type text not null,
  external_thread_id text null,
  external_lead_id text null,
  external_contact_id text null,

  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  last_inbound_at timestamptz null,
  last_outbound_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint external_conversations_type_chk check (channel_type in (
    'website','instagram','facebook','meta_lead_ads','email','sms',
    'the_knot','weddingwire','manual'
  )),
  constraint external_conversations_status_chk check (status in (
    'active','archived','disconnected','manual_required'
  ))
);

create index if not exists external_conversations_venue_channel_idx
  on public.external_conversations(venue_id, channel_type);
create index if not exists external_conversations_lead_idx
  on public.external_conversations(lead_id);
create index if not exists external_conversations_conversation_idx
  on public.external_conversations(conversation_id);
create index if not exists external_conversations_metadata_gin_idx
  on public.external_conversations using gin (metadata);

-- Idempotency: same external thread maps to at most one internal row.
create unique index if not exists external_conversations_thread_unique_idx
  on public.external_conversations (venue_id, channel_type, external_thread_id)
  where external_thread_id is not null;

alter table public.external_conversations enable row level security;

-- SELECT: any venue member (operator-level access for inbox needs).
drop policy if exists external_conversations_select on public.external_conversations;
create policy external_conversations_select on public.external_conversations
  for select
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = external_conversations.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin','sales_manager','coordinator')
    )
  );

-- INSERT / UPDATE: service-role only. Connector routes normalize
-- inbound payloads server-side via lib/integrations/channels/normalization
-- so policy enforcement happens at the application layer.

-- No DELETE policy.

create or replace function public.external_conversations_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists external_conversations_updated_at
  on public.external_conversations;
create trigger external_conversations_updated_at
  before update on public.external_conversations
  for each row execute function public.external_conversations_set_updated_at();


-- ── public.external_messages ────────────────────────────────────────────

create table if not exists public.external_messages (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,

  message_id uuid null references public.messages(id) on delete set null,
  external_conversation_id uuid not null references public.external_conversations(id) on delete cascade,

  channel_type text not null,
  external_message_id text null,

  direction text not null,
  delivery_status text not null default 'received',

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint external_messages_type_chk check (channel_type in (
    'website','instagram','facebook','meta_lead_ads','email','sms',
    'the_knot','weddingwire','manual'
  )),
  constraint external_messages_direction_chk check (direction in (
    'inbound','outbound'
  )),
  constraint external_messages_delivery_chk check (delivery_status in (
    'received','drafted','sent','failed','manual_required','copied','marked_sent_manually'
  ))
);

create index if not exists external_messages_venue_channel_idx
  on public.external_messages(venue_id, channel_type);
create index if not exists external_messages_message_idx
  on public.external_messages(message_id);
create index if not exists external_messages_conversation_idx
  on public.external_messages(external_conversation_id);
create index if not exists external_messages_delivery_idx
  on public.external_messages(delivery_status);
create index if not exists external_messages_metadata_gin_idx
  on public.external_messages using gin (metadata);

-- Idempotency: same external message id maps to at most one row.
create unique index if not exists external_messages_external_id_unique_idx
  on public.external_messages (venue_id, channel_type, external_message_id)
  where external_message_id is not null;

alter table public.external_messages enable row level security;

-- SELECT: any venue operator.
drop policy if exists external_messages_select on public.external_messages;
create policy external_messages_select on public.external_messages
  for select
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = external_messages.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin','sales_manager','coordinator')
    )
  );

-- INSERT / UPDATE: service-role only. Connector routes write.

-- No DELETE policy.

-- ── End of Phase 8BE migration ─────────────────────────────────────────
