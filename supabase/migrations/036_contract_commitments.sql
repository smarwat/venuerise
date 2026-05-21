-- ============================================================================
-- Phase 9P — Contract commitments register.
--
-- Two tables backing the operator-controlled register of
-- customer-specific contractual / security / privacy
-- commitments:
--
--   - `public.contract_commitments`        — per-commitment row
--   - `public.contract_commitment_events`  — append-only timeline
--
-- Operator discipline:
--   - Commitments are OPERATOR-RECORDED. No autonomous
--     contract parsing, no auto-creation from uploaded docs.
--   - Status transitions + fulfilment + reviews are explicit
--     operator actions. Nothing is auto-marked.
--   - This is a tracking / readiness workflow, NOT legal advice
--     and NOT contractual compliance proof.
--   - DELETE is intentionally NOT exposed — operators move a
--     commitment to status `withdrawn` instead so the trail
--     stays intact.
--   - autonomous_sending_still_disabled health flag stays
--     mounted.
--
-- Schema notes:
--   - `venue_id` is REQUIRED — commitments are always
--     tenant-scoped.
--   - `metadata` carries small structural context (linked
--     trust grant id, external contract reference). NEVER raw
--     contract bodies or PDFs.
--   - CHECK constraints mirror the TypeScript string unions in
--     lib/enterprise/commitments/types.ts so a writer cannot
--     insert an unknown source_type / area / status / risk
--     level / event_type.
-- ============================================================================

create table if not exists public.contract_commitments (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,

  buyer_name text null,
  buyer_company text null,
  buyer_email text null,

  source_type text not null,
  commitment_area text not null,
  title text not null,
  description text not null,

  status text not null default 'draft',
  risk_level text not null default 'medium',

  owner_user_id uuid null references auth.users(id) on delete set null,

  due_at timestamptz null,
  review_at timestamptz null,
  fulfilled_at timestamptz null,
  fulfilled_by uuid null references auth.users(id) on delete set null,

  evidence_url text null,
  internal_notes text null,

  metadata jsonb not null default '{}'::jsonb,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint commitments_source_chk check (source_type in (
    'msa','dpa','security_addendum','order_form','trust_grant','email','other'
  )),
  constraint commitments_area_chk check (commitment_area in (
    'security','privacy','availability','support','data_retention',
    'subprocessor','sso','scim','incident_response','backup_dr',
    'ai_use','data_residency','other'
  )),
  constraint commitments_status_chk check (status in (
    'draft','active','fulfilled','at_risk','expired','withdrawn'
  )),
  constraint commitments_risk_chk check (risk_level in (
    'low','medium','high','critical'
  )),
  constraint commitments_title_len_chk
    check (char_length(title) > 0 and char_length(title) <= 240)
);

create index if not exists commitments_venue_status_review_idx
  on public.contract_commitments(venue_id, status, review_at);
create index if not exists commitments_venue_risk_created_idx
  on public.contract_commitments(venue_id, risk_level, created_at desc);
create index if not exists commitments_venue_area_idx
  on public.contract_commitments(venue_id, commitment_area);

alter table public.contract_commitments enable row level security;

-- SELECT: owner / admin can read commitments for their venue.
drop policy if exists commitments_select_venue on public.contract_commitments;
create policy commitments_select_venue on public.contract_commitments
  for select
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = contract_commitments.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin')
    )
  );

-- INSERT: owner / admin can record commitments for their venue.
drop policy if exists commitments_insert_venue on public.contract_commitments;
create policy commitments_insert_venue on public.contract_commitments
  for insert
  with check (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = contract_commitments.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin')
    )
  );

-- UPDATE: owner / admin can update status / risk / fulfillment.
drop policy if exists commitments_update_venue on public.contract_commitments;
create policy commitments_update_venue on public.contract_commitments
  for update
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = contract_commitments.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin')
    )
  )
  with check (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = contract_commitments.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin')
    )
  );

-- No DELETE policy — operators move to status `withdrawn`.

create or replace function public.commitments_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists commitments_updated_at on public.contract_commitments;
create trigger commitments_updated_at
  before update on public.contract_commitments
  for each row execute function public.commitments_set_updated_at();


-- ── contract_commitment_events ────────────────────────────────────────────
create table if not exists public.contract_commitment_events (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid null references public.contract_commitments(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  actor_user_id uuid null references auth.users(id) on delete set null,
  event_type text not null,
  note text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint commitment_events_type_chk check (event_type in (
    'created','updated','status_changed','fulfilled','risk_changed',
    'reviewed','note_added'
  ))
);

create index if not exists commitment_events_commitment_created_idx
  on public.contract_commitment_events(commitment_id, created_at desc);
create index if not exists commitment_events_venue_created_idx
  on public.contract_commitment_events(venue_id, created_at desc);

alter table public.contract_commitment_events enable row level security;

-- SELECT: owner / admin can read timeline events for their venue.
drop policy if exists commitment_events_select_venue on public.contract_commitment_events;
create policy commitment_events_select_venue on public.contract_commitment_events
  for select
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = contract_commitment_events.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin')
    )
  );

-- INSERT: service-role only. Server routes append events
-- authoritatively so actor_user_id + event_type are policed
-- at the application layer.

-- No UPDATE / DELETE policies — timeline is append-only.

-- ── End of Phase 9P migration ────────────────────────────────────────────
