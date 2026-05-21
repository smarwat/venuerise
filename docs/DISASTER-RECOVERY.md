# Disaster Recovery — Phase 9H

## Purpose

This doc is the operational runbook for restoring VenueRise data
after accidental deletion, corruption, or vendor incident. It also
captures the recovery objectives (RTO/RPO) we hold the system to
and the workflow operators follow when a restore is needed.

**Scope.** Database (Supabase Postgres) and application state.
Anything that lives in Postgres is in scope: leads, conversations,
messages, tours, ai_actions, audit_events, sso_connections, etc.

**Out of scope.** External provider state — Stripe subscriptions,
Resend outbound delivery state, Anthropic conversation history,
Inngest job history. Each of those vendors carries its own
backup / replay posture; see their dashboards directly when a
restore decision touches them.

**Non-goal.** No restore is executed from VenueRise. The product
UI is intentionally non-destructive. Restores happen via the
Supabase dashboard / support workflow by VenueRise staff with
service-role access.

## Recovery objectives

These targets live in `lib/enterprise/disaster-recovery/policy.ts`
and are surfaced on the BackupPostureCard. Edit them in one place
and they propagate to UI + customer-facing summary + the live
posture checks.

| Target | Value | Source |
|---|---|---|
| RTO (Recovery Time Objective) | **4 hours** | Conservative mid-market default |
| RPO (Recovery Point Objective) | **24 hours** | Matches default Supabase daily backup cadence |
| Retention floor | **7 days** | Supabase Pro plan default PITR; bumped when plan supports more |
| Max backup age (warning trigger) | **24 hours** | Aligns with RPO |
| Dry-run cadence | **Quarterly** | Long enough to be sustainable; frequent enough to keep muscle memory |

**Warning vs critical thresholds.** A check flips to `warning` at
`1.5×` the SLA and `critical` at `2.0×` (see
`BACKUP_POSTURE_THRESHOLDS`). For the 24h backup-age check that
means warning at 36h, critical at 48h.

## Incident classes

Every restore decision starts by classifying the incident. The
class determines blast radius, dual-approval requirements, and
which Supabase workflow to use.

### 1. Single lead accidentally deleted

- **Blast radius**: one `leads` row + cascades (conversations,
  messages, tours, ai_actions).
- **First move**: confirm with operator + check audit_events for
  `lead_delete` row (who/when/why). The deletion is captured in
  `audit_events.before_snapshot` with the lead's PII fields.
- **Preferred recovery**: targeted SQL `INSERT` from the audit
  before-snapshot when possible. Full PITR restore for a single
  lead is overkill and risks dragging unrelated changes back.
- **Dual approval needed**: no (single lead).

### 2. Venue-level corruption

- **Blast radius**: all rows scoped to one `venue_id`.
- **First move**: freeze writes for that venue (paid feature flag
  TODO — currently manual via Supabase RLS or service-role gate).
  Identify the corruption window from audit_events + Sentry.
- **Preferred recovery**: clone project to a separate Supabase
  project at the desired point-in-time; export the corrupted
  venue's rows from the clone; import to prod. Avoids touching
  other tenants' data.
- **Dual approval needed**: yes when scope is multi-table or
  spans more than 100 rows.

### 3. Billing / subscription data issue

- **Blast radius**: `subscriptions` + `billing_events_log` rows.
- **First move**: check Stripe dashboard — Stripe is the source
  of truth for subscription state. Replay the relevant
  `billing_events_log` rows via `/api/admin/billing-events/[id]/replay`
  (Phase 9B audited) BEFORE considering a database restore.
- **Preferred recovery**: replay before restore. Database restore
  is the last resort because it can resurrect subscription state
  that Stripe has already moved past.
- **Dual approval needed**: yes — billing data tied to revenue.

### 4. Auth / RBAC mistake

- **Blast radius**: `venue_members` rows (role grants).
- **First move**: revoke any newly-active sessions (Supabase auth
  admin → sign out users) BEFORE attempting any role rollback.
  Then check audit_events for `team_member_role_update`,
  `team_member_remove`, `sso_connection_*` rows.
