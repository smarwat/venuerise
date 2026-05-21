// Audit coverage: GET lists grants (NOT audited). POST creates
// a new bearer grant and writes a `trust_access_grant_created`
// audit row. The plaintext token is returned ONCE in the
// response — operators must save the URL before the response
// scrolls off; we never log it.

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
  createTrustAccessGrant,
  listTrustAccessGrants,
} from '@/lib/enterprise/trust-center/access'
import {
  TRUST_ACCESS_SCOPES,
  type TrustAccessScope,
  type TrustAccessStatus,
} from '@/lib/enterprise/trust-center/types'
import {
  DEFAULT_GRANT_EXPIRY_DAYS,
  MAX_GRANT_EXPIRY_DAYS,
} from '@/lib/enterprise/trust-center/policy'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

const ListQuerySchema = z.object({
  status: z
    .enum(['active', 'expired', 'revoked'] as unknown as [
      TrustAccessStatus,
      ...TrustAccessStatus[],
    ])
    .optional(),
  buyer_email: z.string().email().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

const CreateBodySchema = z.object({
  buyer_name: z.string().max(200).optional().nullable(),
  buyer_email: z.string().email().max(320).optional().nullable(),
  buyer_company: z.string().max(200).optional().nullable(),
  scope: z
    .enum(TRUST_ACCESS_SCOPES as unknown as [TrustAccessScope, ...TrustAccessScope[]])
    .optional(),
  expires_in_days: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_GRANT_EXPIRY_DAYS)
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
})

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/trust-center/grants',
    op: 'admin.security.trust_grant.list',
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
    `admin:trust-grant-list:${user.id}`,
    {
      route: '/api/admin/security/trust-center/grants',
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
    status: url.searchParams.get('status') ?? undefined,
    buyer_email: url.searchParams.get('buyer_email') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
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
  try {
    const summary = await listTrustAccessGrants({
      venueId: callerVenueId,
      status: filters.status ?? null,
      buyerEmail: filters.buyer_email ?? null,
      limit: filters.limit ?? 100,
    })
    return respond(NextResponse.json({ summary }))
  } catch (err) {
    reqLog.error({ err }, 'admin.security.trust_grant.list_failed')
    captureApiError(err, {
      requestId,
      route: '/api/admin/security/trust-center/grants',
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
    route: '/api/admin/security/trust-center/grants',
    op: 'admin.security.trust_grant.create',
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
    `admin:trust-grant-create:${user.id}`,
    {
      route: '/api/admin/security/trust-center/grants',
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

  const result = await createTrustAccessGrant({
    venueId: callerVenueId,
    buyerName: body.buyer_name,
    buyerEmail: body.buyer_email,
    buyerCompany: body.buyer_company,
    scope: body.scope,
    expiresInDays: body.expires_in_days ?? DEFAULT_GRANT_EXPIRY_DAYS,
    metadata: body.metadata,
    createdBy: user.id,
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
    route: '/api/admin/security/trust-center/grants',
    action: AUDIT_ACTIONS.TRUST_ACCESS_GRANT_CREATED,
    targetTable: 'trust_access_grants',
    targetId: result.grantId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      scope: body.scope ?? 'standard_packet',
      expires_in_days: body.expires_in_days ?? DEFAULT_GRANT_EXPIRY_DAYS,
      buyer_email: body.buyer_email ?? null,
    },
  })

  // IMPORTANT: the plaintext token is returned ONCE here. The
  // operator must save the URL. Subsequent reads of the grant
  // never expose the token.
  return respond(
    NextResponse.json({
      ok: true,
      grantId: result.grantId,
      token: result.token,
      url: result.url,
      expiresAt: result.expiresAt,
      warning:
        'Bearer link: anyone with this URL can access the packet until expiry or revocation. Save it now — it will NOT be shown again.',
    })
  )
}
