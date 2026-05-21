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
import { ADMIN_ROLES, VENUE_ROLES } from '@/lib/auth/roles'
import { removeMember, updateMemberRole, TeamError } from '@/lib/team/team-service'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import { z } from 'zod'

const UpdateMemberRoleSchema = z.object({
  role: z.enum(VENUE_ROLES),
})

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
    // Phase 9B — enterprise audit. RBAC removals are
    // security-relevant; this row is the canonical "operator X
    // removed user Y from venue Z" forensic record. The team
    // service refuses to remove the last owner, so a successful
    // response here means the membership row really came out.
    void recordAuditEvent({
      venueId: venue.venueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/team/members/[userId]',
      action: AUDIT_ACTIONS.TEAM_MEMBER_REMOVE,
      targetTable: 'venue_members',
      targetId: targetUserId,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: { self_removal: targetUserId === user.id },
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

/**
 * PATCH /api/team/members/[userId] — owner/admin changes a member's role.
 *
 * Body: { role: 'owner' | 'admin' | 'sales_manager' | 'coordinator' | 'viewer' }
 *
 * Refuses to demote the only remaining owner of the venue (whether the
 * caller is targeting themselves or another owner). Rate-limited per
 * caller to keep an accidental click-loop from hammering the table.
 */
export async function PATCH(
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

  const rl = await rateLimitUserAction(request, `team:role:${user.id}`)
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
  const parsed = UpdateMemberRoleSchema.safeParse(body)
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }

  try {
    const updated = await updateMemberRole({
      userId: user.id,
      venueId: venue.venueId,
      targetUserId,
      newRole: parsed.data.role,
      supabase,
      requestId,
    })
    // Phase 9B — enterprise audit. Role changes are
    // security-relevant. The helper refuses to demote the last
    // owner; on success the returned `updated` row reflects the
    // new role. We deliberately skip a pre-read of the previous
    // role to keep this a single round-trip — the audit row
    // captures the operator-supplied target role + actor + venue,
    // which is enough to reconstruct "who promoted/demoted whom."
    void recordAuditEvent({
      venueId: venue.venueId,
      actorUserId: user.id,
      actorKind: 'operator',
      route: '/api/team/members/[userId]',
      action: AUDIT_ACTIONS.TEAM_MEMBER_ROLE_UPDATE,
      targetTable: 'venue_members',
      targetId: targetUserId,
      requestId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      after: { role: parsed.data.role },
      metadata: { self_role_change: targetUserId === user.id },
    })
    return respond(NextResponse.json({ success: true, member: updated }))
  } catch (err) {
    if (err instanceof TeamError) {
      return respond(
        NextResponse.json({ error: err.code, detail: err.detail }, { status: err.status })
      )
    }
    reqLog.error({ err, targetUserId }, 'team.member.role_update_unexpected')
    captureApiError(err, {
      requestId,
      route: '/api/team/members/[userId]',
      userId: user.id,
      venueId: venue.venueId,
    })
    return respond(NextResponse.json({ error: 'unexpected_error' }, { status: 500 }))
  }
}
