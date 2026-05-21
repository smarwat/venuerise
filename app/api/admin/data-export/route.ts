import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth/require-admin'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import {
  buildVenueDataExport,
  summarizeVenueDataExport,
} from '@/lib/enterprise/data-export'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * POST /api/admin/data-export  (Phase 9D)
 *
 * Returns a venue-scoped JSON snapshot of the operator-visible
 * tables. Synchronous + inline — capped at MAX_EXPORT_BYTES so a
 * pathological venue can't blow the response. Async streaming
 * (object storage + signed URL) is a future phase; the prompt
 * deliberately defers it.
 *
 * Body (all optional):
 *   {
 *     "venue_id": "uuid",                  // defaults to caller's primary
 *     "include_audit_events": boolean      // default false
 *   }
 *
 * Response (200 success):
 *   {
 *     "success": true,
 *     "generated_at": "...",
 *     "venue_id": "...",
 *     "summary": { sectionCounts, estimatedBytes, truncatedSections },
 *     "export": { ...VenueDataExport }
 *   }
 *
 * Response (413 export_too_large):
 *   {
 *     "error": "export_too_large",
 *     "message": "Use async export in a future phase.",
 *     "summary": { sectionCounts, estimatedBytes }
 *   }
 *
 * ── SECURITY POSTURE ─────────────────────────────────────────────────────
 *   - `requireAdmin` (owner/admin only).
 *   - Cross-tenant `venue_id` requires `requireVenueRole(ADMIN_ROLES)`.
 *     Forbidden collapses to 404.
 *   - Per-user rate limit: `admin:data-export:{userId}`.
 *   - Includes message bodies + lead PII deliberately — this is an
 *     owner-requested export. Operators should treat the downloaded
 *     payload with the same care as a database dump.
 *   - `audit_events` section ONLY when `include_audit_events=true`
 *     AND caller is owner/admin (already enforced by the gate).
 *   - The audit row records `section_counts` + `estimated_bytes` +
 *     `included_audit_events` — NEVER the full export payload.
 */

const BodySchema = z.object({
  venue_id: z.string().uuid().optional(),
  include_audit_events: z.boolean().optional(),
})

/**
 * Hard cap on the inline JSON payload. ~8 MB matches the typical
 * Next.js edge response ceiling + keeps the browser-side download
 * predictable. A venue that exceeds this gets a 413 with a
 * pointer to the (future) async path.
 */
const MAX_EXPORT_BYTES = 8 * 1024 * 1024

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/data-export',
    op: 'admin.data_export',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  // 1. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId: callerVenueId } = admin

  // 2. Rate limit. Distinct key prefix so a noisy export loop doesn't
  // starve other admin surfaces.
  const rl = await rateLimitUserAction(
    request,
    `admin:data-export:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  // 3. Body.
  const body = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const { venue_id: bodyVenueId, include_audit_events: includeAuditEvents = false } =
    parsed.data

  // 4. Resolve target venue + tenant bind. Cross-tenant requires
  // ADMIN_ROLES on the target; forbidden collapses to 404 so admins
  // can't enumerate venues.
  const targetVenueId = bodyVenueId ?? callerVenueId
  if (targetVenueId !== callerVenueId) {
    try {
      await requireVenueRole(user.id, targetVenueId, ADMIN_ROLES)
    } catch (err) {
      if (err instanceof TenantAccessError) {
        if (err.status === 403) {
          return respond(
            NextResponse.json({ error: 'not_found' }, { status: 404 })
          )
        }
        return respond(
          NextResponse.json({ error: err.code }, { status: err.status })
        )
      }
      throw err
    }
  }

  // 5. Build the export.
  let exportData
  try {
    exportData = await buildVenueDataExport({
      venueId: targetVenueId,
      requestedByUserId: user.id,
      includeAuditEvents,
    })
  } catch (err) {
    reqLog.error(
      { err, venueId: targetVenueId },
      'admin.data_export.build_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/admin/data-export',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  const summary = summarizeVenueDataExport(exportData)

  reqLog.info(
    {
      venueId: targetVenueId,
      userId: user.id,
      includeAuditEvents,
      sectionCounts: summary.sectionCounts,
      estimatedBytes: summary.estimatedBytes,
      truncatedSections: summary.truncatedSections,
    },
    'admin.data_export.built'
  )

  // 6. Size gate. We deliberately emit the audit row in BOTH the
  // success + too-large branches — operator intent to export is the
  // event we want recorded, regardless of whether the payload fit
  // inline.
  void recordAuditEvent({
    venueId: targetVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/data-export',
    action: AUDIT_ACTIONS.DATA_EXPORT_REQUESTED,
    targetTable: 'venues',
    targetId: targetVenueId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      include_audit_events: includeAuditEvents,
      section_counts: summary.sectionCounts,
      estimated_bytes: summary.estimatedBytes,
      truncated_sections: summary.truncatedSections,
      delivered_inline: summary.estimatedBytes <= MAX_EXPORT_BYTES,
      max_export_bytes: MAX_EXPORT_BYTES,
    },
  })

  if (summary.estimatedBytes > MAX_EXPORT_BYTES) {
    return respond(
      NextResponse.json(
        {
          error: 'export_too_large',
          message: 'Use async export in a future phase.',
          summary: {
            section_counts: summary.sectionCounts,
            estimated_bytes: summary.estimatedBytes,
            truncated_sections: summary.truncatedSections,
            max_export_bytes: MAX_EXPORT_BYTES,
          },
        },
        { status: 413 }
      )
    )
  }

  return respond(
    NextResponse.json({
      success: true,
      generated_at: exportData.generatedAt,
      venue_id: targetVenueId,
      summary: {
        section_counts: summary.sectionCounts,
        estimated_bytes: summary.estimatedBytes,
        truncated_sections: summary.truncatedSections,
      },
      export: exportData,
    })
  )
}
