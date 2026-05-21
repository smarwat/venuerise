// Audit coverage: GET lists access events for the venue. CSV
// export is audited via `trust_access_events_exported`; JSON
// refresh is not.

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
import { listTrustAccessEvents } from '@/lib/enterprise/trust-center/access'
import type { TrustAccessEventType } from '@/lib/enterprise/trust-center/types'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

const EVENT_TYPES: ReadonlyArray<TrustAccessEventType> = [
  'grant_created',
  'grant_revoked',
  'grant_accessed',
  'artifact_downloaded',
  'grant_expired',
  'access_denied',
]

const ListQuerySchema = z.object({
  grant_id: z.string().uuid().optional(),
  event_type: z
    .enum(EVENT_TYPES as unknown as [TrustAccessEventType, ...TrustAccessEventType[]])
    .optional(),
  since: z.string().datetime().optional(),
  occurred_before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  format: z.enum(['json', 'csv']).optional(),
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
    route: '/api/admin/security/trust-center/access-events',
    op: 'admin.security.trust_access_events.list',
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
    `admin:trust-access-events:${user.id}`,
    {
      route: '/api/admin/security/trust-center/access-events',
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
  const parsed = ListQuerySchema.safeParse({
    grant_id: url.searchParams.get('grant_id') ?? undefined,
    event_type: url.searchParams.get('event_type') ?? undefined,
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
    summary = await listTrustAccessEvents({
      venueId: callerVenueId,
      grantId: filters.grant_id ?? null,
      eventType: filters.event_type ?? null,
      since: filters.since ?? null,
      occurredBefore: filters.occurred_before ?? null,
      limit: filters.limit ?? 100,
    })
  } catch (err) {
    reqLog.error({ err }, 'admin.security.trust_access_events.list_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/trust-center/access-events',
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
      route: '/api/admin/security/trust-center/access-events',
      action: AUDIT_ACTIONS.TRUST_ACCESS_EVENTS_EXPORTED,
      targetTable: null,
      targetId: null,
      requestId,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: { event_count: summary.events.length },
    })
    const headers = [
      'id',
      'grant_id',
      'event_type',
      'artifact_type',
      'format',
      'ip_hash',
      'user_agent_hash',
      'created_at',
    ]
    const rows: string[] = [headers.join(',')]
    for (const e of summary.events) {
      rows.push(
        [
          e.id,
          e.grantId ?? '',
          e.eventType,
          e.artifactType ?? '',
          e.format ?? '',
          e.ipHash ?? '',
          e.userAgentHash ?? '',
          e.createdAt,
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
          'Content-Disposition': `attachment; filename="venuerise-trust-access-events-${date}.csv"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }

  return respond(NextResponse.json({ summary }))
}
