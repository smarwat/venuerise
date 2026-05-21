// Audit coverage: GET-only route. Markdown + CSV exports emit a
// `vendor_risk_report_exported` audit row via `recordAuditEvent`
// so the trail of "who exported the vendor risk report" stays
// intact. JSON preview refreshes are not audited. Documented in
// docs/AUDIT-COVERAGE.md.

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
  buildVendorRiskSummary,
  renderVendorRiskCsv,
  renderVendorRiskMarkdown,
} from '@/lib/enterprise/vendor-risk/report'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * GET /api/admin/security/vendor-risk-report  (Phase 9K)
 *
 * Returns the full admin vendor risk report. Markdown + CSV
 * downloads are attachment-friendly; JSON is the shape the
 * VendorRiskCard renders.
 *
 * Query params:
 *   - format=json | markdown | csv   (default json)
 *
 * Rate-limit key: admin:vendor-risk-report-read:${userId}
 */

const QuerySchema = z.object({
  format: z.enum(['json', 'markdown', 'csv']).optional(),
})

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/vendor-risk-report',
    op: 'admin.security.vendor_risk_report.read',
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
    `admin:vendor-risk-report-read:${user.id}`,
    {
      route: '/api/admin/security/vendor-risk-report',
      method: 'GET',
      userId: user.id,
      venueId: callerVenueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
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
    summary = await buildVendorRiskSummary()
  } catch (err) {
    reqLog.error(
      { err, format },
      'admin.security.vendor_risk_report.build_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/vendor-risk-report',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  // Audit only on the export formats that actually leave the
  // building. JSON refreshes are operator-internal.
  if (format === 'markdown' || format === 'csv') {
    void recordAuditEvent({
      venueId: callerVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/security/vendor-risk-report',
      action: AUDIT_ACTIONS.VENDOR_RISK_REPORT_EXPORTED,
      targetTable: null,
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        format,
        vendor_count: summary.counts.total,
        production_count: summary.counts.production,
        critical_count: summary.counts.critical,
        manual_review_required_count: summary.counts.manualReviewRequired,
      },
    })
  }

  const date = new Date().toISOString().slice(0, 10)

  if (format === 'markdown') {
    return respond(
      new NextResponse(renderVendorRiskMarkdown(summary), {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="venuerise-vendor-risk-${date}.md"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }

  if (format === 'csv') {
    return respond(
      new NextResponse(renderVendorRiskCsv(summary), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="venuerise-vendor-risk-${date}.csv"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }

  return respond(NextResponse.json({ summary }))
}
