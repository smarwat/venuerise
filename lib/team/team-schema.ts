import { z } from 'zod'

/**
 * Phase 6D — team invitation payload schemas.
 *
 * `owner` is intentionally OMITTED from the invite role enum. Owner is a
 * single-seat role per venue and transferring it is a destructive operation
 * we deliberately don't expose here — that's a separate future feature
 * (Phase 6E or later, with a confirm-step + audit log).
 *
 * Token max length is generous (256) so we can rotate to longer formats
 * later without a schema change, but bounded so an attacker can't ship
 * unbounded payloads at the accept endpoint.
 */

export const INVITABLE_ROLES = ['admin', 'sales_manager', 'coordinator', 'viewer'] as const
export type InvitableRole = (typeof INVITABLE_ROLES)[number]

export const InviteTeamMemberSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(INVITABLE_ROLES),
})

export type InviteTeamMemberPayload = z.infer<typeof InviteTeamMemberSchema>

export const AcceptInvitationSchema = z.object({
  token: z.string().min(1).max(256),
})

export type AcceptInvitationPayload = z.infer<typeof AcceptInvitationSchema>