- **Preferred recovery**: targeted UPDATE on `venue_members` from
  the audit before-snapshot. Full restore touches too much
  unrelated state.
- **Dual approval needed**: yes when promoting back to
  owner/admin from a wider rollback.

### 5. Full project corruption

- **Blast radius**: everything.
- **First move**: PAGE THE TEAM. Set status page if applicable.
  Freeze the project (Supabase dashboard → Pause project) to
  preserve evidence + stop further writes.
- **Preferred recovery**: PITR restore to a clone project, verify
  data integrity, swap traffic via DNS/env update. NEVER restore
  in place — the original project stays paused as evidence.
- **Dual approval needed**: ALWAYS. Two owner-class staff must
  sign off in writing before the restore command is issued.

### 6. Webhook replay or automation bug

- **Blast radius**: depends on the webhook. Stripe webhook bugs
  can cascade into `subscriptions` + `dunning_sent`; Resend
  webhooks affect `outbound_messages.status`.
- **First move**: stop the bug (disable the Inngest function or
  revoke the webhook endpoint in vendor dashboard). Then check
  audit_events for `billing_event_clear_dunning` /
  `billing_event_replay` (Phase 9B-instrumented) rows.
- **Preferred recovery**: targeted SQL based on the audit trail.
  Webhook replay path (`/api/admin/billing-events/[id]/replay`)
  is operator-driven + audited; use it before reaching for PITR.
- **Dual approval needed**: yes when the fix touches >100 rows.

### 7. Accidental migration issue

- **Blast radius**: schema-level — the migration itself ran on
  every row.
- **First move**: STOP applying further migrations. Read the
  failing migration's down-script (commented at the bottom of
  every Phase 9+ migration). Identify whether forward-fix is
  safer than restore.
- **Preferred recovery**: forward-fix migration when possible.
  PITR to the moment before the bad migration runs the schema
  back; rolls forward by replaying every subsequent good
  migration on the restored clone.
- **Dual approval needed**: ALWAYS. Schema mistakes have wide
  blast radius even when they look small.

## Restore decision tree

For every incident class:

1. **Investigate first.** What changed, who changed it, when.
   The audit_events feed + Sentry should answer all three before
   any restore command runs.
2. **Identify blast radius.** How many rows? Which tables?
   Multi-tenant?
3. **Freeze writes if necessary.** Set a temporary RLS deny
   policy or pause the project. Better to lose 10 minutes of
   forward progress than re-corrupt the recovery.
4. **Export evidence.** `pg_dump` the affected tables to a
   side-channel before any restore touches them. The original
   state is the only way to prove "this is what happened" to
   a customer / regulator later.
5. **Choose recovery path.**
   - Targeted SQL from audit before-snapshot (smallest blast
     radius)
   - Selective row import from PITR clone (medium)
   - Full PITR restore to clone, then DNS swap (largest)
6. **Restore outside app.** Supabase dashboard or support
   workflow. NEVER from the product.
7. **Verify.** Sample affected rows, run a smoke test of the
   affected surface (e.g. open `/dashboard/leads` if leads
   were touched).
8. **Communicate internally.** Slack/email update with: what
   broke, what we restored, how long it took, who approved.
9. **Record audit completion.** File a follow-up restore intent
   with `status: 'completed_outside_app'` so the audit feed
   reflects closure.

## Supabase restore workflow

Step-by-step the operator follows for any restore touching
multiple rows:

1. **Identify restore point.** ISO timestamp before the
   corruption. Cross-check audit_events to confirm the bad
   write landed AFTER your target time.
2. **Verify backups / PITR.** Supabase dashboard → Database →
   Backups. Confirm the target window is available on the
   project's plan.
3. **Clone / restore to a separate project.** Supabase dashboard
   → Restore. Choose the cloned-project option, NOT in-place
   restore.
4. **Compare affected rows.** `pg_dump` the clone's affected
   rows + diff against prod. This is the moment to catch
   "we'd restore too much" before any prod write.
5. **Export / import minimal corrected rows.** When safer than
   full restore (which it usually is):
   ```bash
   pg_dump --table=leads --data-only --where="id IN (...)" \
     clone_db > corrected.sql
   psql prod_db < corrected.sql
   ```
