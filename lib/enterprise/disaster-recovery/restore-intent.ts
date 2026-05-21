import 'server-only'
import { log } from '@/lib/log'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import type {
  RestoreIntentInput,
  RestoreIntentScope,
  RestoreIntentStatus,
} from '@/lib/enterprise/disaster-recovery/types'

/**
 * Phase 9H — Restore intent audit helper.
 *
 * Records operator intent to perform a restore. NEVER executes a
 * restore. The product UI surface is intentionally read-only on
 * disaster recovery; real restores happen via the Supabase
 * dashboard / support runbook per `docs/DISASTER-RECOVERY.md`.
 *
 * The helper routes through `recordAuditEvent` so the row lands
 * in:
 *   - `audit_events` (Phase 9A) with action
 *     `restore_intent_recorded` / `restore_intent_cancelled` /
 *     `restore_completed_outside_app`
 *   - `audit_event_mirror` (Phase 9C) when AUDIT_MIRROR_ENABLED=1
 *   - the EnterpriseAuditEventsCard feed
 *
 * Best-effort: failures log + Sentry-capture but NEVER throw.
 * Restore-intent recording is forensic — failing the POST when
 * the audit insert hiccups would be the wrong tradeoff.
 *
 * ── SECURITY POSTURE ────────────────────────────────────────────────────
 *   - `affectedVenueId` is required for venue-scoped intents
 *     (`venue`, `billing`, `lead`). For `full_project` scope, we
 *     attribute the audit row to the actor's primary venue so the
 *     row is queryable from the venue-scoped audit feed.
 *   - The `reason` + `operatorNote` go through the audit helper's
 *     sanitizer (sensitive-key drop + 4 KB cap). Operators must
 *     NEVER paste credentials/tokens into either field.
 *   - The full input is NOT logged. Pino lines carry only the
 *     scope, status, and structural flags.
 */

const VALID_SCOPES: ReadonlyArray<RestoreIntentScope> = [
  'lead',
  'venue',
  'billing',
  'full_project',
  'unknown',
]

const VALID_STATUSES: ReadonlyArray<RestoreIntentStatus> = [
  'requested',
  'review_required',
  'cancelled',
  'completed_outside_app',
]

/**
 * Map a `RestoreIntentStatus` to the audit action constant we
 * stamp on the row. The default — and the only status the route
 * surfaces in 9H — is `requested`, which maps to
 * `RESTORE_INTENT_RECORDED`. Operators can later update the
 * status outside the app (via SQL editor or a future admin
 * route) which would flip the action accordingly.
 */
function actionForStatus(status: RestoreIntentStatus): string {
  switch (status) {
    case 'cancelled':
      return AUDIT_ACTIONS.RESTORE_INTENT_CANCELLED
    case 'completed_outside_app':
      return AUDIT_ACTIONS.RESTORE_COMPLETED_OUTSIDE_APP
    case 'requested':
    case 'review_required':
    default:
      return AUDIT_ACTIONS.RESTORE_INTENT_RECORDED
  }
}

export async function recordRestoreIntent(
  input: RestoreIntentInput
): Promise<void> {
  try {
    if (!VALID_SCOPES.includes(input.scope)) {
      log.warn({ scope: input.scope }, 'restore_intent.invalid_scope')
      return
    }
    const status: RestoreIntentStatus =
      input.status && VALID_STATUSES.includes(input.status)
        ? input.status
        : 'requested'

    // Defensive — the route already enforces this, but the
    // helper should never write a row that's missing the venue
    // attribution. If somehow we get called with neither a
    // venue id nor a `full_project` scope, log + drop.
    if (!input.affectedVenueId && input.scope !== 'full_project') {
      log.warn(
        { scope: input.scope, requestId: input.requestId },
        'restore_intent.missing_venue_for_scope'
      )
      return
    }

    // For `full_project` scope the venue attribution isn't
    // meaningful — the audit helper requires `venueId` though,
    // so we fall back to the operator's affected_venue_id when
    // provided OR to a structural marker. The route guarantees
    // one of these is set for non-full_project scopes.
    const venueId =
      input.affectedVenueId ??
      (input.scope === 'full_project' ? input.actorUserId : null)
    if (!venueId) {
      log.warn(
        { scope: input.scope, requestId: input.requestId },
        'restore_intent.no_venue_attribution_possible'
      )
      return
    }

    void recordAuditEvent({
      venueId,
      actorUserId: input.actorUserId,
      actorKind: 'operator',
      route: '/api/admin/security/restore-intents',
      action: actionForStatus(status),
      targetTable: 'restore_intents',
      targetId: input.affectedResourceId ?? null,
      requestId: input.requestId,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: {
        scope: input.scope,
        status,
        reason: input.reason,
        requested_restore_point: input.requestedRestorePoint ?? null,
        affected_venue_id: input.affectedVenueId ?? null,
        affected_resource_id: input.affectedResourceId ?? null,
        operator_note: input.operatorNote ?? null,
        // Always-on structural flag so an auditor reviewing the
        // row knows VenueRise never executed a restore — this is
        // intent-only.
        restore_executed_by_product: false,
      },
    })

    log.info(
      {
        scope: input.scope,
        status,
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        affectedVenueId: input.affectedVenueId ?? null,
        hasResourceId: Boolean(input.affectedResourceId),
        hasNote: Boolean(input.operatorNote),
      },
      'restore_intent.recorded'
    )
  } catch (err) {
    // Defensive — recordAuditEvent already wraps in try/catch and
    // never throws. This second layer guards against
    // serialization bugs in the helper itself.
    log.warn(
      { err, scope: input.scope, requestId: input.requestId },
      'restore_intent.helper_threw'
    )
  }
}
