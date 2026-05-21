// Audit coverage: GET commitments readiness summary. Markdown
// + CSV exports audited via `commitments_readiness_exported`;
// JSON refresh is not.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth/require-admin'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import {
  buildCommitmentsReadinessSummary,
  renderCommitmentsReadinessCsv,
  renderCommitmentsReadinessMarkdown,
} from '@/lib/enterprise/commitments/readiness'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

const QuerySchema = z.object({
  format: z.enum(['json', 'markdown', 'csv']).optional(),
})

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/commitments/readiness',
    op: 'admin.security.commitments.readiness',
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
    `admin:commitments-readiness:${user.id}`,
    {
      route: '/api/admin/security/commitments/readiness',
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
  const parsed = QuerySchema.safeParse({
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
  const format = parsed.data.format ?? 'json'

  let summary
  try {
    summary = await buildCommitmentsReadinessSummary(callerVenueId)
  } catch (err) {
    reqLog.error({ err }, 'admin.security.commitments.readiness_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/commitments/readiness',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  if (format === 'markdown' || format === 'csv') {
    void recordAuditEvent({
      venueId: callerVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/security/commitments/readiness',
      action: AUDIT_ACTIONS.COMMITMENTS_READINESS_EXPORTED,
      targetTable: null,
      targetId: null,
      requestId,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        format,
        total: summary.counts.total,
        unsupported_flags: summary.counts.unsupportedRiskFlags,
        overdue_review: summary.counts.overdueReview,
      },
    })
  }

  const date = new Date().toISOString().slice(0, 10)
  if (format === 'markdown') {
    return respond(
      new NextResponse(renderCommitmentsReadinessMarkdown(summary), {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="venuerise-commitments-readiness-${date}.md"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }
  if (format === 'csv') {
    return respond(
      new NextResponse(renderCommitmentsReadinessCsv(summary), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="venuerise-commitments-readiness-${date}.csv"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }
  return respond(NextResponse.json({ summary }))
}
