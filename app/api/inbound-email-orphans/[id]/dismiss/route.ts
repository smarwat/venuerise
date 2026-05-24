// Phase 8BQ — Dismiss an unmatched inbound email orphan.
//
// Operator-initiated. Flips the orphan to status='dismissed'
// with a reason. Does NOT delete the row — kept for audit +
// future re-link if the operator changes their mind.
//
// Audit coverage: writes recordAuditEvent in the success path.
// Rate-limit: per-user-per-orphan via inboundEmailOrphan.dismiss.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requireVenueRole } from '@/lib/auth/tenant-access'
import { SALES_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'

const BodySchema = z.object({
  reason: z
    .enum(['spam', 'wrong_venue', 'duplicate', 'not_relevant', 'auto_responder', 'other'])
    .default('other'),
})

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/inbound-email-orphans/[id]/dismiss',
    op: 'inbound-email-orphans.dismiss',
  })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const { id: orphanId } = await params
  if (!z.string().uuid().safeParse(orphanId).success) {
    return respond(
      NextResponse.json({ error: 'orphan_id must be a UUID' }, { status: 400 })
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) {
    return respond(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))
  }

  const body = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  const rl = await rateLimitUserAction(
    request,
    `inbound-email-orphan:dismiss:${user.id}:${orphanId}`,
    {
      route: '/api/inbound-email-orphans/[id]/dismiss',
      method: 'POST',
      userId: user.id,
      requestId,
    }
  )
  if (!rl.allowed) {
    return respond(rateLimitedResponse(rl))
  }

  // 1. Load the orphan via service-role; venue check next.
  const svc = createServiceClient()
  const { data: orphanRow, error: orphanErr } = await svc
    .from('inbound_email_orphans')
    .select(
      'id, channel, venue_id, status, provider, provider_inbound_id, match_confidence'
    )
    .eq('id', orphanId)
    .maybeSingle()
  if (orphanErr || !orphanRow) {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  const orphan = orphanRow as {
    id: string
    channel: 'email' | 'sms' | null
    venue_id: string | null
    status: string
    provider: string
    provider_inbound_id: string | null
    match_confidence: number
  }
  const channel: 'email' | 'sms' = orphan.channel ?? 'email'

  if (orphan.status !== 'unresolved') {
    return respond(
      NextResponse.json(
        { error: 'already_resolved', status: orphan.status },
        { status: 409 }
      )
    )
  }

  // 2. Platform-orphan (no venue) — refuse from the operator
  //    surface.
  if (!orphan.venue_id) {
    return respond(
      NextResponse.json({ error: 'orphan_unscoped' }, { status: 403 })
    )
  }

  // 3. Venue membership check.
  try {
    await requireVenueRole(user.id, orphan.venue_id, SALES_ROLES)
  } catch {
    return respond(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // 4. Update.
  await svc
    .from('inbound_email_orphans')
    .update({
      status: 'dismissed',
      dismissed_at: new Date().toISOString(),
      dismissed_by: user.id,
      dismiss_reason: parsed.data.reason,
    })
    .eq('id', orphanId)

  void recordAuditEvent({
    venueId: orphan.venue_id,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/inbound-email-orphans/[id]/dismiss',
    action: AUDIT_ACTIONS.INBOUND_EMAIL_ORPHAN_DISMISSED,
    targetTable: 'inbound_email_orphans',
    targetId: orphanId,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    metadata: {
      orphan_id: orphanId,
      channel,
      reason: parsed.data.reason,
      match_confidence: orphan.match_confidence,
      provider: orphan.provider,
      provider_inbound_id_present: !!orphan.provider_inbound_id,
    },
  })

  reqLog.info(
    { orphanId, reason: parsed.data.reason },
    'inbound-email-orphans.dismiss.completed'
  )

  return respond(
    NextResponse.json({
      ok: true,
      orphan_id: orphanId,
      status: 'dismissed',
      reason: parsed.data.reason,
    })
  )
}
