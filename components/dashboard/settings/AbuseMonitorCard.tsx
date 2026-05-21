'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Loader2,
  AlertTriangle,
  Download,
  ShieldAlert,
  RefreshCw,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'

/**
 * Phase 9F — AbuseMonitorCard.
 *
 * Surfaces `public.abuse_events` (migration 029) for the operator.
 * Reads `/api/admin/security/abuse-events` (Phase 9F admin endpoint).
 *
 * Three panels:
 *   1. Summary chips — top route, top reason, top limiter key
 *      derived from the visible slice (most-recent 50 by default).
 *   2. Recent rows table — when, route, method, limiter key, reason.
 *   3. CSV export + Load older.
 *
 * Admin/owner only — both the page-level isAdmin gate AND the
 * endpoint's `requireAdmin()` enforce it.
 *
 * ── COPY POSTURE ─────────────────────────────────────────────────────────
 * Operational language. "Blocked attempts" is the right framing —
 * we're showing rate-limited requests, NOT proven attacks. The card
 * helps an operator answer "is my widget getting hammered?" not
 * "am I under attack right now?"
 */

const PAGE_SIZE = 50

interface AbuseEventListItem {
  id: string
  venue_id: string | null
  user_id: string | null
  route: string
  method: string
  limiter_key: string
  ip_hash: string | null
  reason: string
  metadata: Record<string, unknown> | null
  created_at: string
}

interface AbuseEventSummary {
  total: number
  by_route: Record<string, number>
  by_reason: Record<string, number>
  by_limiter_key: Record<string, number>
}

type FeedState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      items: AbuseEventListItem[]
      summary: AbuseEventSummary
      nextCursor: string | null
      hasMore: boolean
      loadingMore: boolean
      loadMoreError: string | null
    }

function topN(map: Record<string, number>, n: number): Array<[string, number]> {
  return Object.entries(map)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n)
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

export default function AbuseMonitorCard() {
  const [state, setState] = useState<FeedState>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)

  // Initial fetch + manual reload via reloadTick.
  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch(
          `/api/admin/security/abuse-events?limit=${PAGE_SIZE}`,
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
        const body = (await res.json()) as {
          items?: AbuseEventListItem[]
          summary?: AbuseEventSummary
          next_cursor?: string | null
          has_more?: boolean
        }
        setState({
          kind: 'ready',
          items: Array.isArray(body.items) ? body.items : [],
          summary:
            body.summary ?? {
              total: 0,
              by_route: {},
              by_reason: {},
              by_limiter_key: {},
            },
          nextCursor:
            typeof body.next_cursor === 'string' ? body.next_cursor : null,
          hasMore: Boolean(body.has_more),
          loadingMore: false,
          loadMoreError: null,
        })
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

  const handleLoadMore = useCallback(async () => {
    if (state.kind !== 'ready' || !state.hasMore || !state.nextCursor) return
    setState({ ...state, loadingMore: true, loadMoreError: null })
    try {
      const params = new URLSearchParams()
      params.set('limit', String(PAGE_SIZE))
      params.set('occurred_before', state.nextCursor)
      const res = await fetch(
        `/api/admin/security/abuse-events?${params.toString()}`,
        { method: 'GET', credentials: 'same-origin' }
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: unknown }
          | null
        const code =
          body && typeof body.error === 'string'
            ? body.error
            : `HTTP ${res.status}`
        setState((prev) =>
          prev.kind === 'ready'
            ? { ...prev, loadingMore: false, loadMoreError: code }
            : prev
        )
        return
      }
      const body = (await res.json()) as {
        items?: AbuseEventListItem[]
        next_cursor?: string | null
        has_more?: boolean
      }
      const newItems = Array.isArray(body.items) ? body.items : []
      setState((prev) =>
        prev.kind === 'ready'
          ? {
              ...prev,
              items: [...prev.items, ...newItems],
              nextCursor:
                typeof body.next_cursor === 'string' ? body.next_cursor : null,
              hasMore: Boolean(body.has_more),
              loadingMore: false,
              loadMoreError: null,
            }
          : prev
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error'
      setState((prev) =>
        prev.kind === 'ready'
          ? { ...prev, loadingMore: false, loadMoreError: message }
          : prev
      )
    }
  }, [state])

  // CSV link covers the visible slice's filters (currently no filters
  // are user-facing — full slice). limit=200 mirrors the audit-events
  // card convention.
  const csvHref = '/api/admin/security/abuse-events?format=csv&limit=200'

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <ShieldAlert className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Abuse monitor</CardTitle>
              <CardSubtitle>
                Rate-limit blocks on this venue. Public-route blocks
                (widget, CSP) are not shown here — inspect via SQL editor
                if needed.
              </CardSubtitle>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setReloadTick((n) => n + 1)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              aria-label="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
            <a
              href={csvHref}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <Download className="h-3.5 w-3.5" />
              CSV
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
              <div className="font-medium">Could not load abuse events</div>
              <div className="text-xs">{state.message}</div>
            </div>
          </div>
        )}

        {state.kind === 'ready' && (
          <>
            {/* Summary chips */}
            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <SummaryColumn
                label="Top routes"
                rows={topN(state.summary.by_route, 3)}
                empty="No blocks in slice"
              />
              <SummaryColumn
                label="Top reasons"
                rows={topN(state.summary.by_reason, 3)}
                empty="No blocks in slice"
              />
              <SummaryColumn
                label="Top limiter keys"
                rows={topN(state.summary.by_limiter_key, 3)}
                empty="No blocks in slice"
              />
            </div>

            {state.items.length === 0 && (
              <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
                No abuse events recorded yet. Rate-limit blocks will
                appear here when an operator (or a hostile client)
                exceeds a per-route budget.
              </div>
            )}

            {state.items.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-200 text-xs font-medium uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">When</th>
                      <th className="py-2 pr-3">Route</th>
                      <th className="py-2 pr-3">Method</th>
                      <th className="py-2 pr-3">Limiter</th>
                      <th className="py-2 pr-3">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.items.map((item) => (
                      <tr
                        key={item.id}
                        className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
                      >
                        <td className="whitespace-nowrap py-2 pr-3 text-slate-700">
                          {formatTime(item.created_at)}
                        </td>
                        <td className="py-2 pr-3">
                          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800">
                            {item.route}
                          </code>
                        </td>
                        <td className="py-2 pr-3 text-xs text-slate-700">
                          {item.method}
                        </td>
                        <td className="py-2 pr-3 text-xs text-slate-600">
                          <code className="font-mono">{item.limiter_key}</code>
                        </td>
                        <td className="py-2 pr-3 text-xs text-slate-600">
                          {item.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {state.hasMore && (
              <div className="mt-4 flex flex-col items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  onClick={handleLoadMore}
                  disabled={state.loadingMore}
                >
                  {state.loadingMore && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  Load older
                </button>
                {state.loadMoreError && (
                  <div className="text-xs text-amber-700">
                    {state.loadMoreError}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function SummaryColumn({
  label,
  rows,
  empty,
}: {
  label: string
  rows: Array<[string, number]>
  empty: string
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-slate-400">{empty}</div>
      ) : (
        <ul className="space-y-1 text-xs">
          {rows.map(([key, count]) => (
            <li key={key} className="flex items-baseline justify-between gap-2">
              <code className="truncate font-mono text-slate-800">{key}</code>
              <span className="flex-shrink-0 font-medium text-slate-700">
                {count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
