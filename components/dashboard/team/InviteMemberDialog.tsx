'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/dashboard/ui/Dialog'
import { Button } from '@/components/dashboard/ui/Button'
import { Input } from '@/components/dashboard/ui/Input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/dashboard/ui/Select'
import { INVITABLE_ROLES, roleLabel, type InvitableRole } from './team-types'

interface InviteMemberDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful POST so the parent can re-fetch invitations. */
  onInvited: (info: { email: string; emailSent: boolean; rotated: boolean }) => void
}

export default function InviteMemberDialog({
  open,
  onOpenChange,
  onInvited,
}: InviteMemberDialogProps) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InvitableRole>('coordinator')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setEmail('')
    setRole('coordinator')
    setError(null)
    setSubmitting(false)
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const trimmed = email.trim()
    if (!trimmed) {
      setError('Email is required.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/team/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed, role }),
      })
      const json: unknown = await res.json().catch(() => null)
      if (!res.ok) {
        const code =
          json && typeof json === 'object' && 'error' in json
            ? String((json as { error: unknown }).error)
            : `Request failed (${res.status})`
        setError(humanize(code))
        return
      }
      const j = (json ?? {}) as {
        email_sent?: boolean
        rotated?: boolean
      }
      onInvited({
        email: trimmed,
        emailSent: Boolean(j.email_sent),
        rotated: Boolean(j.rotated),
      })
      reset()
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Invite a teammate</DialogTitle>
            <DialogDescription>
              They&apos;ll receive an email with a link to join your workspace. Owner role is
              transferred separately and can&apos;t be invited.
            </DialogDescription>
          </DialogHeader>

          <div className="px-6 py-4 space-y-4">
            <div>
              <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2">
                Email
              </label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@example.com"
                required
                autoFocus
                maxLength={254}
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-2">
                Role
              </label>
              <Select value={role} onValueChange={(v) => setRole(v as InvitableRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INVITABLE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {roleLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {error && (
              <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2 text-sm text-[#B91C1C]">
                {error}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                reset()
                onOpenChange(false)
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Sending invite…' : 'Send invite'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function humanize(code: string): string {
  switch (code) {
    case 'validation_failed':
      return 'Please double-check the email and role.'
    case 'forbidden':
      return 'Only owners and admins can invite teammates.'
    case 'cannot_invite_owner':
      return 'Owner role can’t be invited — transfer ownership separately.'
    case 'no_venue':
      return 'No active workspace found.'
    case 'unauthorized':
      return 'Please sign in again.'
    default:
      return code
  }
}
