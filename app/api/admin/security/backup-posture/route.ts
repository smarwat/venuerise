// AUDIT_EXEMPT: read-only admin endpoint. No mutation; surface
// is the BackupPostureCard which renders policy targets +
// Management API smoke probe results. Operator actions that
// matter for audit (restore intents) flow through the sibling
// /api/admin/security/restore-intents endpoint, which IS
// audited via `recordRestoreIntent` → `recordAuditEvent`.
// Documented in docs/AUDIT-COVERAGE.md.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/require-admin'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { getBackupPosture } from '@/lib/enterprise/disaster-recovery/backup-posture'

/**
 * GET /api/admin/security/backup-posture  (Phase 9H)
 *
 * Read-only admin endpoint backing the BackupPostureCard. Returns
 * the BackupPostureSummary shape — overall status, RTO/RPO
 * targets, retention target, dry-run cadence, per-check
 * breakdown, last-checked timestamp.
 *
 * Auth: requireAdmin (owner/admin).
 *
 * The Supabase Management API access token is NEVER returned in
 * any response field. The helper hides it; the route only ever
 * surfaces the helper's typed summary.
 *
 * No body input. No filters. The card refreshes by re-calling
 * the endpoint when the operator clicks Refresh.
 */

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/backup-posture',
    op: 'admin.security.backup_posture.read',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(
    request,
    `admin:backup-posture-read:${user.id}`,
    {
      route: '/api/admin/security/backup-posture',
      method: 'GET',
      userId: user.id,
      venueId: callerVenueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  try {
    const summary = await getBackupPosture()
    reqLog.info(
      {
        status: summary.status,
        rtoHours: summary.rtoHours,
        rpoHours: summary.rpoHours,
        retentionDays: summary.retentionDays,
        checkCount: summary.checks.length,
      },
      'admin.security.backup_posture.computed'
    )
    return respond(NextResponse.json({ summary }))
  } catch (err) {
    // Defensive — `getBackupPosture` itself never throws, but a
    // future refactor might. Treat as `unknown` posture.
    reqLog.error({ err }, 'admin.security.backup_posture.threw')
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/backup-posture',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}
