// Audit coverage: PATCH writes an `incident_updated` audit row
// on any field change, and an `incident_resolved` row when the
// status transitions to resolved. GET is operator-internal and
// NOT audited. Documented in docs/AUDIT-COVERAGE.md.

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
  getIncidentWithTimeline,
  updateIncident,
} from '@/lib/enterprise/incidents/incidents'
import {
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  type IncidentSeverity,
  type IncidentStatus,
} from '@/lib/enterprise/incidents/types'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * GET   /api/admin/security/incidents/[id]  (Phase 9L)
 * PATCH /api/admin/security/incidents/[id]  (Phase 9L)
 *
 * GET returns the incident + timeline. PATCH updates status /
 * severity / assignment / description / metadata / notes /
 * postmortem.
 *
 * Owner/admin only at the venue level. Cross-tenant access
 * (incident.venue_id !== caller's venue) collapses to 404.
 *
 * Rate-limit keys:
 *   - GET:   admin:incident-read:${userId}
 *   - PATCH: admin:incident-update:${userId}
 */

const PatchBodySchema = z.object({
  status: z.enum(INCIDENT_STATUSES as unknown as [IncidentStatus, ...IncidentStatus[]]).optional(),
  severity: z.enum(INCIDENT_SEVERITIES as unknown as [IncidentSeverity, ...IncidentSeverity[]]).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  description: z.string().max(8000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
  postmortem: z.string().max(8000).nullable().optional(),
})

type RouteContext = { params: Promise<{ id: string }> }

async function loadParams(ctx: RouteContext): Promise<{ id: string }> {
  return ctx.params
}

export async function GET(
  request: NextRequest,
  ctx: RouteContext
): Promise<Response> {
  const { id } = await loadParams(ctx)
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/incidents/[id]',
    op: 'admin.security.incidents.read',
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
    `admin:incident-read:${user.id}`,
    {
      route: '/api/admin/security/incidents/[id]',
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

  try {
    const { incident, timeline, warnings } = await getIncidentWithTimeline(id)
    if (!incident) {
      return respond(
        NextResponse.json({ error: 'not_found' }, { status: 404 })
      )
    }
    // Cross-tenant collapse: if the incident belongs to a
    // different venue than the caller, return 404 (NEVER 403)
    // to prevent venue enumeration.
    if (incident.venueId && incident.venueId !== callerVenueId) {
      return respond(
        NextResponse.json({ error: 'not_found' }, { status: 404 })
      )
    }
    return respond(NextResponse.json({ incident, timeline, warnings }))
  } catch (err) {
    reqLog.error({ err }, 'admin.security.incidents.read_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/incidents/[id]',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext
): Promise<Response> {
  const { id } = await loadParams(ctx)
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/incidents/[id]',
    op: 'admin.security.incidents.update',
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
    `admin:incident-update:${user.id}`,
    {
      route: '/api/admin/security/incidents/[id]',
      method: 'PATCH',
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

  // Load BEFORE so we can both (a) cross-tenant-collapse and
  // (b) detect the resolved transition for the audit row.
  const before = await getIncidentWithTimeline(id)
  if (!before.incident) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  if (before.incident.venueId && before.incident.venueId !== callerVenueId) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  const wasResolved = before.incident.status === 'resolved'

  let body: z.infer<typeof PatchBodySchema>
  try {
    const raw = await request.json()
    const parsed = PatchBodySchema.safeParse(raw)
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

  const result = await updateIncident({
    incidentId: id,
    status: body.status,
    severity: body.severity,
    assignedTo: body.assigned_to,
    description: body.description,
    metadata: body.metadata ?? undefined,
    note: body.note,
    postmortem: body.postmortem,
    actorUserId: user.id,
  })
  if (!result.ok) {
    return respond(
      NextResponse.json(
        { error: result.code, detail: result.message },
        { status: result.code === 'validation_failed' ? 400 : 500 }
      )
    )
  }

  const action =
    body.status === 'resolved' && !wasResolved
      ? AUDIT_ACTIONS.INCIDENT_RESOLVED
      : AUDIT_ACTIONS.INCIDENT_UPDATED
  void recordAuditEvent({
    venueId: callerVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/security/incidents/[id]',
    action,
    targetTable: 'incidents',
    targetId: id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      status_from: before.incident.status,
      status_to: result.incident.status,
      severity_from: before.incident.severity,
      severity_to: result.incident.severity,
      note_added: Boolean(body.note),
      postmortem_added: Boolean(body.postmortem),
    },
  })

  return respond(NextResponse.json({ ok: true, incident: result.incident }))
}
