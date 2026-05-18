/**
 * Phase 6E — client-side types for the team management surface.
 *
 * Mirrors the response shapes of:
 *   - GET  /api/team/members           → { items: TeamMember[] }
 *   - GET  /api/team/invitations       → { items: TeamInvitation[] }
 *   - POST /api/team/invitations       → { success, invitation_id, email_sent, rotated }
 *   - PATCH /api/team/members/[userId] → { success, member: { role, … } }
 *
 * Kept in a dedicated file so server + client share one definition and the
 * dashboard chrome never accidentally imports the server-only `team-service`.
 */

export type TeamRole =
  | 'owner'
  | 'admin'
  | 'sales_manager'
  | 'coordinator'
  | 'viewer'

export type InvitableRole = Exclude<TeamRole, 'owner'>

export interface TeamMember {
  user_id: string
  email?: string | null
  role: TeamRole
  created_at?: string
}

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

export interface TeamInvitation {
  id: string
  email: string
  role: InvitableRole
  status: InvitationStatus
  expires_at: string
  accepted_at?: string | null
  revoked_at?: string | null
  created_at?: string
  invited_by?: string | null
}

export const INVITABLE_ROLES: readonly InvitableRole[] = [
  'admin',
  'sales_manager',
  'coordinator',
  'viewer',
] as const

export const ASSIGNABLE_ROLES: readonly TeamRole[] = [
  'owner',
  'admin',
  'sales_manager',
  'coordinator',
  'viewer',
] as const

export function roleLabel(role: TeamRole): string {
  switch (role) {
    case 'owner':
      return 'Owner'
    case 'admin':
      return 'Admin'
    case 'sales_manager':
      return 'Sales Manager'
    case 'coordinator':
      return 'Coordinator'
    case 'viewer':
      return 'Viewer'
  }
}
