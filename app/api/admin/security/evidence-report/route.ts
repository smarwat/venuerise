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
  buildEvidenceReport,
  renderEvidenceReportCsv,
  renderEvidenceReportMarkdown,
} from '@/lib/enterprise/evidence/report'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * GET /api/admin/security/evidence-report  (Phase 9I)
 *
 * Read-only endpoint backing the SecurityEvidenceCenter card +
 * the local build-evidence-pack script's reference path.
 *
 * Query params:
 *   - format=json | markdown | csv (default json)
 *
 * ── BEHAVIOR ────────────────────────────────────────────────────────────
 *   - JSON: full structured EvidenceReport.
 *   - Markdown: downloadable report. We log an
 *     `evidence_report_exported` audit row when this format is
 *     requested — markdown downloads are the format an operator
 *     hands to an auditor, so we want forensic provenance.
 *   - CSV: controls table only. Same audit treatment as
 *     markdown — these are the formats that leave the building.
 *   - The JSON branch is NOT audited. Card refreshes hit this
 *     branch dozens of times per security review; flooding the
 *     audit feed with read events is operator noise.
 *
 * ── SECRETS POSTURE ─────────────────────────────────────────────────────
 *   - No Management API token is ever read in this route (the
 *     backup posture helper handles that server-side).
 *   - The report's `backupPosture` field surfaces only the
 *     `BackupPostureSummary` shape — never the raw Management
 *     API response.
 *   - User-supplied query params are validated via Zod; no
 *     unknown params propagate.
 */

const QuerySchema = z.object({
  format: z.enum(['json', 'markdown', 'csv']).optional(),
})

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/evidence-report',
    op: 'admin.security.evidence_report.read',
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
    `admin:evidence-report-read:${user.id}`,
    {
      route: '/api/admin/security/evidence-report',
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

  let report
  try {
    report = await buildEvidenceReport()
  } catch (err) {
    // Defensive — the builder wraps everything in best-effort
    // try/catch and never throws. This second layer guards
    // against a future bug.
    reqLog.error({ err }, 'admin.security.evidence_report.build_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/evidence-report',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  reqLog.info(
    {
      userId: user.id,
      venueId: callerVenueId,
      format,
      controlCount: report.summary.total,
      implemented: report.summary.implemented,
      partial: report.summary.partial,
      manual: report.summary.manual,
      unknown: report.summary.unknown,
      backupPostureStatus: report.backupPosture?.status ?? 'omitted',
      warningCount: report.warnings.length,
    },
    'admin.security.evidence_report.built'
  )

  // Audit only on the export formats (markdown / csv). JSON
  // requests come from the card refresh + would flood the feed.
  if (format === 'markdown' || format === 'csv') {
    void recordAuditEvent({
      venueId: callerVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/security/evidence-report',
      action: AUDIT_ACTIONS.EVIDENCE_REPORT_EXPORTED,
      targetTable: null,
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        format,
        control_count: report.summary.total,
        implemented: report.summary.implemented,
        partial: report.summary.partial,
        manual: report.summary.manual,
        unknown: report.summary.unknown,
        backup_posture_status:
          report.backupPosture?.status ?? null,
      },
    })
  }

  const date = new Date().toISOString().slice(0, 10)

  if (format === 'markdown') {
    const body = renderEvidenceReportMarkdown(report)
    return respond(
      new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="security-evidence-report-${date}.md"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }

  if (format === 'csv') {
    const body = renderEvidenceReportCsv(report)
    return respond(
      new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="security-evidence-controls-${date}.csv"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }

  return respond(NextResponse.json({ report }))
}
