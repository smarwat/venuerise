// Audit coverage: GET is operator-internal preview (NOT
// audited). Markdown export emits a `trust_packet_exported`
// audit row so the trail of "who exported the packet" stays
// intact.

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
  buildTrustPacket,
  renderTrustPacketMarkdown,
} from '@/lib/enterprise/trust-center/artifacts'
import {
  TRUST_ACCESS_SCOPES,
  type TrustAccessScope,
} from '@/lib/enterprise/trust-center/types'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

const QuerySchema = z.object({
  scope: z
    .enum(TRUST_ACCESS_SCOPES as unknown as [TrustAccessScope, ...TrustAccessScope[]])
    .optional(),
  format: z.enum(['json', 'markdown']).optional(),
})

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/trust-center/packet',
    op: 'admin.security.trust_packet.preview',
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
    `admin:trust-packet-preview:${user.id}`,
    {
      route: '/api/admin/security/trust-center/packet',
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
    scope: url.searchParams.get('scope') ?? undefined,
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
  const scope = parsed.data.scope ?? 'standard_packet'
  const format = parsed.data.format ?? 'json'

  let packet
  try {
    packet = await buildTrustPacket(scope)
  } catch (err) {
    reqLog.error({ err }, 'admin.security.trust_packet.build_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/trust-center/packet',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  if (format === 'markdown') {
    void recordAuditEvent({
      venueId: callerVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/security/trust-center/packet',
      action: AUDIT_ACTIONS.TRUST_PACKET_EXPORTED,
      targetTable: null,
      targetId: null,
      requestId,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: { scope, included: packet.counts.included },
    })
    const date = new Date().toISOString().slice(0, 10)
    return respond(
      new NextResponse(renderTrustPacketMarkdown(packet), {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="venuerise-trust-packet-${scope}-${date}.md"`,
          'Cache-Control': 'no-store',
        },
      })
    )
  }

  return respond(NextResponse.json({ packet }))
}
