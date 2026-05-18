import 'server-only'
import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import { sendEmail } from '@/lib/integrations/email'
import {
  AcceptInvitationSchema,
  InviteTeamMemberSchema,
  type InvitableRole,
} from './team-schema'
import { VENUE_ROLES, type VenueRole } from '@/lib/auth/roles'

/**
 * Phase 6D — team service.
 *
 * AUTHORIZATION MODEL (route layer is expected to enforce these):
 *   - createInvitation, listInvitations, revokeInvitation, removeMember:
 *       caller must already pass `requireVenueRole(user, venue, ADMIN_ROLES)`.
 *   - listMembers: any member of the venue.
 *   - acceptInvitation: any authenticated user (token is the capability).
 *
 * CLIENT CHOICE (user-scoped vs service-role):
 *   - User-scoped client (passed in): every operation the caller can do
 *     under existing RLS. Defense in depth — even a buggy route handler
 *     can't escalate beyond the user's role.
 *   - Service-role client (created here): two situations only:
 *       1. acceptInvitation, because the user isn't a member of the venue
 *          yet so user-scoped RLS would block both the token lookup
 *          (venue_invitations is owner/admin-RLS) and the membership insert.
 *       2. listMembers email enrichment — joining auth.users requires
 *          service role since the auth schema isn't exposed via RLS.
 *
 * TOKENS:
 *   - 32 cryptographically random bytes, base64url encoded → 43 chars.
 *   - Never logged in full — we redact to first 8 chars + length.
 *
 * IDEMPOTENCY:
 *   - createInvitation: if a non-expired, non-accepted, non-revoked
 *     invitation already exists for (venue, lowercase(email)), we ROTATE
 *     its token (so the new email link works and the old one stops),
 *     refresh expiry, and return the existing row. Keeps the table from
 *     filling with duplicates after retries.
 *   - acceptInvitation: if the user already has a venue_members row for
 *     the invitation's venue, we still mark `accepted_at` on the invite
 *     and return the existing venue id with `already_member: true`.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TeamErrorCode =
  | 'validation_failed'
  | 'invitation_not_found'
  | 'invitation_expired'
  | 'invitation_revoked'
  | 'invitation_already_accepted'
  | 'member_not_found'
  | 'cannot_invite_owner'
  | 'cannot_remove_last_owner'
  | 'cannot_remove_self_as_last_owner'
  | 'insert_failed'
  | 'unexpected'

export class TeamError extends Error {
  constructor(
    public readonly code: TeamErrorCode,
    public readonly status: 400 | 404 | 409 | 410 | 500,
    public readonly detail?: unknown
  ) {
    super(code)
    this.name = 'TeamError'
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INVITATION_TTL_DAYS = 7

function newInvitationToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Safe form of a token for log lines — never the full secret. */
function redactToken(token: string): string {
  if (token.length <= 8) return `len=${token.length}`
  return `${token.slice(0, 8)}…(len=${token.length})`
}

function expiryFromNow(days = INVITATION_TTL_DAYS): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function isVenueRoleString(s: string): s is VenueRole {
  return (VENUE_ROLES as readonly string[]).includes(s)
}

// ---------------------------------------------------------------------------
// createInvitation
// ---------------------------------------------------------------------------

export interface CreateInvitationArgs {
  /** Caller — already gated to ADMIN_ROLES by the route. */
  userId: string
  venueId: string
  email: string
  role: InvitableRole
  /** Pre-resolved venue name (optional; only used for the email body). */
  venueName?: string | null
  supabase: SupabaseClient
  requestId?: string
}

export interface CreateInvitationResult {
  invitation_id: string
  email_sent: boolean
  /** True when an existing pending row was rotated rather than a fresh insert. */
  rotated: boolean
}

