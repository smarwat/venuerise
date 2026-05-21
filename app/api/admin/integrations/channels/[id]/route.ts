// Phase 8BE — Channel connection PATCH endpoint.
//
// Audit coverage: writes `channel_connection_updated` on success.
// Cross-tenant access collapses to 404 to match the rest of the
// admin posture.

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
  getChannelConnection,
  updateChannelConnection,
} from '@/lib/integrations/channels/connections'
// Phase 8BF — strip secrets/tokens + enforce Meta-family allowlist.
import { sanitizeChannelConnectionMetadata } from '@/lib/integrations/channels/meta-connections'
import {
  CHANNEL_CONNECTION_STATUSES,
  type ChannelConnectionStatus,
} from '@/lib/integrations/channels/types'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

const PatchBodySchema = z.object({
  external_account_label: z.string().max(200).optional().nullable(),
  status: z
    .enum(
      CHANNEL_CONNECTION_STATUSES as unknown as [
        ChannelConnectionStatus,
        ...ChannelConnectionStatus[],
      ]
    )
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
})

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/integrations/channels/[id]',
    op: 'admin.integrations.channels.update',
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
    `admin:integrations:channels:write:${user.id}`,
    {
      route: '/api/admin/integrations/channels/[id]',
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

  const { id } = await context.params

  // Cross-tenant guard: 404 when the row exists but belongs to
  // a different venue.
  const existing = await getChannelConnection(id)
  if (!existing || existing.venueId !== callerVenueId) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

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

  // Phase 8BF — sanitize metadata against the existing
  // connection's channel_type. Reject submissions that try to
  // sneak in a token/secret-shaped key; silently drop unknown
  // keys for Meta-family channels so a UI typo doesn't bloat
  // the row.
  let sanitizedMetadata: Record<string, unknown> | null | undefined
  if (body.metadata !== undefined) {
    const sanitized = sanitizeChannelConnectionMetadata(
      body.metadata ?? null,
      existing.channelType
    )
    if (sanitized.forbiddenKeys.length > 0) {
      return respond(
        NextResponse.json(
          {
            error: 'forbidden_metadata_key',
            detail: `Tokens / secrets are configured server-side only. Forbidden keys rejected: ${sanitized.forbiddenKeys.join(', ')}`,
          },
          { status: 400 }
        )
      )
    }
    sanitizedMetadata = sanitized.metadata
  }
  const result = await updateChannelConnection({
    connectionId: id,
    externalAccountLabel: body.external_account_label,
    status: body.status,
    metadata: sanitizedMetadata ?? null,
    actorUserId: user.id,
  })
  if (!result.ok) {
    const status =
      result.code === 'not_found'
        ? 404
        : result.code === 'validation_failed'
          ? 400
          : 500
    if (status === 500) {
      captureApiError(new Error(result.message), {
        requestId,
        route: '/api/admin/integrations/channels/[id]',
        userId: user.id,
        venueId: callerVenueId,
      })
    }
    return respond(
      NextResponse.json(
        { error: result.code, detail: result.message },
        { status }
      )
    )
  }

  void recordAuditEvent({
    venueId: callerVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/integrations/channels/[id]',
    action: AUDIT_ACTIONS.CHANNEL_CONNECTION_UPDATED,
    targetTable: 'venue_channel_connections',
    targetId: id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      channel_type: existing.channelType,
      previous_status: existing.status,
      next_status: result.connection.status,
    },
  })

  return respond(
    NextResponse.json({ ok: true, connection: result.connection })
  )
}
