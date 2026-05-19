'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  CalendarClock,
  Loader2,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/dashboard/ui/Dialog'
import { Badge } from '@/components/dashboard/ui/Badge'
import { Button } from '@/components/dashboard/ui/Button'
import {
  actionLabel,
  actorLabel,
  formatAuditTime,
  statusLabel,
  type TourStatusActorKind,
  type TourStatusEvent,
} from './tour-audit-types'

/**
 * Phase 8N — per-tour audit drawer.
 *
 * Renders the full `tour_status_events` history for a single tour via the
 * Phase 8M admin endpoint:
 *
 *   GET /api/admin/tours/status-events?tour_id=<id>&limit=50
 *
 * Mount this ONCE near the top of a page (parent owns the open state +
 * the selected tour id). Clicking an Audit button on a tour row swaps
 * the tour id + opens the drawer; the drawer fetches on every (open=true,
 * tourId) transition.
 *
 * Visual identity: standard `Dialog` primitive. Each row is a slate card
 * with an actor chip + action label + previous→new pill + occurred-at
 * timestamp. Reason (if present) is its own line under the pill. Metadata
 * is collapsed by default and pretty-printed only on expand — keeps the
 * default state scannable for the common "what just happened?" question.
 *
 * Auth: the admin endpoint enforces `requireAdmin()`. Non-admin users
 * who somehow open this drawer (shouldn't be possible — parent surfaces
 * gate the trigger) get a friendly "no permission" empty state instead
 * of a raw 401/403.
 */

interface TourAuditDrawerProps {
  tourId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

type FetchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; items: TourStatusEvent[] }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string }

const ACTOR_BADGE_VARIANT: Record<
  TourStatusActorKind,
  React.ComponentProps<typeof Badge>['variant']
> = {
  lead_token: 'blue',
  operator: 'navy',
  cron: 'default',
  system: 'default',
}

function statusTransitionLabel(
  prev: string | null,
  next: string
): { from: string; to: string } {
  return {
    from: statusLabel(prev),
    to: statusLabel(next),
  }
}