export async function createInvitation(
  args: CreateInvitationArgs
): Promise<CreateInvitationResult> {
  const { userId, venueId, supabase, requestId, venueName } = args
  const reqLog = log.child({
    requestId,
    userId,
    venueId,
    op: 'team.create_invitation',
  })

  // Validate. The route also validates, but doing it here keeps the service
  // honest if called from a future code path.
  const parsed = InviteTeamMemberSchema.safeParse({
    email: args.email,
    role: args.role,
  })
  if (!parsed.success) {
    throw new TeamError('validation_failed', 400, parsed.error.flatten())
  }
  const email = normalizeEmail(parsed.data.email)
  const role = parsed.data.role

  // Belt-and-suspenders — schema already excludes 'owner' but be explicit.
  if ((role as string) === 'owner') {
    throw new TeamError('cannot_invite_owner', 400)
  }

  // Idempotency — look for an outstanding (unexpired, unaccepted, unrevoked)
  // invite for (venue, email). RLS lets ADMIN_ROLES see invitations for the
  // venue, so the user-scoped client is fine here.
  const { data: existingRaw, error: existingErr } = await supabase
    .from('venue_invitations')
    .select('id, venue_id, email, role, token, expires_at, accepted_at, revoked_at, created_at, invited_by')
    .eq('venue_id', venueId)
    .eq('email', email)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingErr) {
    reqLog.error({ err: existingErr }, 'team.invitation.lookup_failed')
    captureApiError(existingErr, { requestId, route: 'team.createInvitation', userId, venueId })
    throw new TeamError('insert_failed', 500, existingErr.message)
  }

  const existing = existingRaw as { id: string; expires_at: string } | null
  const now = Date.now()
  const stillFresh =
    existing && new Date(existing.expires_at).getTime() > now

  let invitationId: string
  let token: string
  let rotated = false

  if (existing && stillFresh) {
    // Rotate the token so any old email link is invalidated, and extend expiry.
    token = newInvitationToken()
    const { error: rotateErr } = await supabase
      .from('venue_invitations')
      .update({
        token,
        expires_at: expiryFromNow(),
        role, // honor latest requested role
        invited_by: userId,
      })
      .eq('id', existing.id)
    if (rotateErr) {
      reqLog.error({ err: rotateErr }, 'team.invitation.rotate_failed')
      captureApiError(rotateErr, { requestId, route: 'team.createInvitation', userId, venueId })
      throw new TeamError('insert_failed', 500, rotateErr.message)
    }
    invitationId = existing.id
    rotated = true
  } else {
    // Fresh insert. If an expired row exists, leave it — it's an audit trail.
    token = newInvitationToken()
    const { data: inserted, error: insertErr } = await supabase
      .from('venue_invitations')
      .insert({
        venue_id: venueId,
        email,
        role,
        token,
        invited_by: userId,
        expires_at: expiryFromNow(),
      })
      .select('id')
      .single()
    if (insertErr || !inserted) {
      reqLog.error({ err: insertErr }, 'team.invitation.insert_failed')
      captureApiError(insertErr, { requestId, route: 'team.createInvitation', userId, venueId })
      throw new TeamError('insert_failed', 500, insertErr?.message)
    }
    invitationId = (inserted as { id: string }).id
  }

  // Send the email AFTER the DB row exists, so we never deliver a token
  // that doesn't resolve.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const acceptUrl = `${appUrl.replace(/\/$/, '')}/onboarding/accept?token=${encodeURIComponent(token)}`
  const venueLabel = venueName?.trim() || 'a VenueRise workspace'

  const text =
    `You've been invited to ${venueLabel} on VenueRise as ${role}.\n\n` +
    `Accept your invitation:\n${acceptUrl}\n\n` +
    `This link expires in ${INVITATION_TTL_DAYS} days. If you weren't expecting this, you can ignore the email.`

  let emailSent = false
  try {
    const result = await sendEmail({
      to: email,
      subject: "You're invited to VenueRise",
      text,
      venueId,
      relatedTable: 'venue_invitations',
      relatedId: invitationId,
    })
    emailSent = result.delivered
    if (!result.delivered) {
      reqLog.warn(
        { provider: result.provider, errorMessage: result.error },
        'team.invitation.email_not_delivered'
      )
    }
  } catch (err) {
    reqLog.error({ err }, 'team.invitation.email_threw')
    captureApiError(err, { requestId, route: 'team.createInvitation', userId, venueId })
    // We don't fail the operation — the row exists; the admin can resend.
  }

  reqLog.info(
    { invitationId, role, rotated, emailSent, tokenSample: redactToken(token) },
    'team.invitation.created'
  )

  return { invitation_id: invitationId, email_sent: emailSent, rotated }
}

