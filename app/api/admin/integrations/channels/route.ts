// Phase 8BE — Omnichannel inbox foundation.
//
// Audit coverage: GET lists channel posture (read-only, not
// audited — capability info is non-sensitive). POST creates a
// connection row and writes `channel_connection_created`.
//
// Rate-limited via adminIntegrations.channels{Read,Write}.

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
  createChannelConnection,
  listChannelConnections,
} from '@/lib/integrations/channels/connections'
// Phase 8BF — defend the metadata column against tokens/secrets
// and enforce the Meta-family allowlist (page id / IG business
// account / ad account / app id).
import { sanitizeChannelConnectionMetadata } from '@/lib/integrations/channels/meta-connections'
import {
  CHANNEL_CONNECTION_STATUSES,
  CHANNEL_TYPES,
  type ChannelConnectionStatus,
  type ChannelType,
} from '@/lib/integrations/channels/types'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

const CreateBodySchema = z.object({
  channel_type: z.enum(
    CHANNEL_TYPES as unknown as [ChannelType, ...ChannelType[]]
  ),
  external_account_label: z.string().max(200).optional().nullable(),
  external_account_id: z.string().max(200).optional().nullable(),
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

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/integrations/channels',
    op: 'admin.integrations.channels.list',
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
    `admin:integrations:channels:read:${user.id}`,
    {
      route: '/api/admin/integrations/channels',
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
    const summary = await listChannelConnections({ venueId: callerVenueId })
    return respond(NextResponse.json({ summary }))
  } catch (err) {
    reqLog.error({ err }, 'admin.integrations.channels.list_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/integrations/channels',
      userId: user.id,
      venueId: callerVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/integrations/channels',
    op: 'admin.integrations.channels.create',
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
      route: '/api/admin/integrations/channels',
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

  // Owner/admin gate. Mirrors the commitments / SSO posture.
  try {
    await requireVenueRole(user.id, callerVenueId, ['owner', 'admin'])
  } catch {
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

  const sanitized = sanitizeChannelConnectionMetadata(
    body.metadata ?? null,
    body.channel_type
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
  const result = await createChannelConnection({
    venueId: callerVenueId,
    channelType: body.channel_type,
    status: body.status,
    externalAccountLabel: body.external_account_label,
    externalAccountId: body.external_account_id,
    metadata: sanitized.metadata,
    createdBy: user.id,
  })
  if (!result.ok) {
    return respond(
      NextResponse.json(
        { error: result.code, detail: result.message },
        { status: result.code === 'validation_failed' ? 400 : result.code === 'duplicate' ? 409 : 500 }
      )
    )
  }

  void recordAuditEvent({
    venueId: callerVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/integrations/channels',
    action: AUDIT_ACTIONS.CHANNEL_CONNECTION_CREATED,
    targetTable: 'venue_channel_connections',
    targetId: result.connection.id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      channel_type: body.channel_type,
      status: body.status ?? 'draft',
    },
  })

  return respond(
    NextResponse.json({ ok: true, connection: result.connection })
  )
}
