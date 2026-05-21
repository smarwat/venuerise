// Audit coverage: GET lists calendar (CSV export audited).
// POST drives `seed` or `create_custom` actions and writes the
// matching audit row.

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
  createCustomComplianceReview,
  listComplianceEvents,
  seedComplianceEventsForVenue,
} from '@/lib/enterprise/compliance-ops/calendar'
import {
  COMPLIANCE_REVIEW_AREAS,
  COMPLIANCE_REVIEW_CADENCES,
  COMPLIANCE_REVIEW_STATUSES,
  type ComplianceReviewArea,
  type ComplianceReviewCadence,
  type ComplianceReviewStatus,
} from '@/lib/enterprise/compliance-ops/types'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

const ListQuerySchema = z.object({
  status: z
    .enum(COMPLIANCE_REVIEW_STATUSES as unknown as [
      ComplianceReviewStatus,
      ...ComplianceReviewStatus[],
    ])
    .optional(),
  area: z
    .enum(COMPLIANCE_REVIEW_AREAS as unknown as [
      ComplianceReviewArea,
      ...ComplianceReviewArea[],
    ])
    .optional(),
  since: z.string().datetime().optional(),
  due_before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  format: z.enum(['json', 'csv']).optional(),
})

const PostBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('seed') }),
  z.object({
    action: z.literal('create_custom'),
    area: z.enum(
      COMPLIANCE_REVIEW_AREAS as unknown as [
        ComplianceReviewArea,
        ...ComplianceReviewArea[],
      ]
    ),
    title: z.string().min(1).max(200),
    cadence: z.enum(
      COMPLIANCE_REVIEW_CADENCES as unknown as [
        ComplianceReviewCadence,
        ...ComplianceReviewCadence[],
      ]
    ),
    due_at: z.string().datetime(),
    review_notes: z.string().max(4000).optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  }),
])

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/compliance/calendar',
    op: 'admin.security.compliance.list',
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
    `admin:compliance-calendar-list:${user.id}`,
    {
      route: '/api/admin/security/compliance/calendar',
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
    area: url.searchParams.get('area') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
    due_before: url.searchParams.get('due_before') ?? undefined,
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
    summary = await listComplianceEvents({
      venueId: callerVenueId,
      status: filters.status ?? null,
      area: filters.area ?? null,
      since: filters.since ?? null,
      dueBefore: filters.due_before ?? null,
      limit: filters.limit ?? 200,
    })
  } catch (err) {
    reqLog.error({ err }, 'admin.security.compliance.list_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/compliance/calendar',
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
      route: '/api/admin/security/compliance/calendar',
      action: AUDIT_ACTIONS.COMPLIANCE_CALENDAR_EXPORTED,
      targetTable: null,
      targetId: null,
      requestId,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: { total: summary.counts.total },
    })
    const headers = [
      'id',
      'policy_id',
      'area',
      'title',
      'cadence',
      'status',
      'source',
      'due_at',
      'completed_at',
      'waived_at',
      'evidence_url',
      'created_at',
    ]
    const rows: string[] = [headers.join(',')]
    for (const e of summary.events) {
      rows.push(
        [
          e.id,
          e.policyId,
          e.area,
          e.title,
          e.cadence,
          e.status,
          e.source,
          e.dueAt,
          e.completedAt ?? '',
          e.waivedAt ?? '',
          e.evidenceUrl ?? '',
          e.createdAt,
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
          'Content-Disposition': `attachment; filename="venuerise-compliance-calendar-${date}.csv"`,
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
    route: '/api/admin/security/compliance/calendar',
    op: 'admin.security.compliance.action',
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
    `admin:compliance-calendar-action:${user.id}`,
    {
      route: '/api/admin/security/compliance/calendar',
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

  let body: z.infer<typeof PostBodySchema>
  try {
    const raw = await request.json()
    const parsed = PostBodySchema.safeParse(raw)
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

  if (body.action === 'seed') {
    const result = await seedComplianceEventsForVenue(callerVenueId, user.id)
    void recordAuditEvent({
      venueId: callerVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/security/compliance/calendar',
      action: AUDIT_ACTIONS.COMPLIANCE_EVENTS_SEEDED,
      targetTable: 'compliance_review_events',
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        inserted: result.inserted,
        skipped: result.skipped,
        warning_count: result.warnings.length,
      },
    })
    return respond(
      NextResponse.json({
        ok: result.ok,
        inserted: result.inserted,
        skipped: result.skipped,
        warnings: result.warnings,
      })
    )
  }

  // create_custom
  const created = await createCustomComplianceReview({
    venueId: callerVenueId,
    area: body.area,
    title: body.title,
    cadence: body.cadence,
    dueAt: body.due_at,
    reviewNotes: body.review_notes,
    metadata: body.metadata ?? null,
    createdBy: user.id,
  })
  if (!created.ok) {
    return respond(
      NextResponse.json(
        { error: created.code, detail: created.message },
        { status: created.code === 'validation_failed' ? 400 : 500 }
      )
    )
  }

  void recordAuditEvent({
    venueId: callerVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/security/compliance/calendar',
    action: AUDIT_ACTIONS.COMPLIANCE_REVIEW_CREATED,
    targetTable: 'compliance_review_events',
    targetId: created.event.id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      area: body.area,
      cadence: body.cadence,
      source: 'operator_created',
    },
  })

  return respond(NextResponse.json({ ok: true, event: created.event }))
}
