import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/require-admin'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { resetDemoVenue } from '@/lib/demo/demo-seed'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * POST /api/admin/demo/reset (Phase 8A)
 *
 * Deletes ONLY demo rows from the caller's venue (leads with email
 * matching `demo+%@venuerise.test`, ai_actions tagged `agent='demo-seed'`).
 * Cascades from `leads` clean up conversations / messages / tours /
 * follow_up_schedules.
 *
 * Real (non-demo) data is never touched. Documented in `lib/demo/demo-seed.ts`.
 */
export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/admin/demo/reset' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId } = admin

  const rl = await rateLimitUserAction(request, `admin:demo-reset:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  try {
    const result = await resetDemoVenue({ venueId, requestId })
    reqLog.info({ venueId, result }, 'admin.demo.reset.completed')
    // Phase 9B — enterprise audit. Demo reset is a destructive
    // op (deletes leads / cascades to conversations + tours +
    // follow_ups). The helper restricts deletion to rows tagged
    // demo+ / agent=demo-seed; the audit row records counts so a
    // reviewer can spot an accidentally over-broad reset.
    void recordAuditEvent({
      venueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/demo/reset',
      action: AUDIT_ACTIONS.DEMO_RESET,
      targetTable: null,
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: { counts: result as unknown as Record<string, unknown> },
    })
    return respond(NextResponse.json({ success: true, ...result }))
  } catch (err) {
    reqLog.error({ err, venueId }, 'admin.demo.reset.failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/demo/reset',
      userId: user.id,
      venueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
}
