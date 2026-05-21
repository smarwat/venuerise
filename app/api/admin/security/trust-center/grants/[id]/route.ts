// Audit coverage: PATCH writes a typed audit row:
// `trust_access_grant_revoked` when status moves to revoked;
// `trust_access_grant_updated` for buyer metadata changes.

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
import { updateTrustAccessGrant } from '@/lib/enterprise/trust-center/access'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

const PatchBodySchema = z.object({
  revoke: z.boolean().optional(),
  buyer_name: z.string().max(200).nullable().optional(),
  buyer_email: z.string().email().max(320).nullable().optional(),
  buyer_company: z.string().max(200).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})

type RouteContext = { params: Promise<{ id: string }> }

async function loadParams(ctx: RouteContext): Promise<{ id: string }> {
  return ctx.params
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext
): Promise<Response> {
  const { id } = await loadParams(ctx)
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/trust-center/grants/[id]',
    op: 'admin.security.trust_grant.update',
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
    `admin:trust-grant-update:${user.id}`,
    {
      route: '/api/admin/security/trust-center/grants/[id]',
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

  const result = await updateTrustAccessGrant({
    grantId: id,
    revoke: body.revoke,
    buyerName: body.buyer_name,
    buyerEmail: body.buyer_email,
    buyerCompany: body.buyer_company,
    metadata: body.metadata,
    actorUserId: user.id,
  })
  if (!result.ok) {
    const status =
      result.code === 'not_found'
        ? 404
        : result.code === 'validation_failed'
          ? 400
          : 500
    return respond(
      NextResponse.json(
        { error: result.code, detail: result.message },
        { status }
      )
    )
  }

  // Cross-tenant collapse: if the grant belonged to another
  // venue, the update would have already succeeded but we
  // should reject downstream.
  if (result.grant.venueId && result.grant.venueId !== callerVenueId) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  try {
    void recordAuditEvent({
      venueId: callerVenueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/admin/security/trust-center/grants/[id]',
      action: result.revoked
        ? AUDIT_ACTIONS.TRUST_ACCESS_GRANT_REVOKED
        : AUDIT_ACTIONS.TRUST_ACCESS_GRANT_UPDATED,
      targetTable: 'trust_access_grants',
      targetId: id,
      requestId,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: { revoked: Boolean(body.revoke) },
    })
  } catch (err) {
    reqLog.warn({ err }, 'admin.security.trust_grant.audit_failed')
    captureApiError(err)
  }

  return respond(
    NextResponse.json({ ok: true, grant: { ...result.grant, tokenHash: undefined } })
  )
}