6. **Avoid full production restore unless absolutely necessary.**
   Full restores reset every concurrent operator action since
   the restore point. The bar is "the corruption is project-wide
   AND incremental fix is infeasible."
7. **Record audit event.** File a restore intent with
   `status: 'completed_outside_app'` + operator note describing
   what was actually restored.
8. **Post-incident review.** Within 1 business week: write up
   what happened, file follow-up tickets for guardrails that
   would prevent recurrence.

## Data safety rules

These are non-negotiable. Documented here + enforced in code.

1. **No app-triggered destructive restore.** The product UI is
   read-only on this surface. The restore-intent endpoint
   records intent only; the `restore_executed_by_product: false`
   flag is hard-coded into every audit row.
2. **No raw secrets in client.** The Supabase Management API
   token NEVER reaches a client component. `getBackupPosture()`
   is `'server-only'`.
3. **No raw IP storage.** Every audit + abuse row stores the
   salted-SHA-256 fingerprint via `maskIpForAudit` (Phase 9A).
4. **Least-privilege restore access.** Service-role access to
   the Supabase project is limited to the on-call rotation +
   the venue owner. Add/revoke via the Supabase dashboard;
   audit via Supabase's own login log.
5. **Dual approval for full project restore.** Two owner-class
   staff must sign off in writing (Slack thread or ticket)
   before the restore command runs.
6. **Preserve audit logs when feasible.** When restoring, the
   target window should INCLUDE the audit row(s) that prove the
   corruption. Restoring past the audit row erases the evidence
   that motivated the restore.

## Quarterly dry-run checklist

Run this every 90 days. Track completion in a shared doc; a
future phase may add a `dr_dryrun_completed` audit action so the
BackupPostureCard can flip the `DRY_RUN_SCHEDULE_PRESENT` check
to `warning` when overdue.

- [ ] Confirm Supabase project plan still supports the retention
      floor (`policy.minRetentionDays`).
- [ ] Pick a low-traffic window. Snapshot prod's `leads`,
      `conversations`, `messages` row counts.
- [ ] Restore to a fresh clone project at a point-in-time 24h
      ago.
- [ ] Verify the clone's row counts match the snapshot (allowing
      for the 24h delta).
- [ ] Run a smoke against the clone — sign in as a test owner,
      open `/dashboard/leads`, confirm the data renders.
- [ ] Delete the clone (Supabase dashboard → Settings → Delete
      project).
- [ ] Update the dry-run log doc with date + observed restore
      time + any issues.
- [ ] If observed restore time exceeded RTO target, file a
      ticket to investigate the gap.

## Customer-facing language

Use these snippets verbatim in security questionnaires + sales
calls. They live in `policy.customerSummary`; edit there to keep
all surfaces in lockstep.

> Daily managed backups with point-in-time recovery. Recovery
> Time Objective: 4 hours. Recovery Point Objective: 24 hours.
> Quarterly disaster-recovery dry runs. Restores are performed
> through approved Supabase workflows by VenueRise staff; the
> product UI never executes a restore.

For procurement reviewers who want detail:

> Every sensitive write is captured in an enterprise audit log
> (Phase 9A) with a mirror table for tamper-evidence (Phase 9C).
> Disaster-recovery posture is surfaced on an admin card and
> validated by a backup-posture script. Restore operations
> happen outside the product via Supabase-approved workflows
> with dual approval for project-wide restores. RTO is 4 hours,
> RPO is 24 hours.

## Known limitations

- Backup posture card shows `unknown` for live PITR + last-backup
  checks until the Supabase Management API endpoint is wired
  past the project-info smoke probe. The policy targets +
  RUNBOOK presence + dry-run cadence checks operate without
  the Management API.
- The `DR_DRY_RUN_COMPLETED` audit action doesn't exist yet —
  operators track dry-run completion in a separate doc. A future
  phase can add this so the BackupPostureCard auto-flags overdue
  drills.
- Full project restore is documented but not drilled in CI —
  the dry-run checklist above is operator-driven.
- No automatic notification when posture flips to warning /
  critical. A future phase can wire Sentry alert rules off the
  `backup_posture.management_api_*` log lines.
