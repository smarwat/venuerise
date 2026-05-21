// Audit coverage: POST writes `incident_alert_sent` audit rows
// for any non-skipped delivery attempt (sent or failed).
// Skipped outcomes (alerts disabled / unconfigured / below
// severity threshold) are recorded in
// incident_alert_deliveries but NOT audited — they are not
// operator-actionable signals on the audit feed.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/require-admin'
import { requireVenueRole } from '@/lib/auth/tenant-access'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { getIncidentWithTimeline } from '@/lib/enterprise/incidents/incidents'
import { routeIncidentAlert } from '@/lib/enterprise/incidents/alert-routing'
import { appendIncidentTimelineEvent } from '@/lib/enterprise/incidents/incidents'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * POST /api/admin/security/incidents/[id]/alert  (Phase 9L)
 *
 * Owner/admin only. Sends an alert for the existing incident
 * via the env-gated channels (Slack / PagerDuty / Sentry).
 * Records each attempt in `incident_alert_deliveries` (best-
 * effort) AND appends a timeline event per delivery.
 *
 * Webhook URLs + routing keys NEVER appear in the response.
 * Skipped/failed outcomes carry a sanitised error string only.
 *
 * Rate-limit key: admin:incident-alert:${userId}
 */

type RouteContext = { params: Promise<{ id: string }> }

async function loadParams(ctx: RouteContext): Promise<{ id: string }> {
  return ctx.params
}

export async function POST(
  request: NextRequest,
  ctx: RouteContext
): Promise<Response> {
  const { id } = await loadParams(ctx)
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/incidents/[id]/alert',
    op: 'admin.security.incidents.alert',
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
  if (!callerVenueId) {
    return respond(
      NextResponse.json({ error: 'venue_required' }, { status: 400 })
    )
  }

  const rl = await rateLimitUserAction(
    request,
    `admin:incident-alert:${user.id}`,
    {
      route: '/api/admin/security/incidents/[id]/alert',
      method: 'POST',
      userId: user.id,
      venueId: callerVenueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  try {
    await requireVenueRole(user.id, callerVenueId, ['owner', 'admin'])
  } catch {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  try {
    const { incident } = await getIncidentWithTimeline(id)
    if (!incident) {
      return respond(
        NextResponse.json({ error: 'not_found' }, { status: 404 })
      )
    }
    if (incident.venueId && incident.venueId !== callerVenueId) {
      return respond(
        NextResponse.json({ error: 'not_found' }, { status: 404 })
      )
    }

    const statuses = await routeIncidentAlert(incident)
    const summary = statuses.map((s) => ({
      channel: s.channel,
      outcome: s.outcome,
      target: s.target,
      error: s.error,
    }))

    // Timeline + audit per non-skipped attempt.
    for (const s of statuses) {
      if (s.outcome === 'sent' || s.outcome === 'failed') {
        void appendIncidentTimelineEvent({
          incidentId: incident.id,
          eventType: s.outcome === 'sent' ? 'alert_sent' : 'alert_failed',
          actorUserId: user.id,
          message: `${s.channel} → ${s.outcome}${s.target ? ` (${s.target})` : ''}${s.error ? `: ${s.error}` : ''}`,
          metadata: {
            channel: s.channel,
            outcome: s.outcome,
            target: s.target,
          },
        })
        void recordAuditEvent({
          venueId: callerVenueId,
          actorUserId: user.id,
          actorKind: 'operator',
          route: '/api/admin/security/incidents/[id]/alert',
          action: AUDIT_ACTIONS.INCIDENT_ALERT_SENT,
          targetTable: 'incidents',
          targetId: id,
          requestId,
          ip:
            request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
            null,
          userAgent: request.headers.get('user-agent'),
          metadata: {
            channel: s.channel,
            outcome: s.outcome,
            target: s.target,
          },
        })
      }
    }

    return respond(NextResponse.json({ ok: true, deliveries: summary }))
  } catch (err) {
    reqLog.error({ err }, 'admin.security.incidents.alert_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/incidents/[id]/alert',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}
