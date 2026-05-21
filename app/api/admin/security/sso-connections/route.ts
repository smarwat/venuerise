import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAdmin } from '@/lib/auth/require-admin'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import { normalizeEmailDomain } from '@/lib/enterprise/sso/domain'

/**
 * /api/admin/security/sso-connections  (Phase 9G)
 *
 * GET  — list SSO connections for a venue (admin/owner SELECT).
 * POST — create a draft SSO connection (OWNER ONLY).
 *
 * The owner-only POST gate is deliberate: SSO configuration
 * controls who can log in at all. Admin role is too permissive
 * for this surface. The check happens TWICE — once via
 * `requireVenueRole(['owner'])` in the route, once via the
 * migration 030 INSERT RLS policy. Either rejection produces a
 * stable error response.
 *
 * The created connection lands as `status='draft'` regardless of
 * what the operator passed. Flipping to `active` requires a
 * separate PATCH, which goes through the per-connection sibling
 * route.
 *
 * Cross-tenant `venue_id` collapses 403 → 404 per the standard
 * admin posture.
 */

const ListQuerySchema = z.object({
  venue_id: z.string().uuid().optional(),
})

const CreateBodySchema = z.object({
  venue_id: z.string().uuid().optional(),
  provider: z.enum(['workos', 'clerk', 'stytch', 'supabase_sso', 'custom_oidc']),
  protocol: z.enum(['saml', 'oidc']),
  domain: z.string().min(1).max(253),
  // Operator may optionally pre-set these on draft. Default role
  // is constrained to lowest-privilege by the schema below + by
  // the migration 030 CHECK constraint.
  default_role: z.enum(['viewer', 'coordinator']).optional(),
  jit_provisioning_enabled: z.boolean().optional(),
  scim_enabled: z.boolean().optional(),
})

interface SsoConnectionRow {
  id: string
  venue_id: string
  provider: string
  protocol: string
  domain: string
  status: string
  default_role: string
  jit_provisioning_enabled: boolean
  scim_enabled: boolean
  metadata: Record<string, unknown>
  created_by: string | null
  created_at: string
  updated_at: string
}

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/sso-connections',
    op: 'admin.sso.connections.list',
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
    `admin:sso-connections-list:${user.id}`,
    {
      route: '/api/admin/security/sso-connections',
      method: 'GET',
      userId: user.id,
      venueId: callerVenueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const url = new URL(request.url)
  const parsed = ListQuerySchema.safeParse({
    venue_id: url.searchParams.get('venue_id') ?? undefined,
  })
  if (!parsed.success) {
    return respond(
      NextResponse.json({ error: 'validation_failed' }, { status: 400 })
    )
  }
  const targetVenueId = parsed.data.venue_id ?? callerVenueId

  if (targetVenueId !== callerVenueId) {
    try {
      await requireVenueRole(user.id, targetVenueId, ADMIN_ROLES)
    } catch (err) {
      if (err instanceof TenantAccessError) {
        if (err.status === 403) {
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
  }

  const svc = createServiceClient()
  const { data: rowsRaw, error: queryErr } = await svc
    .from('sso_connections')
    .select(
      'id, venue_id, provider, protocol, domain, status, default_role, jit_provisioning_enabled, scim_enabled, metadata, created_by, created_at, updated_at'
    )
    .eq('venue_id', targetVenueId)
    .order('updated_at', { ascending: false })

  if (queryErr) {
    reqLog.error(
      { err: queryErr, venueId: targetVenueId },
      'admin.sso.connections.list_failed'
    )
    captureApiError(queryErr, {
      requestId,
      route: '/api/admin/security/sso-connections',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  const items = (rowsRaw ?? []) as SsoConnectionRow[]
  return respond(NextResponse.json({ items }))
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/security/sso-connections',
    op: 'admin.sso.connections.create',
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
    `admin:sso-connections-create:${user.id}`,
    {
      route: '/api/admin/security/sso-connections',
      method: 'POST',
      userId: user.id,
      venueId: callerVenueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const body = await request.json().catch(() => null)
  const parsed = CreateBodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  const targetVenueId = parsed.data.venue_id ?? callerVenueId

  // OWNER-ONLY gate. SSO config controls who can log in; admin
  // role is too permissive.
  try {
    await requireVenueRole(user.id, targetVenueId, ['owner'])
  } catch (err) {
    if (err instanceof TenantAccessError) {
      // Cross-tenant 403 → 404 collapse. Same-tenant non-owner
      // gets the standard `forbidden` code so the UI can show a
      // "requires owner role" message.
      if (err.status === 403 && targetVenueId !== callerVenueId) {
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

  const normalizedDomain = normalizeEmailDomain(parsed.data.domain)
  if (!normalizedDomain) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: 'invalid domain' },
        { status: 400 }
      )
    )
  }

  const row = {
    venue_id: targetVenueId,
    provider: parsed.data.provider,
    protocol: parsed.data.protocol,
    domain: normalizedDomain,
    // Force draft on create regardless of input. Activation is a
    // separate PATCH.
    status: 'draft',
    default_role: parsed.data.default_role ?? 'viewer',
    jit_provisioning_enabled: parsed.data.jit_provisioning_enabled ?? false,
    scim_enabled: parsed.data.scim_enabled ?? false,
    metadata: {},
    created_by: user.id,
  }

  const svc = createServiceClient()
  const { data: created, error: insertErr } = await svc
    .from('sso_connections')
    .insert(row)
    .select(
      'id, venue_id, provider, protocol, domain, status, default_role, jit_provisioning_enabled, scim_enabled, metadata, created_by, created_at, updated_at'
    )
    .single()

  if (insertErr) {
    // Unique constraint violation (one connection per (venue, domain))
    // surfaces as a friendlier error.
    const code = insertErr.code
    if (code === '23505') {
      return respond(
        NextResponse.json(
          {
            error: 'conflict',
            detail: 'A connection already exists for this domain.',
          },
          { status: 409 }
        )
      )
    }
    reqLog.error(
      { err: insertErr, venueId: targetVenueId, domain: normalizedDomain },
      'admin.sso.connections.insert_failed'
    )
    captureApiError(insertErr, {
      requestId,
      route: '/api/admin/security/sso-connections',
      userId: user.id,
      venueId: targetVenueId,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  const createdRow = created as SsoConnectionRow

  reqLog.info(
    {
      userId: user.id,
      venueId: targetVenueId,
      connectionId: createdRow.id,
      domain: normalizedDomain,
      provider: createdRow.provider,
      protocol: createdRow.protocol,
    },
    'admin.sso.connections.created'
  )

  void recordAuditEvent({
    venueId: targetVenueId,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/security/sso-connections',
    action: AUDIT_ACTIONS.SSO_CONNECTION_CREATE,
    targetTable: 'sso_connections',
    targetId: createdRow.id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    after: {
      provider: createdRow.provider,
      protocol: createdRow.protocol,
      domain: createdRow.domain,
      status: createdRow.status,
      default_role: createdRow.default_role,
      jit_provisioning_enabled: createdRow.jit_provisioning_enabled,
      scim_enabled: createdRow.scim_enabled,
    },
  })

  return respond(
    NextResponse.json({ item: createdRow }, { status: 201 })
  )
}
