import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { log } from '@/lib/log'
import {
  getCurrentVenueForUser,
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { removeMember, TeamError } from '@/lib/team/team-service'

/**
 * DELETE /api/team/members/[userId] — owner/admin removes a member.
 *
 * Refuses to remove the last owner of the venue (whether the caller is
 * targeting themselves or another owner).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/team/members/[userId]' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const { userId: targetUserId } = await params
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
    await removeMember({
      userId: user.id,
      venueId: venue.venueId,
      targetUserId,
      supabase,
      requestId,
    })
    return respond(NextResponse.json({ success: true }))
  } catch (err) {
    if (err instanceof TeamError) {
      return respond(
        NextResponse.json({ error: err.code, detail: err.detail }, { status: err.status })
      )
    }
    reqLog.error({ err, targetUserId }, 'team.member.remove_unexpected')
    captureApiError(err, {
      requestId,
      route: '/api/team/members/[userId]',
      userId: user.id,
      venueId: venue.venueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
}
