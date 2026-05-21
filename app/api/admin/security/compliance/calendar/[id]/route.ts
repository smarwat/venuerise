// Audit coverage: PATCH writes a typed audit row per action:
// `compliance_review_completed` / `_waived` / `_updated`.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
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
  getComplianceEvent,
  markComplianceReviewCompleted,
  updateComplianceReview,
  waiveComplianceReview,
} from '@/lib/enterprise/compliance-ops/calendar'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS, type AuditAction } from '@/lib/enterprise/audit-actions'

const PatchBodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('complete'),
    review_notes: z.string().max(4000).optional().nullable(),
    evidence_url: z.string().url().max(1000).optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  }),
  z.object({
    action: z.literal('waive'),
    waiver_reason: z.string().min(1).max(4000),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  }),
  z.object({
    action: z.literal('update'),
    review_notes: z.string().max(4000).optional().nullable(),
    evidence_url: z.string().url().max(1000).optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  }),
])

type RouteContext = { params: Promise<{ id: string }> }

async function loadParams(ctx: RouteContext): Promise<{ id: string }> {
  return ctx.params
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext
): Promise<Response> {
  const { id } = await loadParams(ctx)
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/compliance/calendar/[id]',
    op: 'admin.security.compliance.update',
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
    `admin:compliance-calendar-update:${user.id}`,
    {
      route: '/api/admin/security/compliance/calendar/[id]',
      method: 'PATCH',
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

  // Cross-tenant 404 collapse: confirm the event belongs to
  // the caller's venue before any write.
  const before = await getComplianceEvent(id)
  if (!before) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  if (before.venueId && before.venueId !== callerVenueId) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  let body: z.infer<typeof PatchBodySchema>
  try {
    const raw = await request.json()
    const parsed = PatchBodySchema.safeParse(raw)
    if (!parsed.success) {
      return respond(
        NextResponse.json(
          { error: 'validation_failed', detail: parsed.error.flatten() },
          { status: 400 }
        )
      )
    }
    body = parsed.data
  } catch {
    return respond(
      NextResponse.json({ error: 'invalid_json' }, { status: 400 })
    )
  }

  let action: AuditAction
  let updated
  if (body.action === 'complete') {
    const result = await markComplianceReviewCompleted({
      eventId: id,
      reviewNotes: body.review_notes,
      evidenceUrl: body.evidence_url,
      metadata: body.metadata ?? null,
      actorUserId: user.id,
    })
    if (!result.ok) {
      return respond(
        NextResponse.json(
          { error: result.code, detail: result.message },
          { status: 500 }
        )
      )
    }
    updated = result.event
    action = AUDIT_ACTIONS.COMPLIANCE_REVIEW_COMPLETED
  } else if (body.action === 'waive') {
    const result = await waiveComplianceReview({
      eventId: id,
      waiverReason: body.waiver_reason,
      metadata: body.metadata ?? null,
      actorUserId: user.id,
    })
    if (!result.ok) {
      return respond(
        NextResponse.json(
          { error: result.code, detail: result.message },
          { status: result.code === 'validation_failed' ? 400 : 500 }
        )
      )
    }
    updated = result.event
    action = AUDIT_ACTIONS.COMPLIANCE_REVIEW_WAIVED
  } else {
    const result = await updateComplianceReview({
      eventId: id,
      reviewNotes: body.review_notes,
      evidenceUrl: body.evidence_url,
      metadata: body.metadata ?? null,
      actorUserId: user.id,
    })
    if (!result.ok) {
      return respond(
        NextResponse.json(
          { error: result.code, detail: result.message },
          { status: result.code === 'validation_failed' ? 400 : 500 }
        )
      )
    }
    updated = result.event
    action = AUDIT_ACTIONS.COMPLIANCE_REVIEW_UPDATED
  }

  void recordAuditEvent({
    venueId: callerVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/security/compliance/calendar/[id]',
    action,
    targetTable: 'compliance_review_events',
    targetId: id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      area: updated.area,
      policy_id: updated.policyId,
      status_to: updated.status,
    },
  })

  try {
    return respond(NextResponse.json({ ok: true, event: updated }))
  } catch (err) {
    captureApiError(err)
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}
