// Audit coverage: POST writes `dsr_deletion_reviewed`. The
// review is NON-DESTRUCTIVE — no deletion happens. Appends a
// `deletion_reviewed` timeline event so the DSR record carries
// the trail.

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
import {
  appendDsrTimelineEvent,
  getDsrRequestWithTimeline,
} from '@/lib/enterprise/privacy/dsr'
import { buildDsrDeletionReview } from '@/lib/enterprise/privacy/deletion-review'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

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
    route: '/api/admin/privacy/dsr-requests/[id]/deletion-review',
    op: 'admin.privacy.dsr.deletion_review',
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
    `admin:dsr-deletion-review:${user.id}`,
    {
      route: '/api/admin/privacy/dsr-requests/[id]/deletion-review',
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
    const { request: dsr } = await getDsrRequestWithTimeline(id)
    if (!dsr) {
      return respond(
        NextResponse.json({ error: 'not_found' }, { status: 404 })
      )
    }
    if (dsr.venueId && dsr.venueId !== callerVenueId) {
      return respond(
        NextResponse.json({ error: 'not_found' }, { status: 404 })
      )
    }

    const review = await buildDsrDeletionReview({
      dsrRequestId: dsr.id,
      subjectEmail: dsr.subjectEmail,
      subjectUserId: dsr.subjectUserId,
    })

    void appendDsrTimelineEvent({
      dsrRequestId: dsr.id,
      eventType: 'deletion_reviewed',
      actorUserId: user.id,
      message: `Deletion review generated (${review.items.filter((i) => i.deletable).length} deletable, ${review.items.filter((i) => i.retentionExceptionApplies).length} retention-exception).`,
      metadata: {
        items: review.items.length,
      },
    })

    void recordAuditEvent({
      venueId: callerVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/privacy/dsr-requests/[id]/deletion-review',
      action: AUDIT_ACTIONS.DSR_DELETION_REVIEWED,
      targetTable: 'dsr_requests',
      targetId: id,
      requestId,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        items: review.items.length,
      },
    })

    return respond(NextResponse.json({ review }))
  } catch (err) {
    reqLog.error({ err }, 'admin.privacy.dsr.deletion_review_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/privacy/dsr-requests/[id]/deletion-review',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}
