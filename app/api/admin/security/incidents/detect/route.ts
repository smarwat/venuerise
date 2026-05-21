// Audit coverage: POST emits `incident_candidates_detected` on
// every call (operator-triggered). When `create=true`, the
// route additionally emits `incident_created` audit rows per
// materialised candidate. Documented in docs/AUDIT-COVERAGE.md.

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
import { runAllDetectors } from '@/lib/enterprise/incidents/detectors'
import { createIncident } from '@/lib/enterprise/incidents/incidents'
import {
  INCIDENT_SOURCES,
  type IncidentSource,
} from '@/lib/enterprise/incidents/types'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * POST /api/admin/security/incidents/detect  (Phase 9L)
 *
 * Owner/admin only. Runs the conservative detector suite.
 *
 * Body:
 *   {
 *     "sources": ["abuse_events", "sso_login_events", "backup_posture", "health_check"]?,
 *     "create": boolean?  // default false
 *   }
 *
 * Without `create=true` this is a pure read — returns the
 * candidate list. With `create=true` we materialise each
 * candidate as a new incident (one audit row per write).
 *
 * Operator discipline: detectors are conservative; thresholds
 * live in lib/enterprise/incidents/policy.ts. NO autonomous
 * remediation occurs and incidents are never auto-resolved.
 *
 * Rate-limit key: admin:incident-detect:${userId}
 */

const BodySchema = z.object({
  sources: z
    .array(z.enum(INCIDENT_SOURCES as unknown as [IncidentSource, ...IncidentSource[]]))
    .optional(),
  create: z.boolean().optional(),
})

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/incidents/detect',
    op: 'admin.security.incidents.detect',
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

  // Tight rate-limit on this route — it queries multiple source
  // tables and (when create=true) fans out incident writes. The
  // standard userAction bucket (30/min) is more than enough for
  // operator-triggered work.
  const rl = await rateLimitUserAction(
    request,
    `admin:incident-detect:${user.id}`,
    {
      route: '/api/admin/security/incidents/detect',
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

  let body: z.infer<typeof BodySchema> = {}
  try {
    const raw = await request.json().catch(() => ({}))
    const parsed = BodySchema.safeParse(raw)
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

  let results
  try {
    results = await runAllDetectors({
      venueId: callerVenueId,
      sources: body.sources,
    })
  } catch (err) {
    reqLog.error({ err }, 'admin.security.incidents.detect_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/incidents/detect',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  const candidateCount = results.reduce(
    (acc, r) => acc + r.candidates.length,
    0
  )

  void recordAuditEvent({
    venueId: callerVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/security/incidents/detect',
    action: AUDIT_ACTIONS.INCIDENT_CANDIDATES_DETECTED,
    targetTable: null,
    targetId: null,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      sources: body.sources ?? null,
      candidate_count: candidateCount,
      create: Boolean(body.create),
    },
  })

  if (!body.create) {
    return respond(
      NextResponse.json({
        candidates: results,
        created: [],
      })
    )
  }

  // Materialise candidates as incidents. Each create writes its
  // own audit row via createIncident → no double-audit; the
  // outer detector audit row above carries the roll-up.
  const created: Array<{
    fingerprint: string
    incidentId: string | null
    error?: string
  }> = []
  for (const result of results) {
    for (const candidate of result.candidates) {
      const out = await createIncident({
        venueId: callerVenueId,
        title: candidate.title,
        description: candidate.description,
        severity: candidate.suggestedSeverity,
        category: candidate.category,
        source: candidate.source,
        metadata: {
          ...candidate.evidence,
          fingerprint: candidate.fingerprint,
          detector_window_ms: result.windowMs,
        },
        openedBy: user.id,
      })
      if (out.ok) {
        created.push({
          fingerprint: candidate.fingerprint,
          incidentId: out.incidentId,
        })
        void recordAuditEvent({
          venueId: callerVenueId,
          actorUserId: user.id,
          actorKind: 'operator',
          route: '/api/admin/security/incidents/detect',
          action: AUDIT_ACTIONS.INCIDENT_CREATED,
          targetTable: 'incidents',
          targetId: out.incidentId,
          requestId,
          ip: null,
          userAgent: null,
          metadata: {
            severity: candidate.suggestedSeverity,
            category: candidate.category,
            source: candidate.source,
            fingerprint: candidate.fingerprint,
            via: 'detector',
          },
        })
      } else {
        created.push({
          fingerprint: candidate.fingerprint,
          incidentId: null,
          error: out.code,
        })
      }
    }
  }

  return respond(
    NextResponse.json({
      candidates: results,
      created,
    })
  )
}
