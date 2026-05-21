'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Loader2,
  AlertTriangle,
  FileText,
  RefreshCw,
  Mail,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'

/**
 * Phase 9J — BuyerSecuritySummaryCard (admin/owner only).
 *
 * Shows a short prose preview + a Refresh button + a Download
 * Markdown button. The markdown is the shape an operator would
 * email after a sales call (review before sending).
 */

interface BuyerSummary {
  generatedAt: string
  overview: string
  disclaimer: string
  sections: Array<{ id: string; title: string; body: string }>
  knownLimitations: string[]
  plannedImprovements: string[]
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; summary: BuyerSummary }

export default function BuyerSecuritySummaryCard() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch(
          '/api/admin/security/buyer-security-summary?format=json',
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
        const body = (await res.json()) as { summary?: BuyerSummary }
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
              <Mail className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Buyer security summary</CardTitle>
              <CardSubtitle>
                Short prose summary suitable for emailing after a sales
                call. Review before sending — markdown export is
                audited (`buyer_security_summary_exported`).
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
              href="/api/admin/security/buyer-security-summary?format=markdown"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <FileText className="h-3.5 w-3.5" />
              Download Markdown
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
              <div className="font-medium">Could not load buyer summary</div>
              <div className="text-xs">{state.message}</div>
            </div>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <section className="mb-4">
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Overview
              </h3>
              <p className="mt-1 text-sm text-slate-700">
                {state.summary.overview}
              </p>
            </section>
            <section className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {state.summary.sections.slice(0, 4).map((s) => (
                <div
                  key={s.id}
                  className="rounded-md border border-slate-200 bg-white p-3"
                >
                  <div className="text-sm font-medium text-slate-900">
                    {s.title}
                  </div>
                  <p className="mt-1 line-clamp-4 text-xs text-slate-600">
                    {s.body}
                  </p>
                </div>
              ))}
            </section>
            <section className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <div className="mb-1 font-medium">
                Known limitations ({state.summary.knownLimitations.length})
              </div>
              <ul className="list-disc pl-5">
                {state.summary.knownLimitations.slice(0, 3).map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
                {state.summary.knownLimitations.length > 3 && (
                  <li>
                    + {state.summary.knownLimitations.length - 3} more in the
                    markdown export.
                  </li>
                )}
              </ul>
            </section>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              {state.summary.disclaimer}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