// ---------------------------------------------------------------------------
// listInvitations
// ---------------------------------------------------------------------------

export interface ListInvitationsArgs {
  venueId: string
  supabase: SupabaseClient
}

export interface ListedInvitation {
  id: string
  email: string
  role: string
  expires_at: string
  accepted_at: string | null
  revoked_at: string | null
  created_at: string
  invited_by: string | null
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
}

export async function listInvitations(
  args: ListInvitationsArgs
): Promise<ListedInvitation[]> {
  const { venueId, supabase } = args
  const { data, error } = await supabase
    .from('venue_invitations')
    .select('id, email, role, expires_at, accepted_at, revoked_at, created_at, invited_by')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) {
    captureApiError(error, { route: 'team.listInvitations', venueId })
    throw new TeamError('unexpected', 500, error.message)
  }

  const now = Date.now()
  return (data ?? []).map((rRaw) => {
    const r = rRaw as Omit<ListedInvitation, 'status'>
    let status: ListedInvitation['status']
    if (r.accepted_at) status = 'accepted'
    else if (r.revoked_at) status = 'revoked'
    else if (new Date(r.expires_at).getTime() < now) status = 'expired'
    else status = 'pending'
    return { ...r, status }
  })
}

// ---------------------------------------------------------------------------
// revokeInvitation
// ---------------------------------------------------------------------------

export interface RevokeInvitationArgs {
  userId: string
  venueId: string
  invitationId: string
  supabase: SupabaseClient
  requestId?: string
}

export async function revokeInvitation(args: RevokeInvitationArgs): Promise<void> {
  const { userId, venueId, invitationId, supabase, requestId } = args
  const reqLog = log.child({
    requestId,
    userId,
    venueId,
    invitationId,
    op: 'team.revoke_invitation',
  })

  const { data: rowRaw, error: lookupErr } = await supabase
    .from('venue_invitations')
    .select('id, accepted_at, revoked_at')
    .eq('id', invitationId)
    .eq('venue_id', venueId)
    .maybeSingle()

  if (lookupErr) {
    reqLog.error({ err: lookupErr }, 'team.invitation.lookup_failed')
    captureApiError(lookupErr, { requestId, route: 'team.revokeInvitation', userId, venueId })
    throw new TeamError('unexpected', 500, lookupErr.message)
  }
  const row = rowRaw as { id: string; accepted_at: string | null; revoked_at: string | null } | null
  if (!row) {
    throw new TeamError('invitation_not_found', 404)
  }
  if (row.accepted_at) {
    // Already accepted — revoking has no meaning. Surface explicitly.
    throw new TeamError('invitation_already_accepted', 409)
  }
  if (row.revoked_at) {
    // Idempotent — already revoked.
    reqLog.info({}, 'team.invitation.revoke_noop_already_revoked')
    return
  }

  const { error: updateErr } = await supabase
    .from('venue_invitations')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', invitationId)
    .eq('venue_id', venueId)

  if (updateErr) {
    reqLog.error({ err: updateErr }, 'team.invitation.revoke_failed')
    captureApiError(updateErr, { requestId, route: 'team.revokeInvitation', userId, venueId })
    throw new TeamError('unexpected', 500, updateErr.message)
  }

  reqLog.info({}, 'team.invitation.revoked')
}

// ---------------------------------------------------------------------------
// acceptInvitation
// ---------------------------------------------------------------------------

export interface AcceptInvitationArgs {
  userId: string
  token: string
  requestId?: string
}

