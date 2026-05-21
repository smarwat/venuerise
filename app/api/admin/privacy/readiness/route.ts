// Audit coverage: GET-only route. Markdown + CSV exports emit a
// `privacy_readiness_exported` audit row so the trail of "who
// exported the privacy readiness summary" stays intact. JSON
// preview refreshes are NOT audited.

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
  buildPrivacyReadinessSummary,
  renderInventoryCsv,
  renderPrivacyReadinessMarkdown,
  renderRetentionCsv,
} from '@/lib/enterprise/privacy/readiness'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * GET /api/admin/privacy/readiness  (Phase 9M)
 *
 * Returns the privacy readiness summary (inventory + retention
 * policy + counts + DSR counts). Markdown + CSV exports are
 * attachment-friendly; JSON refresh is the shape the
 * PrivacyReadinessCard renders.
 *
 * Query params:
 *   - format=json | markdown | csv   (default json)
 *   - csv_kind=inventory | retention (default inventory)
 *
 * Rate-limit key: admin:privacy-readiness-read:${userId}
 */

const QuerySchema = z.object({
  format: z.enum(['json', 'markdown', 'csv']).optional(),
  csv_kind: z.enum(['inventory', 'retention']).optional(),
})

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/privacy/readiness',
    op: 'admin.privacy.readiness.read',
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
    `admin:privacy-readiness-read:${user.id}`,
    {
      route: '/api/admin/privacy/readiness',
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
    csv_kind: url.searchParams.get('csv_kind') ?? undefined,
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
  const csvKind = parsed.data.csv_kind ?? 'inventory'

  let summary
  try {
    summary = await buildPrivacyReadinessSummary(callerVenueId)
  } catch (err) {
    reqLog.error({ err }, 'admin.privacy.readiness.build_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/privacy/readiness',
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
      route: '/api/admin/privacy/readiness',
      action: AUDIT_ACTIONS.PRIVACY_READINESS_EXPORTED,
      targetTable: null,
      targetId: null,
      requestId,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        format,
        csv_kind: format === 'csv' ? csvKind : null,
        total_categories: summary.counts.totalCategories,
      },
    })
  }

  const date = new Date().toISOString().slice(0, 10)

  if (format === 'markdown') {
    return respond(
      new NextResponse(renderPrivacyReadinessMarkdown(summary), {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="venuerise-privacy-readiness-${date}.md"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }
  if (format === 'csv') {
    const body =
      csvKind === 'retention'
        ? renderRetentionCsv(summary)
        : renderInventoryCsv(summary)
    return respond(
      new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="venuerise-privacy-${csvKind}-${date}.csv"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }
  return respond(NextResponse.json({ summary }))
}
