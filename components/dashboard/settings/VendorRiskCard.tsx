'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Boxes,
  FileText,
  Loader2,
  RefreshCw,
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
 * Phase 9K — VendorRiskCard (admin/owner only).
 *
 * Surfaces the full admin vendor risk report from
 * `/api/admin/security/vendor-risk-report`. Summary stats +
 * table of every vendor row. Markdown + CSV download buttons.
 *
 * The buyer-safe filtered view lives in the sibling
 * `SubprocessorDisclosureCard`.
 */

type Criticality = 'critical' | 'important' | 'optional' | 'development_only'
type DisclosureStatus = 'public' | 'admin_only' | 'internal_only'
type AssuranceStatus =
  | 'verified'
  | 'manual_review_required'
  | 'unknown'
  | 'not_applicable'
type RiskTier = 'low' | 'medium' | 'high' | 'unknown'

interface VendorRow {
  id: string
  name: string
  category: string
  purpose: string
  criticality: Criticality
  disclosureStatus: DisclosureStatus
  productionUse: boolean
  riskTier: RiskTier
  assuranceStatus: AssuranceStatus
  dataCategories: string[]
  knownLimitations: string[]
  reviewOwner: string
  reviewCadence: string
  lastReviewedAt: string | null
}

interface Summary {
  generatedAt: string
  disclaimer: string
  counts: {
    total: number
    production: number
    critical: number
    manualReviewRequired: number
    unknownAssurance: number
    publicDisclosable: number
  }
  vendors: VendorRow[]
  warnings: string[]
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; summary: Summary }

export default function VendorRiskCard() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch(
          '/api/admin/security/vendor-risk-report?format=json',
          { method: 'GET', signal: abort.signal, credentials: 'same-origin' }
        )
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
        const body = (await res.json()) as { summary?: Summary }
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
              <Boxes className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Vendor risk + assurance</CardTitle>
              <CardSubtitle>
                Internal registry of every third-party processor.
                DPA/SCC/SOC&nbsp;2 evidence is collected outside this
                table — review vendor legal/security artifacts before
                sending to procurement.
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
              href="/api/admin/security/vendor-risk-report?format=markdown"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <FileText className="h-3.5 w-3.5" />
              Download Markdown
            </a>
            <a
              href="/api/admin/security/vendor-risk-report?format=csv"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <Sheet className="h-3.5 w-3.5" />
              Download CSV
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
              <div className="font-medium">Could not load vendor risk report</div>
              <div className="text-xs">{state.message}</div>
            </div>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Total" value={state.summary.counts.total} tone="slate" />
              <Stat
                label="Production"
                value={state.summary.counts.production}
                tone="slate"
              />
              <Stat
                label="Critical"
                value={state.summary.counts.critical}
                tone="red"
              />
              <Stat
                label="Manual review"
                value={state.summary.counts.manualReviewRequired}
                tone="amber"
              />
              <Stat
                label="Unknown"
                value={state.summary.counts.unknownAssurance}
                tone="amber"
              />
            </dl>

            {state.summary.warnings.length > 0 && (
              <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <div className="mb-1 font-medium">Registry warnings</div>
                <ul className="list-disc pl-5">
                  {state.summary.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="border-b border-slate-200 py-2 pr-3">Vendor</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Purpose</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Criticality</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Risk</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Assurance</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {state.summary.vendors.map((v) => (
                    <tr key={v.id}>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top">
                        <div className="font-medium text-slate-900">{v.name}</div>
                        <div className="text-xs text-slate-500">{v.category}</div>
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs text-slate-600">
                        <div className="line-clamp-3">{v.purpose}</div>
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top">
                        <CriticalityChip value={v.criticality} />
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top">
                        <RiskChip value={v.riskTier} />
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top">
                        <AssuranceChip value={v.assuranceStatus} />
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs text-slate-600">
                        {v.dataCategories.length}{' '}
                        <span className="text-slate-400">categor{v.dataCategories.length === 1 ? 'y' : 'ies'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
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
  tone: 'slate' | 'amber' | 'red'
}) {
  const toneClass =
    tone === 'amber'
      ? 'text-amber-700'
      : tone === 'red'
        ? 'text-red-700'
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

function chip(text: string, classes: string): JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${classes}`}
    >
      {text}
    </span>
  )
}

function CriticalityChip({ value }: { value: Criticality }) {
  if (value === 'critical')
    return chip('critical', 'bg-red-50 text-red-700 border-red-200')
  if (value === 'important')
    return chip('important', 'bg-amber-50 text-amber-700 border-amber-200')
  if (value === 'development_only')
    return chip('dev only', 'bg-slate-50 text-slate-500 border-slate-200')
  return chip('optional', 'bg-slate-50 text-slate-600 border-slate-200')
}

function RiskChip({ value }: { value: RiskTier }) {
  if (value === 'high')
    return chip('high', 'bg-red-50 text-red-700 border-red-200')
  if (value === 'medium')
    return chip('medium', 'bg-amber-50 text-amber-700 border-amber-200')
  if (value === 'low')
    return chip('low', 'bg-emerald-50 text-emerald-700 border-emerald-200')
  return chip('unknown', 'bg-slate-50 text-slate-600 border-slate-200')
}

function AssuranceChip({ value }: { value: AssuranceStatus }) {
  if (value === 'verified')
    return chip('verified', 'bg-emerald-50 text-emerald-700 border-emerald-200')
  if (value === 'manual_review_required')
    return chip('manual review', 'bg-amber-50 text-amber-700 border-amber-200')
  if (value === 'not_applicable')
    return chip('n/a', 'bg-slate-50 text-slate-500 border-slate-200')
  return chip('unknown', 'bg-red-50 text-red-700 border-red-200')
}