export interface AcceptInvitationResult {
  venue_id: string
  /** True if the user was already a member (idempotent re-accept). */
  already_member: boolean
}

export async function acceptInvitation(
  args: AcceptInvitationArgs
): Promise<AcceptInvitationResult> {
  const { userId, requestId } = args
  const reqLog = log.child({ requestId, userId, op: 'team.accept_invitation' })

  const parsed = AcceptInvitationSchema.safeParse({ token: args.token })
  if (!parsed.success) {
    throw new TeamError('validation_failed', 400, parsed.error.flatten())
  }
  const { token } = parsed.data

  // Service role: the accepting user isn't a member yet, so RLS on
  // venue_invitations (owner/admin-only) would hide the row from them.
  const svc = createServiceClient()

  const { data: invRaw, error: lookupErr } = await svc
    .from('venue_invitations')
    .select('id, venue_id, role, expires_at, accepted_at, revoked_at')
    .eq('token', token)
    .maybeSingle()

  if (lookupErr) {
    reqLog.error(
      { err: lookupErr, tokenSample: redactToken(token) },
      'team.accept.lookup_failed'
    )
    captureApiError(lookupErr, { requestId, route: 'team.acceptInvitation', userId })
    throw new TeamError('unexpected', 500, lookupErr.message)
  }
  if (!invRaw) {
    reqLog.warn({ tokenSample: redactToken(token) }, 'team.accept.token_not_found')
    throw new TeamError('invitation_not_found', 404)
  }
  const inv = invRaw as {
    id: string
    venue_id: string
    role: string
    expires_at: string
    accepted_at: string | null
    revoked_at: string | null
  }

  if (inv.revoked_at) throw new TeamError('invitation_revoked', 410)
  if (inv.accepted_at) throw new TeamError('invitation_already_accepted', 409)
  if (new Date(inv.expires_at).getTime() < Date.now()) {
    throw new TeamError('invitation_expired', 410)
  }

  // Sanity-check the stored role. Defensive — the CHECK constraint on the
  // column should already guarantee this.
  if (!isVenueRoleString(inv.role)) {
    reqLog.error({ invitationId: inv.id, storedRole: inv.role }, 'team.accept.invalid_role')
    throw new TeamError('unexpected', 500, 'invalid_role_in_invitation')
  }
  // Defense in depth — owner can never be assigned via accept.
  if (inv.role === 'owner') {
    throw new TeamError('cannot_invite_owner', 400)
  }

  // Upsert membership. If user already has a member row, keep their existing
  // role (don't downgrade an admin who got invited as viewer by mistake).
  const { data: existingMemRaw } = await svc
    .from('venue_members')
    .select('id, role')
    .eq('venue_id', inv.venue_id)
    .eq('user_id', userId)
    .maybeSingle()

  let alreadyMember = false
  if (existingMemRaw) {
    alreadyMember = true
  } else {
    const { error: insertErr } = await svc
      .from('venue_members')
      .insert({ venue_id: inv.venue_id, user_id: userId, role: inv.role })
    if (insertErr) {
      reqLog.error(
        { err: insertErr, invitationId: inv.id, venueId: inv.venue_id },
        'team.accept.member_insert_failed'
      )
      captureApiError(insertErr, {
        requestId,
        route: 'team.acceptInvitation',
        userId,
        venueId: inv.venue_id,
      })
      throw new TeamError('insert_failed', 500, insertErr.message)
    }
  }

  // Mark invitation accepted (even if already_member — closes the loop so a
  // second click can't replay).
  const { error: markErr } = await svc
    .from('venue_invitations')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', inv.id)
  if (markErr) {
    reqLog.error(
      { err: markErr, invitationId: inv.id },
      'team.accept.mark_failed'
    )
    captureApiError(markErr, {
      requestId,
      route: 'team.acceptInvitation',
      userId,
      venueId: inv.venue_id,
    })
    // Non-fatal: membership exists. Surface but don't unwind.
  }

  reqLog.info(
    { invitationId: inv.id, venueId: inv.venue_id, alreadyMember, role: inv.role },
    'team.accept.completed'
  )

  return { venue_id: inv.venue_id, already_member: alreadyMember }
}

