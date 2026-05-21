-- ============================================================================
-- Phase 9O — Compliance operations calendar.
--
-- Single table backing the operator-controlled compliance review
-- calendar + evidence freshness tracking.
--
-- Operator discipline:
--   - Events are OPERATOR-INITIATED. The calendar does NOT prove
--     continuous compliance.
--   - Completion + waiver are explicit operator actions; nothing
--     is auto-marked.
--   - No autonomous rotation, no autonomous artifact refresh,
--     no external alerting in this phase.
--   - DELETE is intentionally NOT exposed — operators waive
--     events (status = 'waived') instead so the trail stays
--     intact.
--   - autonomous_sending_still_disabled health flag stays
--     mounted.
--
-- Schema notes:
--   - `venue_id` is required for owner/admin RLS scoping. There
--     are no platform-wide events in 9O — each venue maintains
--     its own calendar against the shared policy.
--   - `metadata` carries small structural context (script
--     output URL, related-incident id). NEVER raw payloads.
--   - CHECK constraints mirror the TypeScript string unions in
--     lib/enterprise/compliance-ops/types.ts so a writer can't
--     insert an unknown area / cadence / status / source.
-- ============================================================================

create table if not exists public.compliance_review_events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid null references public.venues(id) on delete cascade,

  -- Stable policy id from lib/enterprise/compliance-ops/policy.ts
  -- (e.g. 'vendor-risk-review'). Operator-created events use a
  -- 'custom:' prefix so the freshness evaluator can distinguish
  -- them.
  policy_id text not null,
  area text not null,
  title text not null,
  cadence text not null,
  status text not null default 'upcoming',
  source text not null default 'system_seeded',

  due_at timestamptz not null,
  completed_at timestamptz null,
  completed_by uuid null references auth.users(id) on delete set null,
  waived_at timestamptz null,
  waived_by uuid null references auth.users(id) on delete set null,
  waiver_reason text null,
  review_notes text null,
  evidence_url text null,

  metadata jsonb not null default '{}'::jsonb,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint compliance_review_area_chk check (area in (
    'vendor_risk','subprocessors','privacy_dsr','retention_policy',
    'disaster_recovery','backup_posture','incident_response','trust_center',
    'security_questionnaire','evidence_pack','sso_readiness',
    'rate_limit_coverage','audit_coverage','access_control',
    'security_headers','data_lifecycle','custom'
  )),
  constraint compliance_review_cadence_chk check (cadence in (
    'monthly','quarterly','semiannual','annual','ad_hoc'
  )),
  constraint compliance_review_status_chk check (status in (
    'upcoming','due','overdue','completed','waived'
  )),
  constraint compliance_review_source_chk check (source in (
    'system_seeded','operator_created','script_generated'
  ))
);

create index if not exists compliance_review_venue_due_idx
  on public.compliance_review_events(venue_id, due_at);
create index if not exists compliance_review_venue_status_due_idx
  on public.compliance_review_events(venue_id, status, due_at);
create index if not exists compliance_review_area_due_idx
  on public.compliance_review_events(area, due_at);
create index if not exists compliance_review_policy_venue_due_idx
  on public.compliance_review_events(policy_id, venue_id, due_at);

-- Soft de-dup on (venue, policy, due_at) — prevents the seed
-- helper from doubling up on the same scheduled review when an
-- operator clicks "Seed" twice. The expression-style unique
-- index lets us scope to non-terminal statuses so completed +
-- waived events don't block a fresh upcoming entry on the same
-- date.
create unique index if not exists compliance_review_uq_active_policy_due
  on public.compliance_review_events(venue_id, policy_id, due_at)
  where status in ('upcoming','due','overdue');

alter table public.compliance_review_events enable row level security;

-- SELECT: owner / admin can read calendar for their venue.
drop policy if exists compliance_review_select_venue on public.compliance_review_events;
create policy compliance_review_select_venue on public.compliance_review_events
  for select
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = compliance_review_events.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin')
    )
  );

-- INSERT: owner / admin can seed + create custom reviews.
drop policy if exists compliance_review_insert_venue on public.compliance_review_events;
create policy compliance_review_insert_venue on public.compliance_review_events
  for insert
  with check (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = compliance_review_events.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin')
    )
  );

-- UPDATE: owner / admin can complete + waive + update notes.
drop policy if exists compliance_review_update_venue on public.compliance_review_events;
create policy compliance_review_update_venue on public.compliance_review_events
  for update
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = compliance_review_events.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin')
    )
  )
  with check (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = compliance_review_events.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner','admin')
    )
  );

-- No DELETE policy — events are immutable except via
-- complete / waive / update. Mirrors the discipline used for
-- audit_events + incident_timeline_events.

create or replace function public.compliance_review_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists compliance_review_updated_at on public.compliance_review_events;
create trigger compliance_review_updated_at
  before update on public.compliance_review_events
  for each row execute function public.compliance_review_set_updated_at();

-- ── End of Phase 9O migration ────────────────────────────────────────────