export default function TourAuditDrawer({
  tourId,
  open,
  onOpenChange,
}: TourAuditDrawerProps) {
  const [state, setState] = useState<FetchState>({ kind: 'idle' })
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // Phase 8O — manual refresh state. Bumping `refreshTick` re-runs the
  // fetch effect without changing `open` or `tourId`. Tracked separately
  // from `state.kind === 'loading'` so the operator gets a small spinner
  // on the button while keeping the existing rows visible (no UI shuffle).
  const [refreshTick, setRefreshTick] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  // Phase 8O — extracted into a useCallback so both the effect AND the
  // refresh button can trigger it. The button bumps `refreshTick`, which
  // is also the effect's dep, so we have one fetch path.
  const fetchEvents = useCallback(
    async (
      targetTourId: string,
      abort: AbortController,
      opts: { silent?: boolean } = {}
    ): Promise<void> => {
      if (!opts.silent) setState({ kind: 'loading' })
      try {
        const url = `/api/admin/tours/status-events?tour_id=${encodeURIComponent(targetTourId)}&limit=50`
        const res = await fetch(url, {
          method: 'GET',
          signal: abort.signal,
          credentials: 'same-origin',
        })
        if (res.status === 401 || res.status === 403) {
          setState({ kind: 'forbidden' })
          return
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null
          const code =
            body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
          setState({ kind: 'error', message: code })
          return
        }
        const body = (await res.json()) as { items?: TourStatusEvent[] } | null
        const items = (body?.items ?? []) as TourStatusEvent[]
        setState({ kind: 'success', items })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        })
      }
    },
    []
  )

  // Fetch on (open, tourId, refreshTick) transitions. We rebuild state
  // on every (open, tourId) change so a stale "success" from a previous
  // tour doesn't bleed in if the operator opens A, closes, then opens B.
  // Refresh-button clicks bump `refreshTick` which re-runs WITHOUT the
  // pre-fetch state reset (we keep the rows visible during refetch).
  useEffect(() => {
    if (!open || !tourId) {
      setState({ kind: 'idle' })
      setExpandedRowId(null)
      setCopiedId(null)
      setRefreshing(false)
      return
    }
    const abort = new AbortController()
    const silent = refreshTick > 0
    if (silent) setRefreshing(true)
    void fetchEvents(tourId, abort, { silent }).finally(() => {
      setRefreshing(false)
    })
    return () => {
      abort.abort()
    }
  }, [open, tourId, refreshTick, fetchEvents])

  const handleRefresh = useCallback(() => {
    if (refreshing || !tourId) return
    setRefreshTick((n) => n + 1)
  }, [refreshing, tourId])

  async function copyId(id: string) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(id)
        setCopiedId(id)
        setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500)
      }
    } catch {
      // Clipboard might be blocked (older browsers, embedded contexts) —
      // we silently fail rather than throwing a noisy toast. Operators
      // can always copy from devtools.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tour audit history</DialogTitle>
          <DialogDescription>
            Every status change for this tour, newest first. Covers
            lead-token, operator, cron, and system actions.
          </DialogDescription>
          {/* Phase 8O — manual refresh. Click to re-run the same
              status-events query without closing/reopening. The realtime
              layer (RealtimeTourStatusLayer) drives most refreshes for
              free; this button is the operator's escape hatch when
              they want to confirm the drawer matches the DB right now.
              Loading is localized: rows stay visible during refresh. */}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || !tourId}
            className="absolute top-5 right-12 inline-flex items-center gap-1 text-[11px] text-[#475569] hover:text-[#0F172A] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Refresh audit events"
          >
            {refreshing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </DialogHeader>

        <div className="px-6 py-4 max-h-[60vh] overflow-y-auto">
          {state.kind === 'loading' && (
            <div className="flex items-center gap-2 text-[13px] text-[#475569] py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading audit events…
            </div>
          )}

          {state.kind === 'forbidden' && (
            <div className="text-center py-8">
              <div className="w-11 h-11 rounded-xl bg-[#F1F5F9] flex items-center justify-center mx-auto mb-2.5">
                <AlertTriangle className="w-5 h-5 text-[#475569]" />
              </div>
              <p className="text-[13px] text-[#475569]">
                You don&apos;t have permission to view this tour&apos;s audit history.
              </p>
            </div>
          )}

          {state.kind === 'error' && (
            <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2.5 text-[12px] text-[#B91C1C]">
              Couldn&apos;t load audit events: {state.message}
            </div>
          )}

          {state.kind === 'success' && state.items.length === 0 && (
            <div className="text-center py-8">
              <div className="w-11 h-11 rounded-xl bg-[#F1F5F9] flex items-center justify-center mx-auto mb-2.5">
                <CalendarClock className="w-5 h-5 text-[#0F172A]" />
              </div>
              <p className="text-[13px] text-[#475569]">
                No audit events recorded for this tour yet.
              </p>
            </div>
          )}

          {state.kind === 'success' && state.items.length > 0 && (
            <ul className="space-y-2.5">
              {state.items.map((event) => {
                const isExpanded = expandedRowId === event.id
                const isCopied = copiedId === event.id
                const transition = statusTransitionLabel(
                  event.previous_status,
                  event.new_status
                )
                return (
                  <li
                    key={event.id}
                    className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-3.5 py-3"
                  >
                    <div className="flex items-start gap-2.5 flex-wrap">
                      <Badge variant={ACTOR_BADGE_VARIANT[event.actor_kind] ?? 'default'}>
                        {actorLabel(event.actor_kind)}
                      </Badge>
                      <span className="text-[13px] font-semibold text-[#0F172A]">
                        {actionLabel(event.action)}
                      </span>
                      <span className="text-[11px] text-[#94A3B8]">
                        {transition.from} → {transition.to}
                      </span>
                      <span className="ml-auto text-[11px] text-[#64748B] whitespace-nowrap">
                        {formatAuditTime(event.occurred_at)}
                      </span>
                    </div>

                    {event.reason && (
                      <p className="mt-1.5 text-[12px] text-[#475569]">
                        <span className="text-[#94A3B8]">Reason:</span> {event.reason}
                      </p>
                    )}

                    <div className="mt-2 flex items-center gap-2 text-[11px]">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-[#1D4ED8] hover:text-[#1E40AF] transition-colors"
                        onClick={() =>
                          setExpandedRowId((current) =>
                            current === event.id ? null : event.id
                          )
                        }
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-3 h-3" />
                        ) : (
                          <ChevronRight className="w-3 h-3" />
                        )}
                        Details
                      </button>
                      <button
                        type="button"
                        onClick={() => copyId(event.id)}
                        className="inline-flex items-center gap-1 text-[#64748B] hover:text-[#0F172A] transition-colors"
                      >
                        {isCopied ? (
                          <Check className="w-3 h-3 text-[#059669]" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        {isCopied ? 'Copied' : 'Copy event id'}
                      </button>
                    </div>

                    {isExpanded && (
                      <div className="mt-2.5 rounded-lg bg-white border border-[#E2E8F0] px-3 py-2.5 space-y-2 text-[11px]">
                        {event.actor_id && (
                          <div className="flex gap-2">
                            <span className="w-24 shrink-0 text-[#94A3B8]">
                              Actor id
                            </span>
                            <span className="text-[#0F172A] font-mono break-all">
                              {event.actor_id}
                            </span>
                          </div>
                        )}
                        {event.source_ip && (
                          <div className="flex gap-2">
                            <span className="w-24 shrink-0 text-[#94A3B8]">
                              Source IP
                            </span>
                            <span className="text-[#0F172A] font-mono">
                              {event.source_ip}
                            </span>
                          </div>
                        )}
                        {event.user_agent && (
                          <div className="flex gap-2">
                            <span className="w-24 shrink-0 text-[#94A3B8]">
                              User agent
                            </span>
                            <span className="text-[#475569] break-all">
                              {event.user_agent}
                            </span>
                          </div>
                        )}
                        <div className="flex gap-2">
                          <span className="w-24 shrink-0 text-[#94A3B8]">Metadata</span>
                          <pre className="flex-1 text-[#0F172A] font-mono whitespace-pre-wrap break-all bg-[#F8FAFC] rounded p-2 m-0">
                            {JSON.stringify(event.metadata ?? {}, null, 2)}
                          </pre>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
