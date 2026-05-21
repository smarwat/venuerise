'use client'

import { useCallback, useState } from 'react'
import {
  Loader2,
  AlertTriangle,
  History,
  CheckCircle2,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'

/**
 * Phase 9H — RestoreIntentCard (owner-only, audit-only).
 *
 * Captures operator intent to perform a restore. POSTs to
 * `/api/admin/security/restore-intents` which writes an audit row
 * via `recordRestoreIntent` → `recordAuditEvent`. NEVER triggers
 * a real restore.
 *
 * The card surfaces a clear non-destructive contract in three
 * places (header subtitle, success message, footer note) so an
 * operator can't mistake what just happened.
 *
 * Owner-only is enforced server-side. The card doesn't currently
 * gate the form for non-owner admins client-side — the server
 * returns `forbidden` which the card surfaces inline. A future
 * polish can hide the form entirely for admins, but not in 9H.
 */

const SCOPES = [
  { value: 'lead', label: 'Single lead' },
  { value: 'venue', label: 'Venue-level' },
  { value: 'billing', label: 'Billing / subscription' },
  { value: 'full_project', label: 'Full project (rare — dual approval)' },
  { value: 'unknown', label: 'Unknown / investigating' },
] as const

type Scope = (typeof SCOPES)[number]['value']

type FormState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; message: string }

export default function RestoreIntentCard() {
  const [scope, setScope] = useState<Scope>('lead')
  const [reason, setReason] = useState('')
  const [restorePoint, setRestorePoint] = useState('')
  const [affectedVenueId, setAffectedVenueId] = useState('')
  const [affectedResourceId, setAffectedResourceId] = useState('')
  const [operatorNote, setOperatorNote] = useState('')
  const [state, setState] = useState<FormState>({ kind: 'idle' })

  const handleSubmit = useCallback(async () => {
    if (reason.trim().length === 0) {
      setState({ kind: 'error', message: 'Reason is required.' })
      return
    }
    setState({ kind: 'submitting' })
    try {
      const res = await fetch('/api/admin/security/restore-intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          scope,
          reason: reason.trim(),
          requested_restore_point:
            restorePoint.trim().length > 0 ? restorePoint.trim() : null,
          affected_venue_id:
            affectedVenueId.trim().length > 0 ? affectedVenueId.trim() : null,
          affected_resource_id:
            affectedResourceId.trim().length > 0
              ? affectedResourceId.trim()
              : null,
          operator_note:
            operatorNote.trim().length > 0 ? operatorNote.trim() : null,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: unknown; detail?: unknown }
          | null
        const code =
          body && typeof body.error === 'string'
            ? body.error
            : `HTTP ${res.status}`
        if (code === 'forbidden') {
          setState({
            kind: 'error',
            message:
              'Owner role required to file a restore intent. Ask the venue owner to record it.',
          })
        } else {
          setState({ kind: 'error', message: code })
        }
        return
      }
      const body = (await res.json()) as { message?: string }
      setState({
        kind: 'success',
        message:
          body.message ??
          'Restore intent recorded. Actual restore must be performed outside the app.',
      })
      // Reset the form so the operator can file a second intent
      // without re-typing the structural fields.
      setReason('')
      setRestorePoint('')
      setOperatorNote('')
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }, [
    scope,
    reason,
    restorePoint,
    affectedVenueId,
    affectedResourceId,
    operatorNote,
  ])

  const submitting = state.kind === 'submitting'

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
            <History className="h-4 w-4" />
          </div>
          <div>
            <CardTitle>Restore intent</CardTitle>
            <CardSubtitle>
              Owner-only. Records the decision to investigate or perform a
              restore. <strong>Does not execute a restore.</strong> Real
              restores happen via the Supabase runbook
              (<code className="font-mono">docs/DISASTER-RECOVERY.md</code>).
            </CardSubtitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Scope">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as Scope)}
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900"
            >
              {SCOPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Requested restore point (ISO)">
            <input
              type="text"
              value={restorePoint}
              onChange={(e) => setRestorePoint(e.target.value)}
              placeholder="2026-05-20T10:00:00Z"
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400"
            />
          </Field>
          <Field label="Affected venue id (uuid)">
            <input
              type="text"
              value={affectedVenueId}
              onChange={(e) => setAffectedVenueId(e.target.value)}
              placeholder="defaults to your venue"
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400"
            />
          </Field>
          <Field label="Affected resource id">
            <input
              type="text"
              value={affectedResourceId}
              onChange={(e) => setAffectedResourceId(e.target.value)}
              placeholder="lead id, conversation id, etc."
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400"
            />
          </Field>
        </div>
        <Field label="Reason (required)">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Accidental lead deletion investigation; verifying blast radius before any restore."
            rows={2}
            maxLength={500}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
          />
        </Field>
        <Field label="Operator note">
          <textarea
            value={operatorNote}
            onChange={(e) => setOperatorNote(e.target.value)}
            placeholder="Optional additional context. NEVER paste secrets or tokens."
            rows={2}
            maxLength={500}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
          />
        </Field>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Record intent
          </button>
          {state.kind === 'error' && (
            <div className="flex items-start gap-1.5 text-xs text-amber-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <span>{state.message}</span>
            </div>
          )}
          {state.kind === 'success' && (
            <div className="flex items-start gap-1.5 text-xs text-emerald-700">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <span>{state.message}</span>
            </div>
          )}
        </div>

        <p className="mt-4 text-xs text-slate-500">
          Intent rows land in the Enterprise audit log
          (<code className="font-mono">restore_intent_recorded</code>) and
          mirror automatically when{' '}
          <code className="font-mono">AUDIT_MIRROR_ENABLED=1</code>. The
          product never executes a restore.
        </p>
      </CardContent>
    </Card>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      {children}
    </div>
  )
}
