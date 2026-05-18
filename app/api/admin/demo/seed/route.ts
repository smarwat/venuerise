import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/require-admin'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { seedDemoVenue } from '@/lib/demo/demo-seed'

/**
 * POST /api/admin/demo/seed (Phase 8A)
 *
 * Wipes any previously-seeded demo rows for the caller's venue + inserts
 * a fresh fixture set (leads / conversations / messages / tours /
 * follow_up_schedules / ai_actions). Idempotent — safe to re-run.
 *
 * Owner/admin only. Rate-limited per caller — demos shouldn't be
 * generating fixture load at production scale.
 *
 * NEVER touches non-demo rows. Reset happens by `email LIKE 'demo+%@venuerise.test'`
 * for leads (which cascades to conversations/messages/tours/follow-ups) and
 * `agent = 'demo-seed'` for ai_actions. Anything else is untouched.
 */
export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/admin/demo/seed' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId } = admin

  const rl = await rateLimitUserAction(request, `admin:demo-seed:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  try {
    const counts = await seedDemoVenue({
      venueId,
      ownerUserId: user.id,
      requestId,
    })
    reqLog.info({ venueId, counts }, 'admin.demo.seed.completed')
    return respond(NextResponse.json({ success: true, ...counts }))
  } catch (err) {
    reqLog.error({ err, venueId }, 'admin.demo.seed.failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/demo/seed',
      userId: user.id,
      venueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
}
