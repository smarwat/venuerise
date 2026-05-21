// Audit coverage: PATCH writes a typed audit row per state
// transition: `dsr_request_updated` for generic changes,
// `dsr_request_fulfilled` / `dsr_request_denied` /
// `dsr_request_cancelled` for terminal status moves. GET is
// operator-internal and NOT audited.

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
  getDsrRequestWithTimeline,
  updateDsrRequest,
} from '@/lib/enterprise/privacy/dsr'
import {
  DSR_RISK_LEVELS,
  DSR_STATUSES,
  type DsrRiskLevel,
  type DsrStatus,
} from '@/lib/enterprise/privacy/types'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS, type AuditAction } from '@/lib/enterprise/audit-actions'

const PatchBodySchema = z.object({
  status: z.enum(DSR_STATUSES as unknown as [DsrStatus, ...DsrStatus[]]).optional(),
  risk_level: z
    .enum(DSR_RISK_LEVELS as unknown as [DsrRiskLevel, ...DsrRiskLevel[]])
    .optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  legal_review_notes: z.string().max(8000).nullable().optional(),
  legal_review_required: z.boolean().optional(),
  description: z.string().max(8000).nullable().optional(),
  scope: z.string().max(4000).nullable().optional(),
  due_at: z.string().datetime().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
  mark_identity_verified: z.boolean().optional(),
})

type RouteContext = { params: Promise<{ id: string }> }

async function loadParams(ctx: RouteContext): Promise<{ id: string }> {
  return ctx.params
}

export async function GET(
  request: NextRequest,
  ctx: RouteContext
): Promise<Response> {
  const { id } = await loadParams(ctx)
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/privacy/dsr-requests/[id]',
    op: 'admin.privacy.dsr.read',
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
    `admin:dsr-read:${user.id}`,
    {
      route: '/api/admin/privacy/dsr-requests/[id]',
      method: 'GET',
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
    const { request: dsr, timeline, warnings } =
      await getDsrRequestWithTimeline(id)
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
    return respond(NextResponse.json({ request: dsr, timeline, warnings }))
  } catch (err) {
    reqLog.error({ err }, 'admin.privacy.dsr.read_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/privacy/dsr-requests/[id]',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext
): Promise<Response> {
  const { id } = await loadParams(ctx)
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/privacy/dsr-requests/[id]',
    op: 'admin.privacy.dsr.update',
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
    `admin:dsr-update:${user.id}`,
    {
      route: '/api/admin/privacy/dsr-requests/[id]',
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

  const before = await getDsrRequestWithTimeline(id)
  if (!before.request) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  if (before.request.venueId && before.request.venueId !== callerVenueId) {
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

  const result = await updateDsrRequest({
    dsrRequestId: id,
    status: body.status,
    riskLevel: body.risk_level,
    assignedTo: body.assigned_to,
    legalReviewNotes: body.legal_review_notes,
    legalReviewRequired: body.legal_review_required,
    description: body.description,
    scope: body.scope,
    dueAt: body.due_at,
    metadata: body.metadata ?? undefined,
    note: body.note,
    markIdentityVerified: body.mark_identity_verified,
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

  let action: AuditAction = AUDIT_ACTIONS.DSR_REQUEST_UPDATED
  if (body.status === 'fulfilled' && before.request.status !== 'fulfilled') {
    action = AUDIT_ACTIONS.DSR_REQUEST_FULFILLED
  } else if (body.status === 'denied' && before.request.status !== 'denied') {
    action = AUDIT_ACTIONS.DSR_REQUEST_DENIED
  } else if (
    body.status === 'cancelled' &&
    before.request.status !== 'cancelled'
  ) {
    action = AUDIT_ACTIONS.DSR_REQUEST_CANCELLED
  }

  void recordAuditEvent({
    venueId: callerVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/privacy/dsr-requests/[id]',
    action,
    targetTable: 'dsr_requests',
    targetId: id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      status_from: before.request.status,
      status_to: result.request.status,
      risk_level_from: before.request.riskLevel,
      risk_level_to: result.request.riskLevel,
      identity_verified: Boolean(body.mark_identity_verified),
      note_added: Boolean(body.note),
      legal_review_added: Boolean(body.legal_review_notes),
    },
  })

  return respond(NextResponse.json({ ok: true, request: result.request }))
}