// ---------------------------------------------------------------------------
// listMembers
// ---------------------------------------------------------------------------

export interface ListMembersArgs {
  venueId: string
  supabase: SupabaseClient
}

export interface ListedMember {
  user_id: string
  role: VenueRole
  created_at: string
  email: string | null
}

export async function listMembers(args: ListMembersArgs): Promise<ListedMember[]> {
  const { venueId, supabase } = args

  // venue_members.select policy allows any member to see siblings.
  const { data: memberRows, error: memberErr } = await supabase
    .from('venue_members')
    .select('user_id, role, created_at')
    .eq('venue_id', venueId)
    .order('created_at')

  if (memberErr) {
    captureApiError(memberErr, { route: 'team.listMembers', venueId })
    throw new TeamError('unexpected', 500, memberErr.message)
  }

  const rows = (memberRows ?? []) as Array<{ user_id: string; role: string; created_at: string }>

  if (rows.length === 0) return []

  // Email enrichment — requires auth schema access (service role).
  const svc = createServiceClient()
  const emails = new Map<string, string | null>()
  for (const row of rows) {
    if (emails.has(row.user_id)) continue
    try {
      const { data } = await svc.auth.admin.getUserById(row.user_id)
      emails.set(row.user_id, data.user?.email ?? null)
    } catch {
      emails.set(row.user_id, null)
    }
  }

  return rows.map((r) => ({
    user_id: r.user_id,
    role: (isVenueRoleString(r.role) ? r.role : 'viewer') as VenueRole,
    created_at: r.created_at,
    email: emails.get(r.user_id) ?? null,
  }))
}

// ---------------------------------------------------------------------------
// updateMemberRole (Phase 6E)
// ---------------------------------------------------------------------------

export interface UpdateMemberRoleArgs {
  /** Caller — already gated to ADMIN_ROLES at the route. */
  userId: string
  venueId: string
  targetUserId: string
  newRole: VenueRole
  supabase: SupabaseClient
  requestId?: string
}

export interface UpdatedMemberRow {
  user_id: string
  venue_id: string
  role: VenueRole
  updated_at: string
}

/**
 * Change a member's role.
 *
 * Safety rules (mirrors removeMember's last-owner protection):
 *   - If the change DEMOTES the only remaining owner (target is owner +
 *     newRole !== 'owner' + owner count <= 1), reject with
 *     `cannot_remove_last_owner` (or `cannot_remove_self_as_last_owner`
 *     when self-targeted).
 *   - No-op when the role is unchanged — return the existing row.
 *
 * Promotion to owner is allowed (any admin can hand a co-owner the keys);
 * future "owner transfer" UX would layer a confirm step on top.
 */
