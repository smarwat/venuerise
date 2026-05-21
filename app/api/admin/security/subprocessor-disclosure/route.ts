// Audit coverage: GET-only route. Markdown + CSV exports emit a
// `subprocessor_disclosure_exported` audit row so the trail of
// "who exported the buyer-facing list" stays intact. JSON
// preview refreshes are not audited. Documented in
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
  buildSubprocessorDisclosure,
  renderSubprocessorDisclosureCsv,
  renderSubprocessorDisclosureMarkdown,
} from '@/lib/enterprise/vendor-risk/report'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * GET /api/admin/security/subprocessor-disclosure  (Phase 9K)
 *
 * Buyer-safe subprocessor disclosure. Only includes vendors
 * whose `disclosureStatus === 'public'` in the registry. Strips
 * evidence references (env vars + package names) so this shape
 * can be shared with procurement / security review teams
 * without exposing internal architecture details.
 *
 * Query params:
 *   - format=json | markdown | csv   (default json)
 *
 * Rate-limit key: admin:subprocessor-disclosure-read:${userId}
 */

const QuerySchema = z.object({
  format: z.enum(['json', 'markdown', 'csv']).optional(),
})

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/subprocessor-disclosure',
    op: 'admin.security.subprocessor_disclosure.read',
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
    `admin:subprocessor-disclosure-read:${user.id}`,
    {
      route: '/api/admin/security/subprocessor-disclosure',
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

  let disclosure
  try {
    disclosure = await buildSubprocessorDisclosure()
  } catch (err) {
    reqLog.error(
      { err, format },
      'admin.security.subprocessor_disclosure.build_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/subprocessor-disclosure',
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
      route: '/api/admin/security/subprocessor-disclosure',
      action: AUDIT_ACTIONS.SUBPROCESSOR_DISCLOSURE_EXPORTED,
      targetTable: null,
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        format,
        record_count: disclosure.records.length,
        production_disclosed: disclosure.counts.productionDisclosed,
      },
    })
  }

  const date = new Date().toISOString().slice(0, 10)

  if (format === 'markdown') {
    return respond(
      new NextResponse(renderSubprocessorDisclosureMarkdown(disclosure), {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="venuerise-subprocessors-${date}.md"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }

  if (format === 'csv') {
    return respond(
      new NextResponse(renderSubprocessorDisclosureCsv(disclosure), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="venuerise-subprocessors-${date}.csv"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }

  return respond(NextResponse.json({ disclosure }))
}
