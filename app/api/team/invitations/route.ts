import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { log } from '@/lib/log'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import {
  getCurrentVenueForUser,
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { createInvitation, listInvitations, TeamError } from '@/lib/team/team-service'
import { InviteTeamMemberSchema } from '@/lib/team/team-schema'

/**
 * POST /api/team/invitations — owner/admin invites a teammate.
 * GET  /api/team/invitations — owner/admin lists invitations on their venue.
 */

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/team/invitations' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

  const rl = await rateLimitUserAction(request, `team:invite:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const venue = await getCurrentVenueForUser(user.id)
  if (!venue) return respond(NextResponse.json({ error: 'no_venue' }, { status: 404 }))

  try {
    await requireVenueRole(user.id, venue.venueId, ADMIN_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return respond(NextResponse.json({ error: err.code }, { status: err.status }))
    }
    throw err
  }

  const body = await request.json().catch(() => null)
  const parsed = InviteTeamMemberSchema.safeParse(body)
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  // Optional venue name lookup for nicer email body.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('name')
    .eq('id', venue.venueId)
    .maybeSingle()
  const venueName = (venueRow as { name?: string } | null)?.name ?? null

  try {
    const result = await createInvitation({
      userId: user.id,
      venueId: venue.venueId,
      email: parsed.data.email,
      role: parsed.data.role,
      venueName,
      supabase,
      requestId,
    })
    return respond(
      NextResponse.json(
        {
          success: true,
          invitation_id: result.invitation_id,
          email_sent: result.email_sent,
          rotated: result.rotated,
        },
        { status: 201 }
      )
    )
  } catch (err) {
    if (err instanceof TeamError) {
      return respond(
        NextResponse.json({ error: err.code, detail: err.detail }, { status: err.status })
      )
    }
    reqLog.error({ err }, 'team.invitation.unexpected')
    captureApiError(err, { requestId, route: '/api/team/invitations', userId: user.id })
    const message = err instanceof Error ? err.message : 'unexpected_error'
    return respond(NextResponse.json({ error: message }, { status: 500 }))
  }
}

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/team/invitations' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

  const venue = await getCurrentVenueForUser(user.id)
  if (!venue) return respond(NextResponse.json({ error: 'no_venue' }, { status: 404 }))

  try {
    await requireVenueRole(user.id, venue.venueId, ADMIN_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return respond(NextResponse.json({ error: err.code }, { status: err.status }))
    }
    throw err
  }

  try {
    const items = await listInvitations({ venueId: venue.venueId, supabase })
    return respond(NextResponse.json({ items }))
  } catch (err) {
    if (err instanceof TeamError) {
      return respond(NextResponse.json({ error: err.code }, { status: err.status }))
    }
    reqLog.error({ err }, 'team.invitation.list_failed')
    captureApiError(err, { requestId, route: '/api/team/invitations', userId: user.id })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
}