export async function updateMemberRole(
  args: UpdateMemberRoleArgs
): Promise<UpdatedMemberRow> {
  const { userId, venueId, targetUserId, newRole, supabase, requestId } = args
  const reqLog = log.child({
    requestId,
    userId,
    venueId,
    targetUserId,
    newRole,
    op: 'team.update_member_role',
  })

  if (!isVenueRoleString(newRole)) {
    throw new TeamError('validation_failed', 400, 'invalid_role')
  }

  const { data: targetRaw, error: targetErr } = await supabase
    .from('venue_members')
    .select('id, role')
    .eq('venue_id', venueId)
    .eq('user_id', targetUserId)
    .maybeSingle()

  if (targetErr) {
    reqLog.error({ err: targetErr }, 'team.update_role.lookup_failed')
    captureApiError(targetErr, { requestId, route: 'team.updateMemberRole', userId, venueId })
    throw new TeamError('unexpected', 500, targetErr.message)
  }
  if (!targetRaw) throw new TeamError('member_not_found', 404)
  const target = targetRaw as { id: string; role: string }

  // No-op when the role is unchanged.
  if (target.role === newRole) {
    reqLog.info({}, 'team.update_role.noop')
    return {
      user_id: targetUserId,
      venue_id: venueId,
      role: newRole,
      updated_at: new Date().toISOString(),
    }
  }

  // Last-owner protection on demotion.
  if (target.role === 'owner' && newRole !== 'owner') {
    const { count, error: countErr } = await supabase
      .from('venue_members')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('role', 'owner')
    if (countErr) {
      reqLog.error({ err: countErr }, 'team.update_role.owner_count_failed')
      captureApiError(countErr, { requestId, route: 'team.updateMemberRole', userId, venueId })
      throw new TeamError('unexpected', 500, countErr.message)
    }
    if ((count ?? 0) <= 1) {
      throw new TeamError(
        userId === targetUserId
          ? 'cannot_remove_self_as_last_owner'
          : 'cannot_remove_last_owner',
        409
      )
    }
  }

  const { data: updated, error: updateErr } = await supabase
    .from('venue_members')
    .update({ role: newRole })
    .eq('id', target.id)
    .select('user_id, venue_id, role, updated_at')
    .single()

  if (updateErr || !updated) {
    reqLog.error({ err: updateErr }, 'team.update_role.update_failed')
    captureApiError(updateErr, { requestId, route: 'team.updateMemberRole', userId, venueId })
    throw new TeamError('unexpected', 500, updateErr?.message)
  }

  const row = updated as { user_id: string; venue_id: string; role: string; updated_at: string }
  reqLog.info({ previousRole: target.role }, 'team.member.role_updated')

  return {
    user_id: row.user_id,
    venue_id: row.venue_id,
    role: (isVenueRoleString(row.role) ? row.role : newRole) as VenueRole,
    updated_at: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// removeMember
// ---------------------------------------------------------------------------

export interface RemoveMemberArgs {
  userId: string
  venueId: string
  targetUserId: string
  supabase: SupabaseClient
  requestId?: string
}

export async function removeMember(args: RemoveMemberArgs): Promise<void> {
  const { userId, venueId, targetUserId, supabase, requestId } = args
  const reqLog = log.child({
    requestId,
    userId,
    venueId,
    targetUserId,
    op: 'team.remove_member',
  })

  // Fetch target's row.
  const { data: targetRaw, error: targetErr } = await supabase
    .from('venue_members')
    .select('id, role')
    .eq('venue_id', venueId)
    .eq('user_id', targetUserId)
    .maybeSingle()

  if (targetErr) {
    reqLog.error({ err: targetErr }, 'team.remove.lookup_failed')
    captureApiError(targetErr, { requestId, route: 'team.removeMember', userId, venueId })
    throw new TeamError('unexpected', 500, targetErr.message)
  }
  if (!targetRaw) throw new TeamError('member_not_found', 404)
  const target = targetRaw as { id: string; role: string }

  // Last-owner protection: if the target is an owner, count how many owners
  // exist. If they're the only one, refuse (regardless of whether they're
  // removing themselves or being removed by another admin).
  if (target.role === 'owner') {
    const { count, error: countErr } = await supabase
      .from('venue_members')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('role', 'owner')
    if (countErr) {
      reqLog.error({ err: countErr }, 'team.remove.owner_count_failed')
      captureApiError(countErr, { requestId, route: 'team.removeMember', userId, venueId })
      throw new TeamError('unexpected', 500, countErr.message)
    }
    if ((count ?? 0) <= 1) {
      throw new TeamError(
        userId === targetUserId
          ? 'cannot_remove_self_as_last_owner'
          : 'cannot_remove_last_owner',
        409
      )
    }
  }

  const { error: deleteErr } = await supabase
    .from('venue_members')
    .delete()
    .eq('id', target.id)

  if (deleteErr) {
    reqLog.error({ err: deleteErr }, 'team.remove.delete_failed')
    captureApiError(deleteErr, { requestId, route: 'team.removeMember', userId, venueId })
    throw new TeamError('unexpected', 500, deleteErr.message)
  }

  reqLog.info({ removedRole: target.role }, 'team.member.removed')
}
