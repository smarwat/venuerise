import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentVenueForUser } from '@/lib/auth/tenant-access'
import { listInvitations, listMembers } from '@/lib/team/team-service'
import PageHeader from '@/components/dashboard/PageHeader'
import TeamManagementClient from '@/components/dashboard/team/TeamManagementClient'
import type {
  TeamInvitation,
  TeamMember,
  TeamRole,
  InvitableRole,
  InvitationStatus,
} from '@/components/dashboard/team/team-types'

export const dynamic = 'force-dynamic'

/**
 * Phase 6E — /dashboard/settings/team
 *
 * Server-rendered shell that pre-loads members + invitations using the
 * caller's authenticated Supabase client (RLS enforces the same access
 * rules as the API endpoints), then hands off to the client component
 * for all subsequent mutations.
 *
 * Why call the team-service directly from the page instead of `/api/team/*`?
 *   - Same auth boundary (user-scoped supabase client + RLS).
 *   - Avoids a localhost loopback fetch on every page render.
 *   - The service throws TeamError for expected 4xx outcomes; we treat any
 *     failure here as "render empty + let the client refresh" so the page
 *     never wedges on transient infra issues.
 */
export default async function TeamSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const venue = await getCurrentVenueForUser(user.id)
  if (!venue) redirect('/onboarding')

  // Best-effort venue name for the header.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('name')
    .eq('id', venue.venueId)
    .maybeSingle()
  const venueName = (venueRow as { name?: string } | null)?.name ?? null

  // Pre-fetch initial data. Falls back to empty arrays on failure — the
  // client's refresh button is the recovery path.
  let initialMembers: TeamMember[] = []
  let initialInvitations: TeamInvitation[] = []
  try {
    const items = await listMembers({ venueId: venue.venueId, supabase })
    initialMembers = items.map((m) => ({
      user_id: m.user_id,
      email: m.email,
      role: m.role as TeamRole,
      created_at: m.created_at,
    }))
  } catch {
    initialMembers = []
  }
  try {
    const items = await listInvitations({ venueId: venue.venueId, supabase })
    initialInvitations = items.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role as InvitableRole,
      status: i.status as InvitationStatus,
      expires_at: i.expires_at,
      accepted_at: i.accepted_at,
      revoked_at: i.revoked_at,
      created_at: i.created_at,
      invited_by: i.invited_by,
    }))
  } catch {
    initialInvitations = []
  }

  return (
    <div className="p-6 lg:p-8 animate-slide-up">
      <PageHeader
        title="Team"
        subtitle="Invite teammates, manage roles, and revoke access."
      />
      <TeamManagementClient
        initialMembers={initialMembers}
        initialInvitations={initialInvitations}
        currentUserId={user.id}
        currentUserRole={venue.role as TeamRole}
        venueName={venueName}
      />
    </div>
  )
}
