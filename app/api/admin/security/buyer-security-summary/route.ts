// Audit coverage: GET-only route. Markdown export emits a
// `buyer_security_summary_exported` audit row via
// `recordAuditEvent` so the trail of "who sent which summary"
// stays intact. JSON preview is not audited. Documented in
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
  buildBuyerSecuritySummary,
  renderBuyerSecuritySummaryMarkdown,
} from '@/lib/enterprise/evidence/security-summary'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * GET /api/admin/security/buyer-security-summary  (Phase 9J)
 *
 * Read-only buyer-facing prose summary. Markdown export is the
 * shape an operator would email after a sales call. JSON is the
 * shape the BuyerSecuritySummaryCard renders.
 *
 * Query params:
 *   - format=json | markdown   (default json)
 */

const QuerySchema = z.object({
  format: z.enum(['json', 'markdown']).optional(),
})

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/buyer-security-summary',
    op: 'admin.security.buyer_security_summary.read',
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
    `admin:buyer-security-summary-read:${user.id}`,
    {
      route: '/api/admin/security/buyer-security-summary',
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
    summary = await buildBuyerSecuritySummary()
  } catch (err) {
    reqLog.error(
      { err, format },
      'admin.security.buyer_security_summary.build_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/buyer-security-summary',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  // Audit only on markdown export — the format that actually
  // leaves the building.
  if (format === 'markdown') {
    void recordAuditEvent({
      venueId: callerVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/security/buyer-security-summary',
      action: AUDIT_ACTIONS.BUYER_SECURITY_SUMMARY_EXPORTED,
      targetTable: null,
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        section_count: summary.sections.length,
        known_limitation_count: summary.knownLimitations.length,
        planned_improvement_count: summary.plannedImprovements.length,
      },
    })
  }

  if (format === 'markdown') {
    const body = renderBuyerSecuritySummaryMarkdown(summary)
    const date = new Date().toISOString().slice(0, 10)
    return respond(
      new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="venuerise-security-summary-${date}.md"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }

  return respond(NextResponse.json({ summary }))
}
