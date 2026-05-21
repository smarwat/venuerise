'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Loader2,
  AlertTriangle,
  ShieldCheck,
  RefreshCw,
  CircleHelp,
  TriangleAlert,
  CircleX,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'

/**
 * Phase 9H — BackupPostureCard (admin-only, read-only).
 *
 * Surfaces the BackupPostureSummary returned by
 * `/api/admin/security/backup-posture`. Pure render — no
 * destructive actions, no restore trigger. The card explicitly
 * tells the operator that restores happen outside the app.
 */

type PostureStatus = 'healthy' | 'warning' | 'critical' | 'unknown'

interface BackupCheck {
  code: string
  status: PostureStatus
  message: string
  metadata?: Record<string, unknown>
}

interface BackupPostureSummary {
  status: PostureStatus
  provider: string
  rtoHours: number
  rpoHours: number
  retentionDays: number
  dryRunCadence: string
  lastCheckedAt: string
  checks: BackupCheck[]
  providerMetadata?: Record<string, unknown>
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; summary: BackupPostureSummary }

function statusIcon(status: PostureStatus) {
  if (status === 'healthy') {
    return <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
  }
  if (status === 'warning') {
    return <TriangleAlert className="h-3.5 w-3.5 text-amber-600" />
  }
  if (status === 'critical') {
    return <CircleX className="h-3.5 w-3.5 text-red-600" />
  }
  return <CircleHelp className="h-3.5 w-3.5 text-slate-500" />
}

function statusChipClass(status: PostureStatus): string {
  if (status === 'healthy') {
    return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  }
  if (status === 'warning') {
    return 'bg-amber-50 text-amber-700 border-amber-200'
  }
  if (status === 'critical') {
    return 'bg-red-50 text-red-700 border-red-200'
  }
  return 'bg-slate-50 text-slate-600 border-slate-200'
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function BackupPostureCard() {
  const [state, setState] = useState<FetchState>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch('/api/admin/security/backup-posture', {
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
        const body = (await res.json()) as {
          summary?: BackupPostureSummary
        }
        if (!body.summary) {
          setState({ kind: 'error', message: 'empty_response' })
          return
        }
        setState({ kind: 'ready', summary: body.summary })
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

  const handleRefresh = useCallback(() => setReloadTick((n) => n + 1), [])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Backup posture</CardTitle>
              <CardSubtitle>
                Read-only. Restores are never executed from VenueRise —
                follow the disaster recovery runbook and perform restore
                actions through Supabase-approved workflows.
              </CardSubtitle>
            </div>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
            aria-label="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
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
              <div className="font-medium">Could not load backup posture</div>
              <div className="text-xs">{state.message}</div>
            </div>
          </div>
        )}

        {state.kind === 'ready' && (
          <>
            {/* Overall status row */}
            <div className="mb-4 flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center gap-2">
                {statusIcon(state.summary.status)}
                <span
                  className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${statusChipClass(state.summary.status)}`}
                >
                  {state.summary.status}
                </span>
                <span className="text-xs text-slate-600">
                  Provider: <code className="font-mono">{state.summary.provider}</code>
                </span>
              </div>
              <div className="text-xs text-slate-500">
                Last checked: {formatTime(state.summary.lastCheckedAt)}
              </div>
            </div>

            {/* Policy targets */}
            <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <PolicyCell label="RTO" value={`${state.summary.rtoHours}h`} />
              <PolicyCell label="RPO" value={`${state.summary.rpoHours}h`} />
              <PolicyCell
                label="Retention"
                value={`${state.summary.retentionDays}d`}
              />
              <PolicyCell
                label="Dry-run"
                value={state.summary.dryRunCadence}
              />
            </dl>

            {/* Checks */}
            <ul className="space-y-2">
              {state.summary.checks.map((check) => (
                <li
                  key={check.code}
                  className="rounded-md border border-slate-200 bg-white p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {statusIcon(check.status)}
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800">
                        {check.code}
                      </code>
                    </div>
                    <span
                      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${statusChipClass(check.status)}`}
                    >
                      {check.status}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-slate-600">
                    {check.message}
                  </div>
                </li>
              ))}
            </ul>

            <p className="mt-4 text-xs text-slate-500">
              Restores are never executed from VenueRise. Follow the
              disaster recovery runbook
              (<code className="font-mono">docs/DISASTER-RECOVERY.md</code>)
              and perform restore actions through Supabase-approved
              workflows. Use the &quot;Restore intent&quot; card to record
              operator intent before any out-of-app work begins.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function PolicyCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 font-mono text-sm text-slate-900">{value}</dd>
    </div>
  )
}
