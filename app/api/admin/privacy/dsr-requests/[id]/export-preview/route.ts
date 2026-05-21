// Audit coverage: POST writes `dsr_export_previewed`. The
// preview is METADATA-ONLY — no subject data is fetched or
// returned. Appends an `export_prepared` timeline event so the
// DSR record carries the trail.

import { NextRequest, NextResponse } from 'next/server'
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
  appendDsrTimelineEvent,
  getDsrRequestWithTimeline,
} from '@/lib/enterprise/privacy/dsr'
import { buildDsrExportPreview } from '@/lib/enterprise/privacy/export-preview'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

type RouteContext = { params: Promise<{ id: string }> }

async function loadParams(ctx: RouteContext): Promise<{ id: string }> {
  return ctx.params
}

export async function POST(
  request: NextRequest,
  ctx: RouteContext
): Promise<Response> {
  const { id } = await loadParams(ctx)
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/privacy/dsr-requests/[id]/export-preview',
    op: 'admin.privacy.dsr.export_preview',
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
    `admin:dsr-export-preview:${user.id}`,
    {
      route: '/api/admin/privacy/dsr-requests/[id]/export-preview',
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

  try {
    const { request: dsr } = await getDsrRequestWithTimeline(id)
    if (!dsr) {
      return respond(
        NextResponse.json({ error: 'not_found' }, { status: 404 })
      )
    }
    if (dsr.venueId && dsr.venueId !== callerVenueId) {
      return respond(
        NextResponse.json({ error: 'not_found' }, { status: 404 })
      )
    }

    const preview = await buildDsrExportPreview({
      dsrRequestId: dsr.id,
      subjectEmail: dsr.subjectEmail,
      subjectUserId: dsr.subjectUserId,
    })

    void appendDsrTimelineEvent({
      dsrRequestId: dsr.id,
      eventType: 'export_prepared',
      actorUserId: user.id,
      message: `Export preview generated (${preview.items.length} categor${preview.items.length === 1 ? 'y' : 'ies'} in scope, ${preview.excludedRestricted.length} restricted excluded).`,
      metadata: {
        items: preview.items.length,
        excluded_restricted: preview.excludedRestricted.length,
      },
    })

    void recordAuditEvent({
      venueId: callerVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/privacy/dsr-requests/[id]/export-preview',
      action: AUDIT_ACTIONS.DSR_EXPORT_PREVIEWED,
      targetTable: 'dsr_requests',
      targetId: id,
      requestId,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: {
        items: preview.items.length,
        excluded_restricted: preview.excludedRestricted.length,
      },
    })

    return respond(NextResponse.json({ preview }))
  } catch (err) {
    reqLog.error({ err }, 'admin.privacy.dsr.export_preview_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/privacy/dsr-requests/[id]/export-preview',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}
