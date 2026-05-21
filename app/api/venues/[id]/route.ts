import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { requireVenueRole, TenantAccessError } from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { z } from 'zod'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'

const UpdateVenueSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional().nullable(),
  capacity_min: z.number().int().min(1).optional().nullable(),
  capacity_max: z.number().int().min(1).optional().nullable(),
  base_price: z.number().min(0).optional().nullable(),
  price_per_guest: z.number().min(0).optional().nullable(),
  style_tags: z.array(z.string()).optional(),
  amenities: z.array(z.string()).optional(),
  timezone: z.string().optional(),
  ai_persona_name: z.string().min(1).max(50).optional(),
  ai_tone: z.string().optional(),
  response_time_target: z.number().int().min(1).optional(),
})

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  // Phase 6B: any member can read venue settings.
  const { data, error } = await supabase
    .from('venues')
    .select('*')
    .eq('id', id)
    .single()

  if (error) return respond(NextResponse.json({ error: error.message }, { status: 404 }))
  return respond(NextResponse.json(data))
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

  // Phase 6B: ADMIN_ROLES only — venue settings are sensitive.
  try {
    await requireVenueRole(user.id, id, ADMIN_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return respond(NextResponse.json({ error: err.code }, { status: err.status }))
    }
    throw err
  }

  // Phase 9F — per-user rate limit.
  const rl = await rateLimitUserAction(
    request,
    `venues:update:${user.id}`,
    {
      route: '/api/venues/[id]',
      method: 'PATCH',
      userId: user.id,
      venueId: id,
      requestId,
    }
  )
  if (!rl.allowed) {
    log.warn(
      { requestId, userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  const body = await request.json()
  const parsed = UpdateVenueSchema.safeParse(body)
  if (!parsed.success) return respond(NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }))

  const { data, error } = await supabase
    .from('venues')
    .update(parsed.data)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    captureApiError(error, { requestId, route: '/api/venues/[id]', venueId: id, userId: user.id })
    return respond(NextResponse.json({ error: error.message }, { status: 500 }))
  }

  // Phase 9A — best-effort audit row. Only the patched field
  // names land in metadata; we don't echo the full venue row
  // (would be PII-heavy).
  void recordAuditEvent({
    venueId: id,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/venues/[id]',
    action: 'venue_update',
    targetTable: 'venues',
    targetId: id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: { fields: Object.keys(parsed.data) },
  })

  return respond(NextResponse.json(data))
}
