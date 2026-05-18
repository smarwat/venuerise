import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { log } from '@/lib/log'
import { getCurrentVenueForUser } from '@/lib/auth/tenant-access'
import { listMembers, TeamError } from '@/lib/team/team-service'

/**
 * GET /api/team/members — list members of the caller's current venue.
 *
 * Any member can view (the RLS policy already grants `select` to siblings).
 */
export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/team/members' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return respond(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

  const venue = await getCurrentVenueForUser(user.id)
  if (!venue) return respond(NextResponse.json({ error: 'no_venue' }, { status: 404 }))

  try {
    const items = await listMembers({ venueId: venue.venueId, supabase })
    return respond(NextResponse.json({ items }))
  } catch (err) {
    if (err instanceof TeamError) {
      return respond(NextResponse.json({ error: err.code }, { status: err.status }))
    }
    reqLog.error({ err }, 'team.members.list_failed')
    captureApiError(err, { requestId, route: '/api/team/members', userId: user.id })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
}
