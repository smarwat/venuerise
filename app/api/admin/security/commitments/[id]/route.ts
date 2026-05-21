// Audit coverage: PATCH writes a typed audit row per
// transition (`commitment_status_changed`, `commitment_fulfilled`,
// `commitment_reviewed`) plus a generic `commitment_updated`
// for any other field change. GET is operator-internal preview
// (NOT audited).

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
  getCommitmentWithTimeline,
  updateCommitment,
} from '@/lib/enterprise/commitments/commitments'
import {
  COMMITMENT_AREAS,
  COMMITMENT_RISK_LEVELS,
  COMMITMENT_SOURCE_TYPES,
  COMMITMENT_STATUSES,
  type CommitmentArea,
  type CommitmentRiskLevel,
  type CommitmentSourceType,
  type CommitmentStatus,
} from '@/lib/enterprise/commitments/types'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS, type AuditAction } from '@/lib/enterprise/audit-actions'

const PatchBodySchema = z.object({
  buyer_name: z.string().max(200).nullable().optional(),
  buyer_company: z.string().max(200).nullable().optional(),
  buyer_email: z.string().email().max(320).nullable().optional(),
  source_type: z
    .enum(
      COMMITMENT_SOURCE_TYPES as unknown as [
        CommitmentSourceType,
        ...CommitmentSourceType[],
      ]
    )
    .optional(),
  commitment_area: z
    .enum(COMMITMENT_AREAS as unknown as [CommitmentArea, ...CommitmentArea[]])
    .optional(),
  title: z.string().min(1).max(240).optional(),
  description: z.string().min(1).max(8000).optional(),
  status: z
    .enum(
      COMMITMENT_STATUSES as unknown as [
        CommitmentStatus,
        ...CommitmentStatus[],
      ]
    )
    .optional(),
  risk_level: z
    .enum(
      COMMITMENT_RISK_LEVELS as unknown as [
        CommitmentRiskLevel,
        ...CommitmentRiskLevel[],
      ]
    )
    .optional(),
  owner_user_id: z.string().uuid().nullable().optional(),
  due_at: z.string().datetime().nullable().optional(),
  review_at: z.string().datetime().nullable().optional(),
  evidence_url: z.string().url().max(1000).nullable().optional(),
  internal_notes: z.string().max(8000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
  mark_fulfilled: z.boolean().optional(),
  mark_reviewed: z.boolean().optional(),
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
    route: '/api/admin/security/commitments/[id]',
    op: 'admin.security.commitments.read',
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
    `admin:commitments-list:${user.id}`,
    {
      route: '/api/admin/security/commitments/[id]',
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
    const { commitment, timeline, warnings } =
      await getCommitmentWithTimeline(id)
    if (!commitment) {
      return respond(
        NextResponse.json({ error: 'not_found' }, { status: 404 })
      )
    }
    if (commitment.venueId && commitment.venueId !== callerVenueId) {
      return respond(
        NextResponse.json({ error: 'not_found' }, { status: 404 })
      )
    }
    return respond(NextResponse.json({ commitment, timeline, warnings }))
  } catch (err) {
    reqLog.error({ err }, 'admin.security.commitments.read_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/commitments/[id]',
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
    route: '/api/admin/security/commitments/[id]',
    op: 'admin.security.commitments.update',
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
    `admin:commitments-update:${user.id}`,
    {
      route: '/api/admin/security/commitments/[id]',
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

  // Load BEFORE so cross-tenant collapse is enforced + we know
  // which audit action to emit.
  const before = await getCommitmentWithTimeline(id)
  if (!before.commitment) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  if (
    before.commitment.venueId &&
    before.commitment.venueId !== callerVenueId
  ) {
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

  const result = await updateCommitment({
    commitmentId: id,
    buyerName: body.buyer_name,
    buyerCompany: body.buyer_company,
    buyerEmail: body.buyer_email,
    sourceType: body.source_type,
    commitmentArea: body.commitment_area,
    title: body.title,
    description: body.description,
    status: body.status,
    riskLevel: body.risk_level,
    ownerUserId: body.owner_user_id,
    dueAt: body.due_at,
    reviewAt: body.review_at,
    evidenceUrl: body.evidence_url,
    internalNotes: body.internal_notes,
    metadata: body.metadata ?? undefined,
    note: body.note,
    markFulfilled: body.mark_fulfilled,
    markReviewed: body.mark_reviewed,
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

  // Choose the strongest audit action that fits the change.
  let action: AuditAction = AUDIT_ACTIONS.COMMITMENT_UPDATED
  if (result.fulfilledNow) action = AUDIT_ACTIONS.COMMITMENT_FULFILLED
  else if (result.statusChanged) action = AUDIT_ACTIONS.COMMITMENT_STATUS_CHANGED
  else if (body.mark_reviewed) action = AUDIT_ACTIONS.COMMITMENT_REVIEWED

  void recordAuditEvent({
    venueId: callerVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/security/commitments/[id]',
    action,
    targetTable: 'contract_commitments',
    targetId: id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      status_from: before.commitment.status,
      status_to: result.commitment.status,
      risk_from: before.commitment.riskLevel,
      risk_to: result.commitment.riskLevel,
      fulfilled_now: result.fulfilledNow,
      reviewed: Boolean(body.mark_reviewed),
      note_added: Boolean(body.note),
    },
  })

  return respond(
    NextResponse.json({ ok: true, commitment: result.commitment })
  )
}
