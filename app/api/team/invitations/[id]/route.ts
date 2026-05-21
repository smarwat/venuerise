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
import { revokeInvitation, TeamError } from '@/lib/team/team-service'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'

/**
 * DELETE /api/team/invitations/[id] — owner/admin revokes a pending invite.
 *
 * Soft-revoke: sets `revoked_at`. Accept attempts after this return 410.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/team/invitations/[id]' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const { id } = await params
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

  // Phase 9F — per-user rate limit.
  const rl = await rateLimitUserAction(
    request,
    `team:invite:revoke:${user.id}`,
    {
      route: '/api/team/invitations/[id]',
      method: 'DELETE',
      userId: user.id,
      venueId: venue.venueId,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  try {
    await revokeInvitation({
      userId: user.id,
      venueId: venue.venueId,
      invitationId: id,
      supabase,
      requestId,
    })
    // Phase 9B — enterprise audit. Soft-revoke is RBAC-relevant
    // (a previously-valid invite stops working). Snapshot is
    // metadata-only — the email + role for the invite would
    // require an additional read; the invitation_id is enough to
    // join back to the team_invitations row during review.
    void recordAuditEvent({
      venueId: venue.venueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/team/invitations/[id]',
      action: AUDIT_ACTIONS.TEAM_INVITATION_REVOKE,
      targetTable: 'team_invitations',
      targetId: id,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: { revoked: true },
    })
    return respond(NextResponse.json({ success: true }))
  } catch (err) {
    if (err instanceof TeamError) {
      return respond(
        NextResponse.json({ error: err.code, detail: err.detail }, { status: err.status })
      )
    }
    reqLog.error({ err, invitationId: id }, 'team.invitation.revoke_unexpected')
    captureApiError(err, {
      requestId,
      route: '/api/team/invitations/[id]',
      userId: user.id,
      venueId: venue.venueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
}
