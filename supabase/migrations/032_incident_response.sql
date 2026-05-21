-- ============================================================================
-- Phase 9L — Incident response records, timeline, and alert deliveries.
--
-- Three tables backing the operator-facing incident response layer:
--
--   - `public.incidents`                 — first-class incident record
--   - `public.incident_timeline_events`  — append-only timeline per incident
--   - `public.incident_alert_deliveries` — outbound alert attempts (no secrets)
--
-- Operator discipline carried forward from earlier 9X phases:
--   - Detection is conservative + operator-triggered. NO autonomous
--     remediation or auto-resolve. Detectors return candidates the
--     operator reviews; the API route that materialises an incident
--     requires owner/admin + an explicit `create=true` flag.
--   - Alert routing is env-gated (INCIDENT_ALERTS_ENABLED +
--     INCIDENT_SLACK_WEBHOOK_URL / INCIDENT_PAGERDUTY_ROUTING_KEY).
--     When env is absent the helper returns `skipped_unconfigured`
--     and never throws.
--   - Customer notification is NEVER automatic. The runbook routes
--     every customer-facing communication through legal review.
--   - autonomous_sending_still_disabled health flag stays mounted.
--
-- Schema notes:
--   - `venue_id` is NULLABLE — platform-wide incidents (vendor
--     advisories, deployment-host events) carry venue_id NULL.
--   - `metadata` carries small structural context only (route,
--     limiter key, source row id). NEVER raw payloads, NEVER cookies.
--   - CHECK constraints mirror the TypeScript string unions in
--     lib/enterprise/incidents/types.ts so a writer can't insert
--     an unknown severity / status / source / category.
--   - Alert deliveries hold `target` as the OPERATOR-READABLE label
--     ("#incident-alerts", "venuerise-platform"), NEVER the webhook
--     URL or routing key. Errors are stored as short messages,
--     never raw response bodies.
--
-- ── KNOWN LIMITATION ──────────────────────────────────────────────────────
-- Like audit_events + abuse_events, this is NOT WORM. An admin with
-- direct database access can delete rows. RLS only blocks the REST
-- surface. We rely on the Phase 9C audit_events mirror for tamper
-- evidence on the AUDIT trail of incident lifecycle changes; the
-- incident records themselves are operational.
-- ============================================================================

-- ── 1. incidents ──────────────────────────────────────────────────────────
create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: platform-wide incidents (vendor advisory, deploy host
  -- outage) live without a venue scope. Owner/admin RLS only applies
  -- when venue_id is set; platform-wide rows are admin-read only via
  -- the service-role server route.
  venue_id uuid null references public.venues(id) on delete set null,

  title text not null,
  description text null,

  severity text not null,
  status text not null default 'open',
  category text not null,
  source text not null default 'manual',

  detected_at timestamptz not null default now(),
  opened_at timestamptz not null default now(),
  mitigated_at timestamptz null,
  resolved_at timestamptz null,

  assigned_to uuid null references auth.users(id) on delete set null,
  opened_by uuid null references auth.users(id) on delete set null,
  resolved_by uuid null references auth.users(id) on delete set null,

  -- Optional pointer to the resource the incident is about
  -- (e.g. 'lead' / 'tour' / 'venue' / 'vendor-row-id'). Free-form;
  -- mirrors the audit_events target_table convention.
  related_resource_type text null,
  related_resource_id text null,

  -- External tracker reference (Linear ticket, Jira id, Notion
  -- post-mortem URL). Operator-curated, optional.
  external_reference text null,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ── CHECK constraints — match TS string unions ─────────────────────────
  constraint incidents_severity_chk
    check (severity in ('sev1', 'sev2', 'sev3', 'sev4')),
  constraint incidents_status_chk
    check (status in (
      'open', 'investigating', 'mitigated', 'resolved', 'false_positive'
    )),
  constraint incidents_source_chk
    check (source in (
      'manual', 'abuse_events', 'audit_events', 'sso_login_events',
      'backup_posture', 'csp_reports', 'vendor_risk', 'health_check',
      'other'
    )),
  constraint incidents_category_chk
    check (category in (
      'security', 'availability', 'data_integrity', 'access_control',
      'billing', 'vendor', 'privacy', 'operational'
    )),
  -- Title sanity cap. 200 chars matches the operator dashboard width.
  constraint incidents_title_len_chk
    check (char_length(title) > 0 and char_length(title) <= 200)
);

create index if not exists incidents_venue_created_idx
  on public.incidents(venue_id, created_at desc);
create index if not exists incidents_status_severity_idx
  on public.incidents(status, severity, created_at desc);
create index if not exists incidents_source_created_idx
  on public.incidents(source, created_at desc);
create index if not exists incidents_assigned_status_idx
  on public.incidents(assigned_to, status);
create index if not exists incidents_detected_idx
  on public.incidents(detected_at desc);

alter table public.incidents enable row level security;

