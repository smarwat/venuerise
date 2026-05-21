'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  FileText,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sheet,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'

/**
 * Phase 9M — PrivacyReadinessCard (admin/owner only).
 *
 * Surfaces the privacy data inventory + retention policy + DSR
 * counts in-product. Markdown / CSV exports are audited; JSON
 * refreshes are not.
 *
 * Honesty disclaimer in footer: "Privacy readiness is not legal
 * compliance. Review with counsel before making external
 * claims."
 */

interface ReadinessSummary {
  generatedAt: string
  disclaimer: string
  counts: {
    totalCategories: number
    highOrRestrictedSensitivity: number
    exportReady: number
    deletionReady: number
    manualReview: number
    retentionPolicyRows: number
  }
  dsrCounts: {
    total: number
    open: number
    awaitingLegalReview: number
    fulfilled: number
    denied: number
    cancelled: number
    overdue: number
  }
  inventory: Array<{
    id: string
    category: string
    displayName: string
    sensitivity: string
    retentionBasis: string
    defaultRetention: string
    exportable: boolean
    deletable: boolean
    correctionSupported: boolean
    controlStatus: string
    vendorIds: string[]
  }>
  retentionPolicy: Array<{
    category: string
    defaultWindow: string
    reason: string
    automationStatus: string
  }>
  warnings: string[]
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; summary: ReadinessSummary }

export default function PrivacyReadinessCard() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch('/api/admin/privacy/readiness?format=json', {
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
        const body = (await res.json()) as { summary?: ReadinessSummary }
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
              <CardTitle>Privacy readiness</CardTitle>
              <CardSubtitle>
                Data inventory + retention policy + DSR counts.
                Privacy readiness is NOT legal compliance — review
                with counsel before making external claims.
              </CardSubtitle>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
            <a
              href="/api/admin/privacy/readiness?format=markdown"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <FileText className="h-3.5 w-3.5" />
              Download Markdown
            </a>
            <a
              href="/api/admin/privacy/readiness?format=csv&csv_kind=inventory"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <Sheet className="h-3.5 w-3.5" />
              Inventory CSV
            </a>
            <a
              href="/api/admin/privacy/readiness?format=csv&csv_kind=retention"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <Sheet className="h-3.5 w-3.5" />
              Retention CSV
            </a>
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
              <div className="font-medium">
                Could not load privacy readiness
              </div>
              <div className="text-xs">{state.message}</div>
            </div>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Categories"
                value={state.summary.counts.totalCategories}
                tone="slate"
              />
              <Stat
                label="High / restricted"
                value={state.summary.counts.highOrRestrictedSensitivity}
                tone="amber"
              />
              <Stat
                label="Export-ready"
                value={state.summary.counts.exportReady}
                tone="emerald"
              />
              <Stat
                label="Deletion-ready"
                value={state.summary.counts.deletionReady}
                tone="emerald"
              />
              <Stat
                label="Manual review"
                value={state.summary.counts.manualReview}
                tone="amber"
              />
              <Stat
                label="Retention rows"
                value={state.summary.counts.retentionPolicyRows}
                tone="slate"
              />
              <Stat
                label="Open DSRs"
                value={state.summary.dsrCounts.open}
                tone={state.summary.dsrCounts.open > 0 ? 'amber' : 'slate'}
              />
              <Stat
                label="Overdue DSRs"
                value={state.summary.dsrCounts.overdue}
                tone={state.summary.dsrCounts.overdue > 0 ? 'red' : 'slate'}
              />
            </dl>

            {state.summary.warnings.length > 0 && (
              <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <div className="mb-1 font-medium">Warnings</div>
                <ul className="list-disc pl-5">
                  {state.summary.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
              Data inventory
            </h4>
            <div className="mb-4 overflow-x-auto">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="border-b border-slate-200 py-2 pr-3">Category</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Sensitivity</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Retention</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Export</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Delete</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {state.summary.inventory.map((i) => (
                    <tr key={i.id}>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top">
                        <div className="font-medium text-slate-900">
                          {i.displayName}
                        </div>
                        <div className="text-xs text-slate-500">{i.category}</div>
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top">
                        <SensitivityChip value={i.sensitivity} />
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs text-slate-600">
                        {i.retentionBasis}
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top">
                        <YesNo value={i.exportable} />
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top">
                        <YesNo value={i.deletable} />
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top">
                        <ControlChip value={i.controlStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
              Retention policy
            </h4>
            <ul className="mb-4 space-y-2">
              {state.summary.retentionPolicy.map((r) => (
                <li
                  key={r.category}
                  className="rounded-md border border-slate-200 bg-white p-3 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-900">
                      {r.category}
                    </span>
                    <ControlChip value={r.automationStatus} />
                  </div>
                  <div className="mt-1 text-slate-700">{r.defaultWindow}</div>
                  <div className="mt-1 text-slate-500">{r.reason}</div>
                </li>
              ))}
            </ul>

            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              {state.summary.disclaimer}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'slate' | 'amber' | 'red' | 'emerald'
}) {
  const toneClass =
    tone === 'amber'
      ? 'text-amber-700'
      : tone === 'red'
        ? 'text-red-700'
        : tone === 'emerald'
          ? 'text-emerald-700'
          : 'text-slate-700'
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className={`mt-0.5 font-mono text-lg ${toneClass}`}>{value}</dd>
    </div>
  )
}

function chip(text: string, classes: string) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${classes}`}
    >
      {text}
    </span>
  )
}

function SensitivityChip({ value }: { value: string }) {
  if (value === 'restricted')
    return chip('restricted', 'bg-red-50 text-red-700 border-red-200')
  if (value === 'high')
    return chip('high', 'bg-amber-50 text-amber-700 border-amber-200')
  if (value === 'moderate')
    return chip('moderate', 'bg-slate-50 text-slate-700 border-slate-200')
  return chip('low', 'bg-emerald-50 text-emerald-700 border-emerald-200')
}

function ControlChip({ value }: { value: string }) {
  if (value === 'implemented')
    return chip(
      'implemented',
      'bg-emerald-50 text-emerald-700 border-emerald-200'
    )
  if (value === 'partial')
    return chip('partial', 'bg-amber-50 text-amber-700 border-amber-200')
  if (value === 'manual')
    return chip('manual', 'bg-slate-50 text-slate-700 border-slate-200')
  if (value === 'planned')
    return chip('planned', 'bg-slate-50 text-slate-500 border-slate-200')
  return chip('unknown', 'bg-red-50 text-red-700 border-red-200')
}

function YesNo({ value }: { value: boolean }) {
  return value
    ? chip('yes', 'bg-emerald-50 text-emerald-700 border-emerald-200')
    : chip('no', 'bg-slate-50 text-slate-500 border-slate-200')
}
