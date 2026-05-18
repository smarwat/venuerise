'use client'

import { useMemo, useState } from 'react'
import { Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/dashboard/ui/Button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/dashboard/ui/Select'
import { RoleBadge } from './RoleBadge'
import {
  ASSIGNABLE_ROLES,
  roleLabel,
  type TeamMember,
  type TeamRole,
} from './team-types'

interface MembersTableProps {
  members: TeamMember[]
  currentUserId: string
  canManage: boolean
  /** Called after a successful PATCH or DELETE so the parent can re-fetch. */
  onRoleChanged?: (info: { userId: string; newRole: TeamRole }) => void
  onRemoved?: (info: { userId: string }) => void
  onError: (message: string) => void
}

type RowBusyState = { kind: 'idle' } | { kind: 'role' } | { kind: 'remove' }

export default function MembersTable({
  members,
  currentUserId,
  canManage,
  onRoleChanged,
  onRemoved,
  onError,
}: MembersTableProps) {
  const [busyByUser, setBusyByUser] = useState<Record<string, RowBusyState>>({})

  const ownerCount = useMemo(
    () => members.filter((m) => m.role === 'owner').length,
    [members]
  )

  function setRowBusy(userId: string, state: RowBusyState) {
    setBusyByUser((prev) => ({ ...prev, [userId]: state }))
  }

  async function handleRoleChange(member: TeamMember, newRole: TeamRole) {
    if (newRole === member.role) return
    const isOnlyOwner = member.role === 'owner' && ownerCount <= 1
    if (isOnlyOwner && newRole !== 'owner') {
      onError(
        member.user_id === currentUserId
          ? 'You can’t demote yourself — you’re the only owner of this workspace.'
          : 'This is the only owner of the workspace. Promote another owner before demoting.'
      )
      return
    }

    setRowBusy(member.user_id, { kind: 'role' })
    try {
      const res = await fetch(`/api/team/members/${encodeURIComponent(member.user_id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      })
      const json: unknown = await res.json().catch(() => null)
      if (!res.ok) {
        const code =
          json && typeof json === 'object' && 'error' in json
            ? String((json as { error: unknown }).error)
            : `Request failed (${res.status})`
        onError(humanize(code))
        return
      }
      onRoleChanged?.({ userId: member.user_id, newRole })
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setRowBusy(member.user_id, { kind: 'idle' })
    }
  }

  async function handleRemove(member: TeamMember) {
    const isOnlyOwner = member.role === 'owner' && ownerCount <= 1
    if (isOnlyOwner) {
      onError(
        member.user_id === currentUserId
          ? 'You can’t remove yourself — you’re the only owner.'
          : 'This is the only owner of the workspace. Promote another owner before removing.'
      )
      return
    }
    const label = member.email || member.user_id
    if (
      !window.confirm(
        `Remove ${label} from this workspace? They’ll lose access immediately.`
      )
    ) {
      return
    }
    setRowBusy(member.user_id, { kind: 'remove' })
    try {
      const res = await fetch(
        `/api/team/members/${encodeURIComponent(member.user_id)}`,
        { method: 'DELETE' }
      )
      const json: unknown = await res.json().catch(() => null)
      if (!res.ok) {
        const code =
          json && typeof json === 'object' && 'error' in json
            ? String((json as { error: unknown }).error)
            : `Request failed (${res.status})`
        onError(humanize(code))
        return
      }
      onRemoved?.({ userId: member.user_id })
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setRowBusy(member.user_id, { kind: 'idle' })
    }
  }

  if (members.length === 0) {
    return (
      <div className="text-sm text-[#64748B] py-8 text-center">
        No members yet.
      </div>
    )
  }

  return (
    <div className="overflow-hidden border border-[#E2E8F0] rounded-2xl">
      <table className="w-full text-sm">
        <thead className="bg-[#F8FAFC] text-[11px] uppercase tracking-wider text-[#94A3B8]">
          <tr>
            <th className="text-left font-semibold px-4 py-3">Member</th>
            <th className="text-left font-semibold px-4 py-3">Role</th>
            <th className="text-left font-semibold px-4 py-3">Joined</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[#F1F5F9]">
          {members.map((m) => {
            const busy = busyByUser[m.user_id]?.kind ?? 'idle'
            const isOnlyOwner = m.role === 'owner' && ownerCount <= 1
            const isSelf = m.user_id === currentUserId
            return (
              <tr key={m.user_id} className="hover:bg-[#F8FAFC]">
                <td className="px-4 py-3 align-middle">
                  <div className="text-[#0F172A] font-medium">
                    {m.email ?? <span className="text-[#94A3B8]">No email on file</span>}
                  </div>
                  <div className="text-[11px] text-[#94A3B8] font-mono mt-0.5">
                    {m.user_id}{isSelf && ' · you'}
                  </div>
                </td>
                <td className="px-4 py-3 align-middle">
                  {canManage ? (
                    <div className="flex items-center gap-2">
                      <Select
                        value={m.role}
                        onValueChange={(v) => handleRoleChange(m, v as TeamRole)}
                        disabled={busy !== 'idle'}
                      >
                        <SelectTrigger className="h-9 w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ASSIGNABLE_ROLES.map((r) => {
                            const willDemoteOnlyOwner =
                              isOnlyOwner && r !== 'owner'
                            return (
                              <SelectItem
                                key={r}
                                value={r}
                                disabled={willDemoteOnlyOwner}
                              >
                                {roleLabel(r)}
                                {willDemoteOnlyOwner && (
                                  <span className="ml-2 text-[10px] text-[#94A3B8]">
                                    last owner
                                  </span>
                                )}
                              </SelectItem>
                            )
                          })}
                        </SelectContent>
                      </Select>
                      {busy === 'role' && (
                        <Loader2 className="h-4 w-4 animate-spin text-[#94A3B8]" />
                      )}
                    </div>
                  ) : (
                    <RoleBadge role={m.role} />
                  )}
                </td>
                <td className="px-4 py-3 align-middle text-[#475569]">
                  {m.created_at ? formatDate(m.created_at) : '—'}
                </td>
                <td className="px-4 py-3 align-middle text-right">
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemove(m)}
                      disabled={busy !== 'idle' || isOnlyOwner}
                      title={
                        isOnlyOwner
                          ? 'Cannot remove the only owner'
                          : 'Remove member'
                      }
                    >
                      {busy === 'remove' ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

function humanize(code: string): string {
  switch (code) {
    case 'cannot_remove_last_owner':
      return 'Cannot remove the only owner of this workspace.'
    case 'cannot_remove_self_as_last_owner':
      return 'You’re the only owner — promote someone else first.'
    case 'forbidden':
      return 'You don’t have permission to change members.'
    case 'member_not_found':
      return 'That member has already been removed.'
    case 'validation_failed':
      return 'Invalid role.'
    case 'unauthorized':
      return 'Please sign in again.'
    default:
      return code
  }
}
