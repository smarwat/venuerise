-- ============================================================================
-- Phase 9M — Privacy DSR (Data Subject Request) readiness.
--
-- Two tables backing the operator-facing privacy workflow:
--
--   - `public.dsr_requests`           — first-class DSR record
--   - `public.dsr_timeline_events`    — append-only timeline per DSR
--
-- Operator discipline:
--   - DSRs are TRACKED, not auto-fulfilled. Every export and
--     deletion routes through operator + legal review.
--   - Status transitions are operator-initiated. No autonomous
--     state change. No autonomous closure.
--   - `legal_review_required` defaults to TRUE — opt-out is an
--     operator decision, not the default.
--   - autonomous_sending_still_disabled health flag stays
--     mounted.
--
-- Schema notes:
--   - `venue_id` is NULLABLE — anonymous DSR intake (not yet
--     wired) would carry venue_id NULL until triaged.
--   - `subject_email` / `subject_name` are operator-supplied
--     during intake. `subject_user_id` is OPTIONAL — many DSRs
--     are from leads, not platform accounts.
--   - `metadata` carries small structural context. NEVER raw
--     export blobs, NEVER copies of subject content. Real
--     exports live in operator-managed secure storage and the
--     row references them via `metadata.external_export_url`.
--   - CHECK constraints mirror the TypeScript string unions in
--     lib/enterprise/privacy/types.ts so a writer can't insert
--     an unknown status / type / risk level.
-- ============================================================================

create table if not exists public.dsr_requests (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid null references public.venues(id) on delete set null,

  request_type text not null,
  status text not null default 'received',
  risk_level text not null default 'medium',

  subject_email text null,
  subject_name text null,
  subject_user_id uuid null references auth.users(id) on delete set null,

  requested_by_email text null,
  requested_by_user_id uuid null references auth.users(id) on delete set null,

  identity_verified_at timestamptz null,
  legal_review_required boolean not null default true,
  legal_review_notes text null,

  description text null,
  scope text null,

  due_at timestamptz null,
  fulfilled_at timestamptz null,
  denied_at timestamptz null,
  cancelled_at timestamptz null,

  assigned_to uuid null references auth.users(id) on delete set null,
  created_by uuid null references auth.users(id) on delete set null,
  closed_by uuid null references auth.users(id) on delete set null,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint dsr_requests_type_chk check (
    request_type in (
      'access', 'export', 'delete', 'correct',
      'restrict_processing', 'opt_out', 'other'
    )
  ),
  constraint dsr_requests_status_chk check (
    status in (
      'received', 'triage', 'identity_verification', 'in_progress',
      'awaiting_legal_review', 'fulfilled', 'denied', 'cancelled'
    )
  ),
  constraint dsr_requests_risk_chk check (
    risk_level in ('low', 'medium', 'high')
  )
);

create index if not exists dsr_requests_venue_created_idx
  on public.dsr_requests(venue_id, created_at desc);
create index if not exists dsr_requests_status_due_idx
  on public.dsr_requests(status, due_at);
create index if not exists dsr_requests_type_created_idx
  on public.dsr_requests(request_type, created_at desc);
create index if not exists dsr_requests_subject_email_idx
  on public.dsr_requests(subject_email);
create index if not exists dsr_requests_assigned_status_idx
  on public.dsr_requests(assigned_to, status);

alter table public.dsr_requests enable row level security;

-- SELECT: owner / admin can read DSRs for their venue.
-- sales_manager / coordinator are intentionally excluded — DSRs
-- carry sensitive subject identity + legal review notes.
drop policy if exists dsr_requests_select_venue on public.dsr_requests;
create policy dsr_requests_select_venue on public.dsr_requests
  for select
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = dsr_requests.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin')
    )
  );

-- INSERT: owner / admin can create DSRs for their venue. No
-- anonymous DSR intake yet — that would require a public route
-- with abuse protection + identity-verification gating, which
-- is reserved for a later phase.
drop policy if exists dsr_requests_insert_venue on public.dsr_requests;
create policy dsr_requests_insert_venue on public.dsr_requests
  for insert
  with check (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = dsr_requests.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin')
    )
  );

-- UPDATE: owner / admin can update status / assignment / legal
-- notes for their venue's DSRs.
drop policy if exists dsr_requests_update_venue on public.dsr_requests;
create policy dsr_requests_update_venue on public.dsr_requests
  for update
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = dsr_requests.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin')
    )
  )
  with check (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = dsr_requests.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin')
    )
  );

-- No DELETE policy — DSR rows are append-only from the REST
-- surface. Cancellation happens via status update so the audit
-- trail stays intact.

create or replace function public.dsr_requests_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists dsr_requests_updated_at on public.dsr_requests;
create trigger dsr_requests_updated_at
  before update on public.dsr_requests
  for each row execute function public.dsr_requests_set_updated_at();


-- ── dsr_timeline_events ───────────────────────────────────────────────────
create table if not exists public.dsr_timeline_events (
  id uuid primary key default gen_random_uuid(),
  dsr_request_id uuid not null references public.dsr_requests(id) on delete cascade,
  event_type text not null,
  actor_user_id uuid null references auth.users(id) on delete set null,
  message text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint dsr_timeline_event_type_chk check (
    event_type in (
      'created', 'status_changed', 'assigned', 'identity_verified',
      'legal_review_added', 'note_added', 'export_prepared',
      'deletion_reviewed', 'fulfilled', 'denied', 'cancelled'
    )
  )
);

create index if not exists dsr_timeline_request_created_idx
  on public.dsr_timeline_events(dsr_request_id, created_at asc);
create index if not exists dsr_timeline_event_type_idx
  on public.dsr_timeline_events(event_type, created_at desc);

alter table public.dsr_timeline_events enable row level security;

-- SELECT: owner / admin of the parent DSR's venue.
drop policy if exists dsr_timeline_select_via_parent on public.dsr_timeline_events;
create policy dsr_timeline_select_via_parent on public.dsr_timeline_events
  for select
  using (
    exists (
      select 1
      from public.dsr_requests d
      join public.venue_members vm on vm.venue_id = d.venue_id
      where d.id = dsr_timeline_events.dsr_request_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin')
    )
  );

-- INSERT: service-role only. Server routes append timeline
-- events authoritatively so actor_user_id + event_type
-- vocabulary are policed at the application layer.

-- No UPDATE / DELETE policies — timeline is append-only.

-- ── End of Phase 9M migration ────────────────────────────────────────────
