'use client'

import { useState } from 'react'
import { Loader2, RotateCcw, XCircle } from 'lucide-react'
import { Badge } from '@/components/dashboard/ui/Badge'
import { Button } from '@/components/dashboard/ui/Button'
import { RoleBadge } from './RoleBadge'
import {
  type TeamInvitation,
  type InvitationStatus,
} from './team-types'

interface InvitationsTableProps {
  invitations: TeamInvitation[]
  canManage: boolean
  onRevoked?: (info: { id: string }) => void
  /** Resend just re-POSTs the same email + role; service rotates the token. */
  onResent?: (info: { email: string; emailSent: boolean }) => void
  onError: (message: string) => void
}

type RowBusy = { kind: 'idle' } | { kind: 'revoke' } | { kind: 'resend' }

const STATUS_VARIANT: Record<InvitationStatus, React.ComponentProps<typeof Badge>['variant']> = {
  pending: 'blue',
  accepted: 'green',
  revoked: 'default',
  expired: 'amber',
}

const STATUS_LABEL: Record<InvitationStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  revoked: 'Revoked',
  expired: 'Expired',
}

export default function InvitationsTable({
  invitations,
  canManage,
  onRevoked,
  onResent,
  onError,
}: InvitationsTableProps) {
  const [busyById, setBusyById] = useState<Record<string, RowBusy>>({})

  function setBusy(id: string, state: RowBusy) {
    setBusyById((p) => ({ ...p, [id]: state }))
  }

  async function handleRevoke(inv: TeamInvitation) {
    if (!window.confirm(`Revoke the invite to ${inv.email}?`)) return
    setBusy(inv.id, { kind: 'revoke' })
    try {
      const res = await fetch(
        `/api/team/invitations/${encodeURIComponent(inv.id)}`,
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
      onRevoked?.({ id: inv.id })
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setBusy(inv.id, { kind: 'idle' })
    }
  }

  async function handleResend(inv: TeamInvitation) {
    setBusy(inv.id, { kind: 'resend' })
    try {
      const res = await fetch('/api/team/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inv.email, role: inv.role }),
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
      const j = (json ?? {}) as { email_sent?: boolean }
      onResent?.({ email: inv.email, emailSent: Boolean(j.email_sent) })
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setBusy(inv.id, { kind: 'idle' })
    }
  }

  if (invitations.length === 0) {
    return (
      <div className="text-sm text-[#64748B] py-8 text-center">
        No invitations sent yet.
      </div>
    )
  }

  return (
    <div className="overflow-hidden border border-[#E2E8F0] rounded-2xl">
      <table className="w-full text-sm">
        <thead className="bg-[#F8FAFC] text-[11px] uppercase tracking-wider text-[#94A3B8]">
          <tr>
            <th className="text-left font-semibold px-4 py-3">Email</th>
            <th className="text-left font-semibold px-4 py-3">Role</th>
            <th className="text-left font-semibold px-4 py-3">Status</th>
            <th className="text-left font-semibold px-4 py-3">Expires</th>
            <th className="text-left font-semibold px-4 py-3">Sent</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[#F1F5F9]">
          {invitations.map((inv) => {
            const busy = busyById[inv.id]?.kind ?? 'idle'
            const isPending = inv.status === 'pending'
            return (
              <tr key={inv.id} className="hover:bg-[#F8FAFC]">
                <td className="px-4 py-3 align-middle text-[#0F172A]">{inv.email}</td>
                <td className="px-4 py-3 align-middle">
                  <RoleBadge role={inv.role} />
                </td>
                <td className="px-4 py-3 align-middle">
                  <Badge variant={STATUS_VARIANT[inv.status]}>
                    {STATUS_LABEL[inv.status]}
                  </Badge>
                </td>
                <td className="px-4 py-3 align-middle text-[#475569]">
                  {formatDate(inv.expires_at)}
                </td>
                <td className="px-4 py-3 align-middle text-[#475569]">
                  {inv.created_at ? formatDate(inv.created_at) : '—'}
                </td>
                <td className="px-4 py-3 align-middle text-right">
                  {canManage && isPending && (
                    <div className="inline-flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleResend(inv)}
                        disabled={busy !== 'idle'}
                        title="Resend invite (rotates token)"
                      >
                        {busy === 'resend' ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RotateCcw className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRevoke(inv)}
                        disabled={busy !== 'idle'}
                        title="Revoke invite"
                      >
                        {busy === 'revoke' ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <XCircle className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
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
    case 'forbidden':
      return 'You don’t have permission to manage invitations.'
    case 'invitation_not_found':
      return 'This invitation has been removed.'
    case 'invitation_already_accepted':
      return 'This invitation has already been accepted.'
    case 'validation_failed':
      return 'Invalid invitation payload.'
    case 'unauthorized':
      return 'Please sign in again.'
    default:
      return code
  }
}
