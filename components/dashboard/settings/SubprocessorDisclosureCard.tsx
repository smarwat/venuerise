'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  FileText,
  Loader2,
  RefreshCw,
  Share2,
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
 * Phase 9K — SubprocessorDisclosureCard (admin/owner only).
 *
 * Buyer-safe subprocessor list pulled from
 * `/api/admin/security/subprocessor-disclosure`. Only includes
 * vendors flagged `disclosureStatus === 'public'`. Strips
 * evidence references (env vars + package names) so this shape
 * is safe to share with procurement / security review.
 *
 * Operators MUST review markdown export before sending — the
 * audit row is fired on export, not on JSON refresh.
 */

interface DisclosureRecord {
  id: string
  name: string
  category: string
  description: string
  dataCategories: string[]
  criticality: 'critical' | 'important' | 'optional' | 'development_only'
  riskTier: 'low' | 'medium' | 'high' | 'unknown'
}

interface Disclosure {
  generatedAt: string
  disclaimer: string
  records: DisclosureRecord[]
  counts: {
    total: number
    productionDisclosed: number
  }
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; disclosure: Disclosure }

export default function SubprocessorDisclosureCard() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch(
          '/api/admin/security/subprocessor-disclosure?format=json',
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
        const body = (await res.json()) as { disclosure?: Disclosure }
        if (!body.disclosure) {
          setState({ kind: 'error', message: 'empty_response' })
          return
        }
        setState({ kind: 'ready', disclosure: body.disclosure })
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
              <Share2 className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Subprocessor disclosure</CardTitle>
              <CardSubtitle>
                Buyer-safe list of production third-party processors.
                Markdown/CSV is the shape to share with procurement —
                this disclosure should be reviewed before sharing
                externally.
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
              href="/api/admin/security/subprocessor-disclosure?format=markdown"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <FileText className="h-3.5 w-3.5" />
              Download Markdown
            </a>
            <a
              href="/api/admin/security/subprocessor-disclosure?format=csv"
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
              <div className="font-medium">
                Could not load subprocessor disclosure
              </div>
              <div className="text-xs">{state.message}</div>
            </div>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Total disclosed"
                value={state.disclosure.counts.total}
              />
              <Stat
                label="Production"
                value={state.disclosure.counts.productionDisclosed}
              />
            </div>

            <ul className="space-y-2">
              {state.disclosure.records.map((r) => (
                <li
                  key={r.id}
                  className="rounded-md border border-slate-200 bg-white p-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-900">
                      {r.name}
                    </span>
                    <span className="text-xs text-slate-500">
                      {r.category}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">{r.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {r.dataCategories.map((d) => (
                      <span
                        key={d}
                        className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-700"
                      >
                        {d}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>

            <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              {state.disclosure.disclaimer}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 font-mono text-lg text-slate-700">{value}</dd>
    </div>
  )
}
