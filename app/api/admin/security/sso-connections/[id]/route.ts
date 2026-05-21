import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAdmin } from '@/lib/auth/require-admin'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'

/**
 * /api/admin/security/sso-connections/[id]  (Phase 9G)
 *
 * PATCH  — update status / default_role / flags / metadata (OWNER ONLY).
 * DELETE — hard delete only when status is `draft` or `disabled`
 *          (OWNER ONLY). Active or pending connections can't be
 *          deleted via this route — flip status to `disabled` first.
 *          That keeps the audit chain intact for any in-flight login
 *          attempts the connection might have served.
 *
 * Owner-only enforcement layers:
 *   1. Application-side `requireVenueRole(['owner'])`.
 *   2. Migration 030 RLS UPDATE/DELETE policies bind to owner role.
 *
 * Either rejection produces a stable response; the RLS gate is
 * defense in depth.
 *
 * The PATCH body is intentionally NARROW — operators don't get to
 * change `domain`, `provider`, or `protocol` on an existing
 * connection. Re-keying those would invalidate any vendor
 * configuration tied to them. To change them, delete the draft +
 * create a new one.
 */

const PatchBodySchema = z
  .object({
    status: z.enum(['draft', 'pending', 'active', 'disabled']).optional(),
    default_role: z.enum(['viewer', 'coordinator']).optional(),
    jit_provisioning_enabled: z.boolean().optional(),
    scim_enabled: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (v) =>
      v.status !== undefined ||
      v.default_role !== undefined ||
      v.jit_provisioning_enabled !== undefined ||
      v.scim_enabled !== undefined ||
      v.metadata !== undefined,
    { message: 'at least one field is required' }
  )

interface RouteContext {
  params: Promise<{ id: string }>
}

interface ConnectionRow {
  id: string
  venue_id: string
  status: string
  default_role: string
  jit_provisioning_enabled: boolean
  scim_enabled: boolean
  metadata: Record<string, unknown>
}

// Tiny inline lookup so the type-loose pino child logger doesn't
// have to thread through a helper. Failures log against the
// module-level `log` directly.
async function resolveConnection(
  id: string,
  requestId: string
): Promise<ConnectionRow | null> {
  if (!z.string().uuid().safeParse(id).success) return null
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('sso_connections')
    .select(
      'id, venue_id, status, default_role, jit_provisioning_enabled, scim_enabled, metadata'
    )
    .eq('id', id)
    .maybeSingle()
  if (error) {
    log.error(
      { requestId, err: error, connectionId: id },
      'admin.sso.connections.lookup_failed'
    )
    return null
  }
  return (data as ConnectionRow | null) ?? null
}

export async function PATCH(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/sso-connections/[id]',
    op: 'admin.sso.connections.update',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  const { id } = await params

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(
    request,
    `admin:sso-connections-update:${user.id}`,
    {
      route: '/api/admin/security/sso-connections/[id]',
      method: 'PATCH',
      userId: user.id,
      venueId: callerVenueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const row = await resolveConnection(id, requestId)
  if (!row) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // Owner-only gate. Cross-tenant 403 → 404 collapse.
  try {
    await requireVenueRole(user.id, row.venue_id, ['owner'])
  } catch (err) {
    if (err instanceof TenantAccessError) {
      if (err.status === 403 && row.venue_id !== callerVenueId) {
        return respond(
          NextResponse.json({ error: 'not_found' }, { status: 404 })
        )
      }
      return respond(
        NextResponse.json({ error: err.code }, { status: err.status })
      )
    }
    throw err
  }

  const body = await request.json().catch(() => null)
  const parsed = PatchBodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  // Build before-snapshot for audit trail.
  const before = {
    status: row.status,
    default_role: row.default_role,
    jit_provisioning_enabled: row.jit_provisioning_enabled,
    scim_enabled: row.scim_enabled,
  }

  const patch: Record<string, unknown> = {}
  if (parsed.data.status !== undefined) patch.status = parsed.data.status
  if (parsed.data.default_role !== undefined) {
    patch.default_role = parsed.data.default_role
  }
  if (parsed.data.jit_provisioning_enabled !== undefined) {
    patch.jit_provisioning_enabled = parsed.data.jit_provisioning_enabled
  }
  if (parsed.data.scim_enabled !== undefined) {
    patch.scim_enabled = parsed.data.scim_enabled
  }
  if (parsed.data.metadata !== undefined) {
    // Shallow merge so operator can update one metadata field
    // without clobbering vendor-side state.
    patch.metadata = { ...(row.metadata ?? {}), ...parsed.data.metadata }
  }

  const svc = createServiceClient()
  const { data: updated, error: updateErr } = await svc
    .from('sso_connections')
    .update(patch)
    .eq('id', id)
    .select(
      'id, venue_id, provider, protocol, domain, status, default_role, jit_provisioning_enabled, scim_enabled, metadata, created_by, created_at, updated_at'
    )
    .single()

  if (updateErr) {
    reqLog.error(
      { err: updateErr, connectionId: id, venueId: row.venue_id },
      'admin.sso.connections.update_failed'
    )
    captureApiError(updateErr, {
      requestId,
      route: '/api/admin/security/sso-connections/[id]',
      userId: user.id,
      venueId: row.venue_id,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  void recordAuditEvent({
    venueId: row.venue_id,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/security/sso-connections/[id]',
    action: AUDIT_ACTIONS.SSO_CONNECTION_UPDATE,
    targetTable: 'sso_connections',
    targetId: id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    before,
    after: patch,
    metadata: { fields: Object.keys(patch) },
  })

  return respond(NextResponse.json({ item: updated }))
}

export async function DELETE(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/sso-connections/[id]',
    op: 'admin.sso.connections.delete',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  const { id } = await params

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user, venueId: callerVenueId } = admin

  const rl = await rateLimitUserAction(
    request,
    `admin:sso-connections-delete:${user.id}`,
    {
      route: '/api/admin/security/sso-connections/[id]',
      method: 'DELETE',
      userId: user.id,
      venueId: callerVenueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const row = await resolveConnection(id, requestId)
  if (!row) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // Owner-only gate.
  try {
    await requireVenueRole(user.id, row.venue_id, ['owner'])
  } catch (err) {
    if (err instanceof TenantAccessError) {
      if (err.status === 403 && row.venue_id !== callerVenueId) {
        return respond(
          NextResponse.json({ error: 'not_found' }, { status: 404 })
        )
      }
      return respond(
        NextResponse.json({ error: err.code }, { status: err.status })
      )
    }
    throw err
  }

  // Refuse to delete active/pending connections. The operator has
  // to flip to `disabled` first (separate PATCH). That preserves
  // audit context for any in-flight login attempts.
  if (row.status !== 'draft' && row.status !== 'disabled') {
    return respond(
      NextResponse.json(
        {
          error: 'conflict',
          detail:
            'Only draft or disabled connections can be deleted. Disable the connection first.',
        },
        { status: 409 }
      )
    )
  }

  const svc = createServiceClient()
  const { error: deleteErr } = await svc
    .from('sso_connections')
    .delete()
    .eq('id', id)
  if (deleteErr) {
    reqLog.error(
      { err: deleteErr, connectionId: id, venueId: row.venue_id },
      'admin.sso.connections.delete_failed'
    )
    captureApiError(deleteErr, {
      requestId,
      route: '/api/admin/security/sso-connections/[id]',
      userId: user.id,
      venueId: row.venue_id,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  void recordAuditEvent({
    venueId: row.venue_id,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/security/sso-connections/[id]',
    action: AUDIT_ACTIONS.SSO_CONNECTION_DELETE,
    targetTable: 'sso_connections',
    targetId: id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    before: {
      status: row.status,
      default_role: row.default_role,
      jit_provisioning_enabled: row.jit_provisioning_enabled,
      scim_enabled: row.scim_enabled,
    },
  })

  return respond(NextResponse.json({ success: true }))
}
