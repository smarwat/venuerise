// Audit coverage: GET lists commitments (CSV export audited).
// POST creates a commitment + writes `commitment_created`.

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
  createCommitment,
  listCommitments,
} from '@/lib/enterprise/commitments/commitments'
import { renderCommitmentsListCsv } from '@/lib/enterprise/commitments/readiness'
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
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

const ListQuerySchema = z.object({
  status: z
    .enum(COMMITMENT_STATUSES as unknown as [CommitmentStatus, ...CommitmentStatus[]])
    .optional(),
  risk_level: z
    .enum(COMMITMENT_RISK_LEVELS as unknown as [CommitmentRiskLevel, ...CommitmentRiskLevel[]])
    .optional(),
  commitment_area: z
    .enum(COMMITMENT_AREAS as unknown as [CommitmentArea, ...CommitmentArea[]])
    .optional(),
  due_before: z.string().datetime().optional(),
  review_before: z.string().datetime().optional(),
  occurred_before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  format: z.enum(['json', 'csv']).optional(),
})

const CreateBodySchema = z.object({
  buyer_name: z.string().max(200).optional().nullable(),
  buyer_company: z.string().max(200).optional().nullable(),
  buyer_email: z.string().email().max(320).optional().nullable(),
  source_type: z.enum(
    COMMITMENT_SOURCE_TYPES as unknown as [
      CommitmentSourceType,
      ...CommitmentSourceType[],
    ]
  ),
  commitment_area: z.enum(
    COMMITMENT_AREAS as unknown as [CommitmentArea, ...CommitmentArea[]]
  ),
  title: z.string().min(1).max(240),
  description: z.string().min(1).max(8000),
  status: z
    .enum(
      COMMITMENT_STATUSES as unknown as [CommitmentStatus, ...CommitmentStatus[]]
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
  owner_user_id: z.string().uuid().optional().nullable(),
  due_at: z.string().datetime().optional().nullable(),
  review_at: z.string().datetime().optional().nullable(),
  evidence_url: z.string().url().max(1000).optional().nullable(),
  internal_notes: z.string().max(8000).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
})

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/commitments',
    op: 'admin.security.commitments.list',
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
      route: '/api/admin/security/commitments',
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

  const url = new URL(request.url)
  const parsed = ListQuerySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    risk_level: url.searchParams.get('risk_level') ?? undefined,
    commitment_area: url.searchParams.get('commitment_area') ?? undefined,
    due_before: url.searchParams.get('due_before') ?? undefined,
    review_before: url.searchParams.get('review_before') ?? undefined,
    occurred_before: url.searchParams.get('occurred_before') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    format: url.searchParams.get('format') ?? undefined,
  })
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const filters = parsed.data
  const format = filters.format ?? 'json'

  let summary
  try {
    summary = await listCommitments({
      venueId: callerVenueId,
      status: filters.status ?? null,
      riskLevel: filters.risk_level ?? null,
      commitmentArea: filters.commitment_area ?? null,
      dueBefore: filters.due_before ?? null,
      reviewBefore: filters.review_before ?? null,
      occurredBefore: filters.occurred_before ?? null,
      limit: filters.limit ?? 200,
    })
  } catch (err) {
    reqLog.error({ err }, 'admin.security.commitments.list_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/commitments',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  if (format === 'csv') {
    void recordAuditEvent({
      venueId: callerVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/security/commitments',
      action: AUDIT_ACTIONS.COMMITMENTS_EXPORTED,
      targetTable: null,
      targetId: null,
      requestId,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: { total: summary.counts.total },
    })
    const date = new Date().toISOString().slice(0, 10)
    return respond(
      new NextResponse(renderCommitmentsListCsv(summary.commitments), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="venuerise-commitments-${date}.csv"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }

  return respond(NextResponse.json({ summary }))
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/commitments',
    op: 'admin.security.commitments.create',
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
    `admin:commitments-create:${user.id}`,
    {
      route: '/api/admin/security/commitments',
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

  let body: z.infer<typeof CreateBodySchema>
  try {
    const raw = await request.json()
    const parsed = CreateBodySchema.safeParse(raw)
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

  const result = await createCommitment({
    venueId: callerVenueId,
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
    metadata: body.metadata ?? null,
    createdBy: user.id,
  })
  if (!result.ok) {
    return respond(
      NextResponse.json(
        { error: result.code, detail: result.message },
        { status: result.code === 'validation_failed' ? 400 : 500 }
      )
    )
  }

  void recordAuditEvent({
    venueId: callerVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/security/commitments',
    action: AUDIT_ACTIONS.COMMITMENT_CREATED,
    targetTable: 'contract_commitments',
    targetId: result.commitment.id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      source_type: body.source_type,
      commitment_area: body.commitment_area,
      risk_level: body.risk_level ?? 'medium',
      status: body.status ?? 'draft',
    },
  })

  return respond(NextResponse.json({ ok: true, commitment: result.commitment }))
}
