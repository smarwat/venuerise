'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Loader2,
  AlertTriangle,
  Eye,
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
 * Phase 9J — DemoModeCard (owner-only enforced server-side).
 *
 * Toggles a venue-wide "DEMO MODE" visual marker. Renders a
 * banner in the dashboard topbar (DemoModeBanner) so operators
 * sharing their screen during an enterprise demo know they're
 * on a marked surface.
 *
 * Critically: this is a VISUAL marker. It does NOT anonymize
 * production data. Operators who need real anonymization should
 * use the Phase 9D data export / lead PII redaction surfaces.
 */

interface DemoModeState {
  venue_id: string
  enabled: boolean
  label: string | null
  started_at: string | null
  started_by: string | null
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: DemoModeState }

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }
  | { kind: 'success' }

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function DemoModeCard() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  const [labelInput, setLabelInput] = useState('')
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' })

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch('/api/admin/security/demo-mode', {
          method: 'GET',
          signal: abort.signal,
          credentials: 'same-origin',
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: unknown }
            | null
          const code =
            body && typeof body.error === 'string'
              ? body.error
              : `HTTP ${res.status}`
          setState({ kind: 'error', message: code })
          return
        }
        const body = (await res.json()) as DemoModeState
        setState({ kind: 'ready', data: body })
        setLabelInput(body.label ?? '')
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        })
      }
    })()
    return () => abort.abort()
  }, [reloadTick])

  const handleToggle = useCallback(
    async (nextEnabled: boolean) => {
      setSubmit({ kind: 'submitting' })
      try {
        const res = await fetch('/api/admin/security/demo-mode', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            enabled: nextEnabled,
            label: nextEnabled ? labelInput.trim() || null : null,
          }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: unknown }
            | null
          const code =
            body && typeof body.error === 'string'
              ? body.error
              : `HTTP ${res.status}`
          if (code === 'forbidden') {
            setSubmit({
              kind: 'error',
              message:
                'Owner role required to toggle demo mode. Ask the venue owner to flip it.',
            })
          } else {
            setSubmit({ kind: 'error', message: code })
          }
          return
        }
        setSubmit({ kind: 'success' })
        setReloadTick((n) => n + 1)
      } catch (err) {
        setSubmit({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        })
      }
    },
    [labelInput]
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
            <Eye className="h-4 w-4" />
          </div>
          <div>
            <CardTitle>Demo mode</CardTitle>
            <CardSubtitle>
              Owner-only. Renders a &quot;DEMO MODE&quot; badge across
              the dashboard topbar. <strong>Visual marker only</strong> —
              it does NOT anonymize production data. Use it during
              screen-shared sales demos so the audience knows they&apos;re
              looking at a marked surface.
            </CardSubtitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {state.kind === 'loading' && (
          <div className="flex items-center justify-center py-10 text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}
        {state.kind === 'error' && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <div className="font-medium">Could not load demo mode state</div>
              <div className="text-xs">{state.message}</div>
            </div>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <div className="mb-4 flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center gap-2 text-sm">
                <span
                  className={
                    state.data.enabled
                      ? 'inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700'
                      : 'inline-flex items-center rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-700'
                  }
                >
                  {state.data.enabled ? 'enabled' : 'disabled'}
                </span>
                {state.data.enabled && state.data.label && (
                  <span className="text-xs text-slate-600">
                    Label: <strong>{state.data.label}</strong>
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500">
                Started: {formatTime(state.data.started_at)}
              </div>
            </div>

            <label className="mb-3 block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Label (optional, ≤120 chars)
              </span>
              <input
                type="text"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                maxLength={120}
                placeholder="e.g. Enterprise Demo — Acme Property Group"
                className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400"
              />
            </label>

            <div className="flex items-center gap-2">
              {!state.data.enabled ? (
                <button
                  type="button"
                  onClick={() => handleToggle(true)}
                  disabled={submit.kind === 'submitting'}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  {submit.kind === 'submitting' && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  Enable demo mode
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleToggle(false)}
                  disabled={submit.kind === 'submitting'}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {submit.kind === 'submitting' && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  Disable demo mode
                </button>
              )}
              {state.data.enabled && (
                <button
                  type="button"
                  onClick={() => handleToggle(true)}
                  disabled={submit.kind === 'submitting'}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Save label
                </button>
              )}
              {submit.kind === 'error' && (
                <div className="flex items-start gap-1.5 text-xs text-amber-700">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <span>{submit.message}</span>
                </div>
              )}
              {submit.kind === 'success' && (
                <div className="flex items-start gap-1.5 text-xs text-emerald-700">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <span>Saved.</span>
                </div>
              )}
            </div>

            <p className="mt-4 text-xs text-slate-500">
              Demo mode toggles emit a <code className="font-mono">demo_mode_updated</code> audit
              row so the forensic trail of &quot;who flipped it, when, why&quot;
              stays intact. This is intentionally a venue-wide signal — every
              operator at this venue will see the badge.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
