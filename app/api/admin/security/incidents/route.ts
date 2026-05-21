// Audit coverage: GET lists + filters incidents. POST creates a
// manual incident and writes an `incident_created` audit row;
// CSV export writes `incident_report_exported`. JSON refresh on
// GET is NOT audited (operator-internal). Documented in
// docs/AUDIT-COVERAGE.md.

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
  createIncident,
  listIncidents,
} from '@/lib/enterprise/incidents/incidents'
import { routeIncidentAlert } from '@/lib/enterprise/incidents/alert-routing'
import {
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_SOURCES,
  INCIDENT_STATUSES,
  type IncidentCategory,
  type IncidentSeverity,
  type IncidentSource,
  type IncidentStatus,
} from '@/lib/enterprise/incidents/types'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * GET  /api/admin/security/incidents  (Phase 9L)
 * POST /api/admin/security/incidents  (Phase 9L)
 *
 * GET: list incidents + summary counts. `format=json|csv`. CSV
 *      export is audited; JSON refresh is not.
 * POST: create a manual incident. Owner/admin only at the venue
 *      level. Optionally fans out an alert when `notify=true`
 *      AND alerts are env-configured.
 *
 * Rate-limit keys:
 *   - GET:  admin:incident-list:${userId}
 *   - POST: admin:incident-create:${userId}
 */

const ListQuerySchema = z.object({
  status: z.enum(INCIDENT_STATUSES as unknown as [IncidentStatus, ...IncidentStatus[]]).optional(),
  severity: z.enum(INCIDENT_SEVERITIES as unknown as [IncidentSeverity, ...IncidentSeverity[]]).optional(),
  category: z.enum(INCIDENT_CATEGORIES as unknown as [IncidentCategory, ...IncidentCategory[]]).optional(),
  source: z.enum(INCIDENT_SOURCES as unknown as [IncidentSource, ...IncidentSource[]]).optional(),
  since: z.string().datetime().optional(),
  occurred_before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  format: z.enum(['json', 'csv']).optional(),
})

const CreateBodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(8000).optional().nullable(),
  severity: z.enum(INCIDENT_SEVERITIES as unknown as [IncidentSeverity, ...IncidentSeverity[]]),
  category: z.enum(INCIDENT_CATEGORIES as unknown as [IncidentCategory, ...IncidentCategory[]]),
  source: z.enum(INCIDENT_SOURCES as unknown as [IncidentSource, ...IncidentSource[]]).optional(),
  detected_at: z.string().datetime().optional().nullable(),
  related_resource_type: z.string().max(80).optional().nullable(),
  related_resource_id: z.string().max(200).optional().nullable(),
  external_reference: z.string().max(500).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  notify: z.boolean().optional(),
})

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/incidents',
    op: 'admin.security.incidents.list',
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
    `admin:incident-list:${user.id}`,
    {
      route: '/api/admin/security/incidents',
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
  const parsed = ListQuerySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    severity: url.searchParams.get('severity') ?? undefined,
    category: url.searchParams.get('category') ?? undefined,
    source: url.searchParams.get('source') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
    occurred_before: url.searchParams.get('occurred_before') ?? undefined,
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
    summary = await listIncidents({
      venueId: callerVenueId,
      status: filters.status ?? null,
      severity: filters.severity ?? null,
      category: filters.category ?? null,
      source: filters.source ?? null,
      since: filters.since ?? null,
      occurredBefore: filters.occurred_before ?? null,
      limit: filters.limit ?? 100,
    })
  } catch (err) {
    reqLog.error({ err }, 'admin.security.incidents.list_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/incidents',
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
      route: '/api/admin/security/incidents',
      action: AUDIT_ACTIONS.INCIDENT_REPORT_EXPORTED,
      targetTable: null,
      targetId: null,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        format,
        total: summary.counts.total,
        open: summary.counts.open,
        resolved_last_30d: summary.counts.resolvedLast30d,
      },
    })
    const headers = [
      'id',
      'title',
      'severity',
      'status',
      'category',
      'source',
      'detected_at',
      'opened_at',
      'mitigated_at',
      'resolved_at',
      'assigned_to',
      'opened_by',
      'related_resource_type',
      'related_resource_id',
      'external_reference',
    ]
    const rows: string[] = [headers.join(',')]
    for (const i of summary.incidents) {
      rows.push(
        [
          i.id,
          i.title,
          i.severity,
          i.status,
          i.category,
          i.source,
          i.detectedAt,
          i.openedAt,
          i.mitigatedAt ?? '',
          i.resolvedAt ?? '',
          i.assignedTo ?? '',
          i.openedBy ?? '',
          i.relatedResourceType ?? '',
          i.relatedResourceId ?? '',
          i.externalReference ?? '',
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
          'Content-Disposition': `attachment; filename="venuerise-incidents-${date}.csv"`,
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
    route: '/api/admin/security/incidents',
    op: 'admin.security.incidents.create',
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
    `admin:incident-create:${user.id}`,
    {
      route: '/api/admin/security/incidents',
      method: 'POST',
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

  // Owner/admin only for creation. requireAdmin already gates to
  // ADMIN_ROLES; this is the explicit tenant-scoped second gate
  // documented in RBAC-MATRIX.
  try {
    await requireVenueRole(user.id, callerVenueId, ['owner', 'admin'])
  } catch {
    // Cross-tenant 404 collapse pattern.
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  let body: z.infer<typeof CreateBodySchema>
  try {
    const raw = await request.json()
    const parsed = CreateBodySchema.safeParse(raw)
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

  const result = await createIncident({
    venueId: callerVenueId,
    title: body.title,
    description: body.description ?? null,
    severity: body.severity,
    category: body.category,
    source: body.source ?? 'manual',
    detectedAt: body.detected_at ?? null,
    relatedResourceType: body.related_resource_type ?? null,
    relatedResourceId: body.related_resource_id ?? null,
    externalReference: body.external_reference ?? null,
    metadata: body.metadata ?? null,
    openedBy: user.id,
  })
  if (!result.ok) {
    return respond(
      NextResponse.json(
        { error: result.code, detail: result.message },
        { status: result.code === 'validation_failed' ? 400 : 500 }
      )
    )
  }

  void recordAuditEvent({
    venueId: callerVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/security/incidents',
    action: AUDIT_ACTIONS.INCIDENT_CREATED,
    targetTable: 'incidents',
    targetId: result.incidentId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      severity: body.severity,
      category: body.category,
      source: body.source ?? 'manual',
    },
  })

  let alerts: Array<Record<string, unknown>> = []
  if (body.notify) {
    try {
      const statuses = await routeIncidentAlert(result.incident)
      alerts = statuses.map((s) => ({
        channel: s.channel,
        outcome: s.outcome,
        target: s.target,
      }))
      // Audit each non-skipped attempt.
      for (const s of statuses) {
        if (s.outcome === 'sent' || s.outcome === 'failed') {
          void recordAuditEvent({
            venueId: callerVenueId,
            actorUserId: user.id,
            actorKind: 'operator',
            route: '/api/admin/security/incidents',
            action: AUDIT_ACTIONS.INCIDENT_ALERT_SENT,
            targetTable: 'incidents',
            targetId: result.incidentId,
            requestId,
            ip: null,
            userAgent: null,
            metadata: {
              channel: s.channel,
              outcome: s.outcome,
              target: s.target,
            },
          })
        }
      }
    } catch (err) {
      reqLog.warn({ err }, 'admin.security.incidents.alert_failed')
    }
  }

  return respond(
    NextResponse.json({ ok: true, incidentId: result.incidentId, alerts })
  )
}
