'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  FileText,
  Loader2,
  RefreshCw,
  ScrollText,
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
 * Phase 9P — CommitmentsReadinessCard (admin/owner only).
 *
 * Surfaces the readiness summary: counts + unsupported-risk
 * flags + upcoming reviews + warnings. Markdown + CSV exports
 * are audited via `commitments_readiness_exported`.
 */

interface UnsupportedFlag {
  commitmentId: string
  area: string
  title: string
  riskLevel: string
  reason: string
}

interface UpcomingReview {
  id: string
  commitmentArea: string
  riskLevel: string
  title: string
  reviewAt: string | null
  buyerCompany: string | null
  buyerName: string | null
}

interface Summary {
  generatedAt: string
  disclaimer: string
  counts: {
    total: number
    active: number
    highRisk: number
    criticalRisk: number
    overdueReview: number
    dueWithin30Days: number
    unsupportedRiskFlags: number
  }
  upcomingReviews: UpcomingReview[]
  unsupportedRiskFlags: UnsupportedFlag[]
  warnings: string[]
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; summary: Summary }

export default function CommitmentsReadinessCard() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch(
          '/api/admin/security/commitments/readiness?format=json',
          { signal: abort.signal, credentials: 'same-origin' }
        )
        if (!res.ok) {
          setState({ kind: 'error', message: `HTTP ${res.status}` })
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
              <ScrollText className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Commitments readiness</CardTitle>
              <CardSubtitle>
                Per-venue snapshot of recorded commitments + unsupported-
                risk flags + upcoming reviews. NOT legal advice and NOT
                contractual compliance proof.
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
              href="/api/admin/security/commitments/readiness?format=markdown"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <FileText className="h-3.5 w-3.5" />
              Download Markdown
            </a>
            <a
              href="/api/admin/security/commitments/readiness?format=csv"
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
            <div>Could not load readiness: {state.message}</div>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Total" value={state.summary.counts.total} />
              <Stat
                label="Active"
                value={state.summary.counts.active}
                tone="emerald"
              />
              <Stat
                label="High+critical"
                value={
                  state.summary.counts.highRisk +
                  state.summary.counts.criticalRisk
                }
                tone="amber"
              />
              <Stat
                label="Unsupported flags"
                value={state.summary.counts.unsupportedRiskFlags}
                tone={
                  state.summary.counts.unsupportedRiskFlags > 0
                    ? 'red'
                    : 'slate'
                }
              />
            </dl>

            {state.summary.warnings.length > 0 && (
              <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                {state.summary.warnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            )}

            {state.summary.unsupportedRiskFlags.length > 0 && (
              <section className="mb-4">
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                  Unsupported-risk flags
                </h4>
                <ul className="space-y-2">
                  {state.summary.unsupportedRiskFlags.map((f) => (
                    <li
                      key={f.commitmentId}
                      className="rounded-md border border-red-200 bg-red-50 p-3 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-red-900">
                          {f.title}
                        </span>
                        <span className="inline-flex items-center rounded-md border border-red-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                          {f.area}
                        </span>
                        <span className="inline-flex items-center rounded-md border border-red-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                          risk: {f.riskLevel}
                        </span>
                      </div>
                      <div className="mt-1 text-red-900">{f.reason}</div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {state.summary.upcomingReviews.length > 0 && (
              <section className="mb-4">
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                  Upcoming reviews
                </h4>
                <ul className="space-y-1">
                  {state.summary.upcomingReviews.map((r) => (
                    <li
                      key={r.id}
                      className="rounded-md border border-slate-200 bg-white p-2 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-slate-900">
                          {r.title}
                        </span>
                        <span className="text-slate-500">
                          {r.reviewAt
                            ? new Date(r.reviewAt).toLocaleDateString()
                            : 'unscheduled'}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {r.commitmentArea} · {r.riskLevel} ·{' '}
                        {r.buyerCompany ?? r.buyerName ?? '—'}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

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
  tone = 'slate',
}: {
  label: string
  value: number
  tone?: 'slate' | 'amber' | 'red' | 'emerald'
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