-- Owner / admin / sales_manager / coordinator can SELECT incidents
-- for their venue. Viewer is omitted — incident records may carry
-- sensitive context that we don't want to expose to read-only
-- viewer accounts.
drop policy if exists incidents_select_venue on public.incidents;
create policy incidents_select_venue on public.incidents
  for select
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = incidents.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin', 'sales_manager', 'coordinator')
    )
  );

-- Owner / admin can INSERT manual incidents for their venue.
-- Server routes that operate on platform-wide incidents (venue_id
-- NULL) use the service-role client and bypass RLS.
drop policy if exists incidents_insert_venue on public.incidents;
create policy incidents_insert_venue on public.incidents
  for insert
  with check (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = incidents.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin')
    )
  );

-- Owner / admin can UPDATE status / assignment / metadata for their
-- venue's incidents. Application route enforces additional checks
-- (e.g. can't reopen a resolved incident without an explicit flag).
drop policy if exists incidents_update_venue on public.incidents;
create policy incidents_update_venue on public.incidents
  for update
  using (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = incidents.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin')
    )
  )
  with check (
    venue_id is not null
    and exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = incidents.venue_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin')
    )
  );

-- No DELETE policy. Incidents are append-only from the REST surface.
-- Resolution + false-positive flagging happen via status updates so
-- the audit trail stays intact.

-- updated_at trigger — keep it lightweight, no audit semantics
-- here. Application code already writes audit_events on status
-- changes.
create or replace function public.incidents_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists incidents_updated_at on public.incidents;
create trigger incidents_updated_at
  before update on public.incidents
  for each row execute function public.incidents_set_updated_at();


-- ── 2. incident_timeline_events ───────────────────────────────────────────
create table if not exists public.incident_timeline_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  event_type text not null,
  actor_user_id uuid null references auth.users(id) on delete set null,
  message text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint incident_timeline_event_type_chk
    check (event_type in (
      'created', 'status_changed', 'assigned', 'note_added',
      'alert_sent', 'alert_failed', 'evidence_attached',
      'postmortem_added'
    ))
);

create index if not exists incident_timeline_incident_created_idx
  on public.incident_timeline_events(incident_id, created_at asc);
create index if not exists incident_timeline_event_type_idx
  on public.incident_timeline_events(event_type, created_at desc);

alter table public.incident_timeline_events enable row level security;

-- SELECT: owner / admin / sales_manager / coordinator of the
-- parent incident's venue. We mirror the parent's SELECT posture
-- so the drawer loads correctly for the role set that can see the
-- incident table.
drop policy if exists timeline_select_via_parent on public.incident_timeline_events;
create policy timeline_select_via_parent on public.incident_timeline_events
  for select
  using (
    exists (
      select 1
      from public.incidents i
      join public.venue_members vm on vm.venue_id = i.venue_id
      where i.id = incident_timeline_events.incident_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin', 'sales_manager', 'coordinator')
    )
  );

-- INSERT: deliberately NOT allowed from the REST surface. Server
-- routes use the service-role client to append timeline events so
-- the actor_user_id can be set authoritatively + the event_type
-- vocabulary is policed at the application layer.

-- No UPDATE / DELETE policies — timeline is append-only.


-- ── 3. incident_alert_deliveries ──────────────────────────────────────────
-- Records every alert routing ATTEMPT. The helper never throws;
-- skipped/failed outcomes record a row with the reason. No
-- webhook URLs, routing keys, or response bodies are stored.
create table if not exists public.incident_alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid null references public.incidents(id) on delete cascade,
  channel text not null,
  status text not null,
  -- OPERATOR-READABLE label only. NEVER the webhook URL or routing
  -- key. Example: "#incident-alerts", "venuerise-platform".
  target text null,
  -- Short, sanitised error string. NEVER raw response bodies,
  -- NEVER stack traces with secrets.
  error text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint incident_alert_channel_chk
    check (channel in ('slack', 'pagerduty', 'sentry')),
  constraint incident_alert_status_chk
    check (status in (
      'sent', 'failed', 'skipped_disabled', 'skipped_unconfigured',
      'skipped_severity'
    ))
);

create index if not exists incident_alert_deliveries_incident_idx
  on public.incident_alert_deliveries(incident_id, created_at desc);
create index if not exists incident_alert_deliveries_status_idx
  on public.incident_alert_deliveries(status, created_at desc);

alter table public.incident_alert_deliveries enable row level security;

-- SELECT: owner / admin / sales_manager / coordinator of the
-- parent incident's venue. Platform-wide alert rows (incident_id
-- with venue_id NULL on the parent) are admin-read via the
-- service-role server route only.
drop policy if exists alert_select_via_parent on public.incident_alert_deliveries;
create policy alert_select_via_parent on public.incident_alert_deliveries
  for select
  using (
    incident_id is not null
    and exists (
      select 1
      from public.incidents i
      join public.venue_members vm on vm.venue_id = i.venue_id
      where i.id = incident_alert_deliveries.incident_id
        and vm.user_id = auth.uid()
        and vm.role in ('owner', 'admin', 'sales_manager', 'coordinator')
    )
  );

-- INSERT: service-role only. The alert helper is server-only.

-- ── End of Phase 9L migration ────────────────────────────────────────────
