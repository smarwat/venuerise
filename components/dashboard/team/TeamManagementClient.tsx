'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/dashboard/ui/Button'
import { Card, CardContent, CardHeader, CardTitle, CardSubtitle } from '@/components/dashboard/ui/Card'
import InviteMemberDialog from './InviteMemberDialog'
import MembersTable from './MembersTable'
import InvitationsTable from './InvitationsTable'
import {
  type TeamInvitation,
  type TeamMember,
  type TeamRole,
} from './team-types'

interface TeamManagementClientProps {
  initialMembers: TeamMember[]
  initialInvitations: TeamInvitation[]
  currentUserId: string
  currentUserRole: TeamRole
  /** Best-effort venue label for the header. */
  venueName?: string | null
}

interface Banner {
  kind: 'success' | 'error'
  message: string
}

export default function TeamManagementClient({
  initialMembers,
  initialInvitations,
  currentUserId,
  currentUserRole,
  venueName,
}: TeamManagementClientProps) {
  const [members, setMembers] = useState<TeamMember[]>(initialMembers)
  const [invitations, setInvitations] = useState<TeamInvitation[]>(initialInvitations)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [banner, setBanner] = useState<Banner | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const canManage = currentUserRole === 'owner' || currentUserRole === 'admin'

  // Auto-dismiss success banners after 4s; errors stay until next action.
  useEffect(() => {
    if (banner?.kind !== 'success') return
    const t = setTimeout(() => setBanner(null), 4000)
    return () => clearTimeout(t)
  }, [banner])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const [mRes, iRes] = await Promise.all([
        fetch('/api/team/members', { cache: 'no-store' }),
        fetch('/api/team/invitations', { cache: 'no-store' }),
      ])
      if (mRes.ok) {
        const j = (await mRes.json()) as { items?: TeamMember[] }
        setMembers(j.items ?? [])
      }
      if (iRes.ok) {
        const j = (await iRes.json()) as { items?: TeamInvitation[] }
        setInvitations(j.items ?? [])
      }
    } catch (e) {
      setBanner({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed to refresh',
      })
    } finally {
      setRefreshing(false)
    }
  }, [])

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Team</CardTitle>
            <CardSubtitle>
              {venueName
                ? `Manage who can access ${venueName}.`
                : 'Manage who can access this workspace.'}
              {!canManage && ' — only owners and admins can invite or change members.'}
            </CardSubtitle>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={refresh}
              disabled={refreshing}
              title="Refresh"
            >
              <RefreshCw
                className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
              />
            </Button>
            {canManage && (
              <Button onClick={() => setDialogOpen(true)} size="md">
                <Plus className="h-4 w-4" />
                Invite member
              </Button>
            )}
          </div>
        </CardHeader>
      </Card>

      {/* Inline banners */}
      {banner && (
        <div
          className={
            banner.kind === 'success'
              ? 'rounded-2xl bg-[#ECFDF5] border border-[#A7F3D0] px-4 py-3 text-sm text-[#047857] flex items-start gap-2'
              : 'rounded-2xl bg-[#FEF2F2] border border-[#FECACA] px-4 py-3 text-sm text-[#B91C1C]'
          }
        >
          {banner.kind === 'success' && (
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          )}
          <span>{banner.message}</span>
        </div>
      )}

      {/* GTM-0H — role guide card teaches the buyer the access
          model at a glance, so the Team page reads as "who can
          manage the revenue pipeline" rather than a generic
          permissions table. */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Role guide</CardTitle>
            <CardSubtitle>
              Each role gets a different slice of the revenue pipeline.
            </CardSubtitle>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-[12.5px] text-[#475569] leading-relaxed">
            <li className="flex items-baseline gap-2">
              <span className="text-[11px] uppercase tracking-[0.12em] text-[#0F172A] font-semibold min-w-[88px]">Owner</span>
              <span>Billing, team, and workspace control.</span>
            </li>
            <li className="flex items-baseline gap-2">
              <span className="text-[11px] uppercase tracking-[0.12em] text-[#0F172A] font-semibold min-w-[88px]">Admin</span>
              <span>Manage venue settings and revenue workflows.</span>
            </li>
            <li className="flex items-baseline gap-2">
              <span className="text-[11px] uppercase tracking-[0.12em] text-[#0F172A] font-semibold min-w-[88px]">Coordinator</span>
              <span>Handle leads, inbox, and tours.</span>
            </li>
            <li className="flex items-baseline gap-2">
              <span className="text-[11px] uppercase tracking-[0.12em] text-[#0F172A] font-semibold min-w-[88px]">Viewer</span>
              <span>Read-only access across the workspace.</span>
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* Members */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Members</CardTitle>
            <CardSubtitle>
              {/* GTM-0H — grammar fix: "person has" vs "people have". */}
              {members.length} {members.length === 1 ? 'person has' : 'people have'} access today.
            </CardSubtitle>
          </div>
        </CardHeader>
        <CardContent>
          <MembersTable
            members={members}
            currentUserId={currentUserId}
            canManage={canManage}
            onRoleChanged={({ userId, newRole }) => {
              setMembers((prev) =>
                prev.map((m) => (m.user_id === userId ? { ...m, role: newRole } : m))
              )
              setBanner({ kind: 'success', message: 'Role updated.' })
            }}
            onRemoved={({ userId }) => {
              setMembers((prev) => prev.filter((m) => m.user_id !== userId))
              setBanner({ kind: 'success', message: 'Member removed.' })
            }}
            onError={(message) => setBanner({ kind: 'error', message })}
          />
        </CardContent>
      </Card>

      {/* Invitations */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Invitations</CardTitle>
            <CardSubtitle>
              Pending links expire after 7 days. Resending rotates the token.
            </CardSubtitle>
          </div>
        </CardHeader>
        <CardContent>
          <InvitationsTable
            invitations={invitations}
            canManage={canManage}
            onRevoked={() => {
              setBanner({ kind: 'success', message: 'Invitation revoked.' })
              refresh()
            }}
            onResent={({ emailSent }) => {
              setBanner({
                kind: 'success',
                message: emailSent
                  ? 'Invite resent — new token delivered by email.'
                  : 'Invite token rotated. Email delivery may be in console fallback or failed.',
              })
              refresh()
            }}
            onError={(message) => setBanner({ kind: 'error', message })}
          />
        </CardContent>
      </Card>

      <InviteMemberDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onInvited={({ email, emailSent }) => {
          setBanner({
            kind: 'success',
            message: emailSent
              ? `Invite sent to ${email}.`
              : `Invite created for ${email}. Email delivery may be in console fallback or failed.`,
          })
          refresh()
        }}
      />
    </div>
  )
}
