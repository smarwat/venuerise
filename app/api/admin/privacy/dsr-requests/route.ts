// Audit coverage: GET lists DSR requests + counts (CSV export
// audited via `dsr_report_exported`; JSON refresh is NOT
// audited). POST creates a manual DSR request and writes a
// `dsr_request_created` audit row. DSR requests are NEVER
// auto-fulfilled.

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
  createDsrRequest,
  listDsrRequests,
} from '@/lib/enterprise/privacy/dsr'
import {
  DSR_RISK_LEVELS,
  DSR_STATUSES,
  DSR_TYPES,
  type DsrRiskLevel,
  type DsrStatus,
  type DsrType,
} from '@/lib/enterprise/privacy/types'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

const ListQuerySchema = z.object({
  status: z.enum(DSR_STATUSES as unknown as [DsrStatus, ...DsrStatus[]]).optional(),
  request_type: z.enum(DSR_TYPES as unknown as [DsrType, ...DsrType[]]).optional(),
  risk_level: z
    .enum(DSR_RISK_LEVELS as unknown as [DsrRiskLevel, ...DsrRiskLevel[]])
    .optional(),
  since: z.string().datetime().optional(),
  occurred_before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  format: z.enum(['json', 'csv']).optional(),
})

const CreateBodySchema = z.object({
  request_type: z.enum(DSR_TYPES as unknown as [DsrType, ...DsrType[]]),
  risk_level: z
    .enum(DSR_RISK_LEVELS as unknown as [DsrRiskLevel, ...DsrRiskLevel[]])
    .optional(),
  subject_email: z.string().email().max(320).optional().nullable(),
  subject_name: z.string().max(200).optional().nullable(),
  subject_user_id: z.string().uuid().optional().nullable(),
  requested_by_email: z.string().email().max(320).optional().nullable(),
  description: z.string().max(8000).optional().nullable(),
  scope: z.string().max(4000).optional().nullable(),
  due_at: z.string().datetime().optional().nullable(),
  legal_review_required: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
})

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/privacy/dsr-requests',
    op: 'admin.privacy.dsr.list',
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
    `admin:dsr-list:${user.id}`,
    {
      route: '/api/admin/privacy/dsr-requests',
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
    request_type: url.searchParams.get('request_type') ?? undefined,
    risk_level: url.searchParams.get('risk_level') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
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
    summary = await listDsrRequests({
      venueId: callerVenueId,
      status: filters.status ?? null,
      requestType: filters.request_type ?? null,
      riskLevel: filters.risk_level ?? null,
      since: filters.since ?? null,
      occurredBefore: filters.occurred_before ?? null,
      limit: filters.limit ?? 100,
    })
  } catch (err) {
    reqLog.error({ err }, 'admin.privacy.dsr.list_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/privacy/dsr-requests',
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
      route: '/api/admin/privacy/dsr-requests',
      action: AUDIT_ACTIONS.DSR_REPORT_EXPORTED,
      targetTable: null,
      targetId: null,
      requestId,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        format,
        total: summary.counts.total,
        open: summary.counts.open,
        overdue: summary.counts.overdue,
      },
    })
    const headers = [
      'id',
      'request_type',
      'status',
      'risk_level',
      'subject_email',
      'subject_name',
      'requested_by_email',
      'due_at',
      'fulfilled_at',
      'denied_at',
      'cancelled_at',
      'legal_review_required',
      'created_at',
    ]
    const rows: string[] = [headers.join(',')]
    for (const r of summary.requests) {
      rows.push(
        [
          r.id,
          r.requestType,
          r.status,
          r.riskLevel,
          r.subjectEmail ?? '',
          r.subjectName ?? '',
          r.requestedByEmail ?? '',
          r.dueAt ?? '',
          r.fulfilledAt ?? '',
          r.deniedAt ?? '',
          r.cancelledAt ?? '',
          r.legalReviewRequired ? 'true' : 'false',
          r.createdAt,
        ]
          .map(csvEscape)
          .join(',')
      )
    }
    const date = new Date().toISOString().slice(0, 10)
    return respond(
      new NextResponse(rows.join('\n') + '\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="venuerise-dsr-requests-${date}.csv"`,
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
    route: '/api/admin/privacy/dsr-requests',
    op: 'admin.privacy.dsr.create',
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
    `admin:dsr-create:${user.id}`,
    {
      route: '/api/admin/privacy/dsr-requests',
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

  const result = await createDsrRequest({
    venueId: callerVenueId,
    requestType: body.request_type,
    riskLevel: body.risk_level,
    subjectEmail: body.subject_email,
    subjectName: body.subject_name,
    subjectUserId: body.subject_user_id,
    requestedByEmail: body.requested_by_email,
    description: body.description,
    scope: body.scope,
    dueAt: body.due_at,
    legalReviewRequired: body.legal_review_required,
    metadata: body.metadata,
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
    route: '/api/admin/privacy/dsr-requests',
    action: AUDIT_ACTIONS.DSR_REQUEST_CREATED,
    targetTable: 'dsr_requests',
    targetId: result.dsrRequestId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      request_type: body.request_type,
      risk_level: body.risk_level ?? 'medium',
      legal_review_required: body.legal_review_required ?? true,
    },
  })

  return respond(
    NextResponse.json({ ok: true, dsrRequestId: result.dsrRequestId })
  )
}
