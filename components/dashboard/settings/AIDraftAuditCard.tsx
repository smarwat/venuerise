'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Search,
  Download,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { Badge } from '@/components/dashboard/ui/Badge'
import { cn } from '@/lib/utils'
import { formatDistanceToNow } from 'date-fns'

/**
 * Phase 8AN → 8AO — AI Draft Activity audit card.
 *
 * 8AN: client-side fetch from Supabase + ai_action/messages joins for
 *      the accepted-variant lookup.
 * 8AO: backend admin endpoint `/api/admin/ai/draft-audit` centralizes
 *      the lead-name join + masks emails before they leave the server,
 *      plus adds cursor pagination, CSV export, and a realtime refresh
 *      hook driven by `RealtimeAIDraftAuditLayer`.
 *
 * UX:
 *   - Filter chips: All / Successful / Failed (server-side via `status`)
 *   - Search input over scalar columns + `metadata->>instruction`
 *     (server-side via `q`)
 *   - "Refresh" forces a fresh page-1 fetch
 *   - "Export CSV" hits the same endpoint with `format=csv`
 *   - "Load older" appends the next page (strict `< created_at` cursor)
 *   - Inline "New draft activity recorded" banner appears when the
 *     realtime layer fires `venuerise:ai-draft-audit-fired`; clicking
 *     refreshes
 *
 * Admin-only — the route enforces `requireAdmin()` so non-admins see
 * 401/403 on the network call. The card surrounds itself with an
 * `isAdmin` gate at the page level (`/dashboard/settings/billing`).
 */

interface ApiItem {
  id: string
  venue_id: string
  lead_id: string | null
  lead_name: string | null
  lead_email_masked: string | null
  success: boolean
  instruction: string | null
  variant_count: number | null
  accepted_variant_index: number | null
  latency_ms: number | null
  error: string | null
  created_at: string
  // Phase 8AV — confidence audit fields. Older rows (pre-8AV)
  // come back as null/false because the route can't backfill them.
  min_confidence: number | null
  low_confidence: boolean
  // Phase 8AW — calibration detail. Per-row "Final · Model ·
  // Heuristic" line under the existing chips. Older rows (pre-8AW)
  // come back with null fields and we skip the line entirely.
  model_confidence: number | null
  heuristic_confidence: number | null
  final_confidence: number | null
  adjustment_delta: number | null
  confidence_source:
    | 'model_and_heuristic'
    | 'heuristic_fallback'
    | null
  operator_outcome:
    | 'sent_as_is'
    | 'sent_after_edit'
    | 'regenerated'
    | 'abandoned'
    | 'unknown'
    | null
  edit_distance_bucket:
    | 'none'
    | 'minor'
    | 'moderate'
    | 'major'
    | 'unknown'
    | null
  // Phase 8AX — autopilot guardrail decision for the row's
  // selected variant (or array min, when nothing accepted). Pre-
  // 8AX rows surface as null/empty; the detail line hides those.
  autopilot_mode: 'eligible' | 'review_required' | 'blocked' | null
  autopilot_reasons: string[]
  risk_flags: string[]
}

type Filter = 'all' | 'success' | 'failed' | 'low_confidence'

type PageState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      items: ApiItem[]
      hasMore: boolean
      nextCursor: string | null
    }

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'success', label: 'Successful' },
  { value: 'failed', label: 'Failed' },
  // Phase 8AV — surfaces rows where the regenerate call produced
  // at least one variant whose confidence fell below the venue's
  // Brand Voice floor (set on RevenueOsSettingsCard).
  { value: 'low_confidence', label: 'Low confidence' },
]

const REALTIME_EVENT = 'venuerise:ai-draft-audit-fired'

const OUTCOME_LABEL: Record<
  Exclude<NonNullable<ApiItem['operator_outcome']>, 'unknown'>,
  string
> = {
  sent_as_is: 'sent as-is',
  sent_after_edit: 'sent after edit',
  regenerated: 'regenerated',
  abandoned: 'abandoned',
}

// Phase 8AX — short labels for the per-row detail line. The full
// label (e.g. "Autopilot eligible") is what the drawer pill shows;
// the audit row is more space-constrained so we render the verb
// form ("Eligible" / "Review" / "Blocked").
const AUTOPILOT_LABEL: Record<
  NonNullable<ApiItem['autopilot_mode']>,
  string
> = {
  eligible: 'Eligible',
  review_required: 'Review required',
  blocked: 'Blocked',
}

/**
 * Build the tooltip surfaced on hover of the per-row calibration
 * detail line. Spells out the abbreviations + shows the adjustment
 * delta when both model + heuristic numbers exist so the operator
 * sees how conservative the final score was.
 */
function buildConfidenceTooltip(a: ApiItem): string {
  const parts: string[] = []
  if (a.final_confidence !== null) {
    parts.push(`Final shown to operator: ${a.final_confidence}/100`)
  }
  if (a.model_confidence !== null) {
    parts.push(`Model self-rating: ${a.model_confidence}/100`)
  }
  if (a.heuristic_confidence !== null) {
    parts.push(`Heuristic check: ${a.heuristic_confidence}/100`)
  }
  if (a.adjustment_delta !== null) {
    const sign = a.adjustment_delta > 0 ? '+' : ''
    parts.push(`Adjustment vs model: ${sign}${a.adjustment_delta}`)
  }
  if (a.confidence_source === 'heuristic_fallback') {
    parts.push("Model didn't emit a confidence; heuristic carried this row.")
  }
  if (a.operator_outcome && a.operator_outcome !== 'unknown') {
    parts.push(`Operator outcome: ${OUTCOME_LABEL[a.operator_outcome]}`)
  }
  if (
    a.edit_distance_bucket &&
    a.edit_distance_bucket !== 'none' &&
    a.edit_distance_bucket !== 'unknown'
  ) {
    parts.push(`Edits before send: ${a.edit_distance_bucket}`)
  }
  if (a.autopilot_mode) {
    parts.push(`Autopilot decision: ${AUTOPILOT_LABEL[a.autopilot_mode]}`)
    if (a.autopilot_reasons.length > 0) {
      parts.push(`Reasons: ${a.autopilot_reasons.join(', ')}`)
    }
  }
  if (a.risk_flags.length > 0) {
    parts.push(`Risk flags: ${a.risk_flags.join(', ')}`)
  }
  return parts.join('\n')
}

interface AIDraftAuditCardProps {
  venueId: string
}

export default function AIDraftAuditCard({ venueId }: AIDraftAuditCardProps) {
  const [state, setState] = useState<PageState>({ kind: 'loading' })
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  // Debounce the q -> server fetch so we don't whale on the route on
  // every keystroke. Filter chip + manual refresh fire immediately.
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [reloadTick, setReloadTick] = useState(0)
  // Localized "Load older" + "Export CSV" loading flags so the main
  // card body doesn't flash a loading state when only one button is
  // working.
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadOlderError, setLoadOlderError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  // Realtime banner state — set by the CustomEvent listener; cleared on
  // refresh.
  const [newActivity, setNewActivity] = useState(false)

  // 240ms q debounce.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 240)
    return () => clearTimeout(t)
  }, [query])

  // Listen for the realtime "draft audit fired" event from
  // RealtimeAIDraftAuditLayer (mounted at the page level).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onFire = () => setNewActivity(true)
    window.addEventListener(REALTIME_EVENT, onFire)
    return () => window.removeEventListener(REALTIME_EVENT, onFire)
  }, [])

  // Phase 8AV — translate the UI filter into the route's query
  // params. The route's `status` field accepts all/success/failed
  // only; `low_confidence` is a separate boolean. We treat the
  // "Low confidence" chip as a status-neutral filter so a low-
  // confidence FAILED row still surfaces.
  const buildBaseParams = (): URLSearchParams => {
    const p = new URLSearchParams()
    p.set('venue_id', venueId)
    if (filter === 'low_confidence') {
      p.set('status', 'all')
      p.set('low_confidence', 'true')
    } else {
      p.set('status', filter)
    }
    return p
  }

  // Page-1 fetch on mount / filter / q-debounce / manual refresh.
  const fetchRequestId = useRef(0)
  useEffect(() => {
    const id = ++fetchRequestId.current
    setState({ kind: 'loading' })
    setLoadOlderError(null)
    const params = buildBaseParams()
    params.set('limit', '25')
    if (debouncedQuery.length > 0) params.set('q', debouncedQuery)
    ;(async () => {
      try {
        const res = await fetch(
          `/api/admin/ai/draft-audit?${params.toString()}`,
          { credentials: 'same-origin' }
        )
        if (id !== fetchRequestId.current) return // stale
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | null
          setState({
            kind: 'error',
            message: body?.error ?? `HTTP ${res.status}`,
          })
          return
        }
        const body = (await res.json()) as {
          items: ApiItem[]
          next_cursor: string | null
          has_more: boolean
        }
        setState({
          kind: 'ready',
          items: body.items,
          hasMore: body.has_more,
          nextCursor: body.next_cursor,
        })
        setNewActivity(false)
      } catch (err) {
        if (id !== fetchRequestId.current) return
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        })
      }
    })()
  }, [venueId, filter, debouncedQuery, reloadTick])

  const handleLoadOlder = useCallback(async () => {
    if (state.kind !== 'ready' || !state.nextCursor) return
    setLoadingMore(true)
    setLoadOlderError(null)
    try {
      const params = buildBaseParams()
      params.set('limit', '25')
      params.set('occurred_before', state.nextCursor)
      if (debouncedQuery.length > 0) params.set('q', debouncedQuery)
      const res = await fetch(
        `/api/admin/ai/draft-audit?${params.toString()}`,
        { credentials: 'same-origin' }
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        setLoadOlderError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      const body = (await res.json()) as {
        items: ApiItem[]
        next_cursor: string | null
        has_more: boolean
      }
      // Append; dedupe by id defensively (cursor is strict `<`, but a
      // concurrent insert at the boundary could in theory return a
      // dupe — cheap to defend).
      setState((prev) => {
        if (prev.kind !== 'ready') return prev
        const known = new Set(prev.items.map((r) => r.id))
        const merged = prev.items.concat(
          body.items.filter((r) => !known.has(r.id))
        )
        return {
          kind: 'ready',
          items: merged,
          hasMore: body.has_more,
          nextCursor: body.next_cursor,
        }
      })
    } catch (err) {
      setLoadOlderError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setLoadingMore(false)
    }
  }, [state, venueId, filter, debouncedQuery])

  const handleExport = useCallback(async () => {
    setExporting(true)
    setExportError(null)
    try {
      const params = buildBaseParams()
      params.set('format', 'csv')
      params.set('limit', '100')
      if (debouncedQuery.length > 0) params.set('q', debouncedQuery)
      const res = await fetch(
        `/api/admin/ai/draft-audit?${params.toString()}`,
        { credentials: 'same-origin' }
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        setExportError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      const blob = await res.blob()
      // Pull the filename from Content-Disposition; fall back to a
      // local default if the header is stripped by a proxy.
      const disp = res.headers.get('Content-Disposition') ?? ''
      const m = disp.match(/filename="([^"]+)"/)
      const filename =
        m?.[1] ??
        `ai-draft-audit-${new Date().toISOString().slice(0, 10)}.csv`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setExporting(false)
    }
  }, [venueId, filter, debouncedQuery])

  // Client-side filter is gone — q/status are server-side now. We just
  // render whatever the route returned.
  const items = useMemo(() => {
    if (state.kind !== 'ready') return [] as ApiItem[]
    return state.items
  }, [state])

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>AI Draft Activity</CardTitle>
          <CardSubtitle>
            Recent draft regenerations for this venue. Emails masked.
          </CardSubtitle>
        </div>
        <div className="shrink-0 w-9 h-9 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center">
          <Sparkles className="w-4 h-4 text-[#1D4ED8]" />
        </div>
      </CardHeader>
      <CardContent>
        {/* Realtime banner */}
        {newActivity && (
          <div className="mb-3 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] px-3 py-2 text-[12px] text-[#1D4ED8] flex items-center justify-between gap-3">
            <span>New draft activity recorded.</span>
            <button
              type="button"
              onClick={() => setReloadTick((n) => n + 1)}
              className="text-[12px] font-semibold underline hover:no-underline"
            >
              Refresh
            </button>
          </div>
        )}

        {/* Filter chips + search + export + refresh */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {FILTERS.map((f) => {
            const active = filter === f.value
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={cn(
                  'text-[11px] px-2.5 py-1 rounded-full border transition-colors',
                  active
                    ? 'bg-[#0F172A] text-white border-[#0F172A]'
                    : 'border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC]'
                )}
              >
                {f.label}
              </button>
            )
          })}
          <div className="flex-1" />
          <div className="flex items-center gap-2 bg-[#F8FAFC] border border-[#E2E8F0] rounded-full pl-3 pr-2 h-8 min-w-[200px]">
            <Search className="w-3 h-3 text-[#94A3B8]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="lead, email, instruction, id…"
              className="flex-1 bg-transparent text-[12px] outline-none text-[#0F172A] placeholder:text-[#94A3B8]"
            />
          </div>
          <button
            type="button"
            onClick={() => setReloadTick((n) => n + 1)}
            className="text-[11px] px-2 py-1 rounded-md text-[#475569] hover:text-[#0F172A] hover:bg-[#F1F5F9]"
            title="Refresh"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting || state.kind !== 'ready'}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-50"
            title="Export CSV"
          >
            {exporting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Download className="w-3 h-3" />
            )}
            CSV
          </button>
        </div>

        {exportError && (
          <div className="mb-3 text-[11.5px] text-[#B91C1C]">
            Export failed: {exportError}
          </div>
        )}

        {state.kind === 'loading' && (
          <div className="flex items-center gap-2 text-[12.5px] text-[#475569] py-3">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading AI draft activity…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2.5 text-[12px] text-[#B91C1C] flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p>Couldn&apos;t load AI draft activity: {state.message}</p>
              <button
                type="button"
                onClick={() => setReloadTick((n) => n + 1)}
                className="mt-1 text-[#B91C1C] underline hover:no-underline"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {state.kind === 'ready' && items.length === 0 && (
          <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B] text-center">
            {debouncedQuery || filter !== 'all'
              ? 'No matches for the current filter / search.'
              : 'No AI draft regenerations recorded yet. Operators using "Regenerate" in the lead drawer will surface here.'}
          </div>
        )}

        {state.kind === 'ready' && items.length > 0 && (
          <div className="rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden">
            {items.map((a, i) => (
              <div
                key={a.id}
                className={cn(
                  'px-4 py-3 flex items-start gap-3',
                  i > 0 && 'border-t border-[#F1F5F9]'
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-semibold text-[#0F172A] truncate">
                      {a.lead_name ?? 'Unknown lead'}
                    </span>
                    {a.lead_email_masked && (
                      <span className="text-[11.5px] text-[#64748B] truncate font-mono">
                        {a.lead_email_masked}
                      </span>
                    )}
                    {a.success ? (
                      <Badge variant="green">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        Success
                      </Badge>
                    ) : (
                      <Badge variant="red">Failed</Badge>
                    )}
                    {/* Phase 8AV — Low-confidence badge. Amber tone
                        (operator-friendly), shows the min variant
                        score so the admin can see how far below the
                        floor the call landed. Renders only when the
                        route flagged this row. */}
                    {a.low_confidence && (
                      <span
                        className="inline-flex items-center text-[10px] font-semibold uppercase tracking-[0.1em] px-1.5 py-0.5 rounded bg-[#FFFBEB] text-[#B45309] border border-[#FCD9A1]"
                        title={`Min variant confidence ${a.min_confidence}/100`}
                      >
                        Low conf · {a.min_confidence}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11.5px] text-[#475569] flex items-center gap-2 flex-wrap">
                    {a.instruction ? (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-[#EFF6FF] text-[#1D4ED8] text-[10.5px] font-medium">
                        {a.instruction}
                      </span>
                    ) : (
                      <span className="text-[#94A3B8]">no adjustment</span>
                    )}
                    {a.variant_count != null ? (
                      <span>
                        {a.variant_count} variant
                        {a.variant_count === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="text-[#94A3B8]">n/a variants</span>
                    )}
                    {typeof a.accepted_variant_index === 'number' &&
                    a.variant_count ? (
                      <span className="text-[#0F172A] font-medium">
                        Accepted · option {a.accepted_variant_index + 1}/
                        {a.variant_count}
                      </span>
                    ) : (
                      <span className="text-[#94A3B8]">Not yet sent</span>
                    )}
                    {a.error && (
                      <span
                        className="text-[#B91C1C] truncate max-w-[260px]"
                        title={a.error}
                      >
                        {a.error}
                      </span>
                    )}
                  </div>
                  {/* Phase 8AW — per-row calibration detail line. We
                      only render when the route returned at least one
                      of final / model / heuristic so pre-8AW rows stay
                      visually quiet. Outcome chip + edit bucket sit
                      alongside the numbers so the operator can scan
                      "what did the model think, what did we show, and
                      what did the operator do" in one row. */}
                  {(a.final_confidence !== null ||
                    a.model_confidence !== null ||
                    a.heuristic_confidence !== null ||
                    a.operator_outcome !== null) && (
                    <div
                      className="mt-1 text-[10.5px] text-[#94A3B8] flex items-center gap-1.5 flex-wrap"
                      title={buildConfidenceTooltip(a)}
                    >
                      {a.final_confidence !== null && (
                        <span>Final {a.final_confidence}</span>
                      )}
                      {a.model_confidence !== null && (
                        <span>· Model {a.model_confidence}</span>
                      )}
                      {a.heuristic_confidence !== null && (
                        <span>· Heuristic {a.heuristic_confidence}</span>
                      )}
                      {a.confidence_source === 'heuristic_fallback' && (
                        <span className="text-[#B45309]">
                          · heuristic only
                        </span>
                      )}
                      {a.operator_outcome &&
                        a.operator_outcome !== 'unknown' && (
                          <span className="text-[#475569]">
                            · {OUTCOME_LABEL[a.operator_outcome]}
                          </span>
                        )}
                      {a.edit_distance_bucket &&
                        a.edit_distance_bucket !== 'none' &&
                        a.edit_distance_bucket !== 'unknown' && (
                          <span>· {a.edit_distance_bucket} edits</span>
                        )}
                      {/* Phase 8AX — autopilot decision + risk
                          flags for the selected variant. Color
                          matches the drawer pill so an operator
                          jumping between surfaces sees the same
                          signal in the same color. */}
                      {a.autopilot_mode && (
                        <span
                          className={
                            a.autopilot_mode === 'eligible'
                              ? 'text-[#059669]'
                              : a.autopilot_mode === 'review_required'
                                ? 'text-[#B45309]'
                                : 'text-[#B91C1C]'
                          }
                          title={
                            a.autopilot_reasons.length > 0
                              ? `Reasons: ${a.autopilot_reasons.join(', ')}`
                              : undefined
                          }
                        >
                          · {AUTOPILOT_LABEL[a.autopilot_mode]}
                        </span>
                      )}
                      {a.risk_flags.length > 0 && (
                        <span className="text-[#B91C1C]">
                          · {a.risk_flags.join(' / ')} risk
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[11px] text-[#475569] font-mono">
                    {a.latency_ms != null ? `${a.latency_ms}ms` : '—'}
                  </div>
                  <div className="text-[10.5px] text-[#94A3B8] mt-0.5">
                    {formatDistanceToNow(new Date(a.created_at), {
                      addSuffix: true,
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Load older */}
        {state.kind === 'ready' && state.hasMore && (
          <div className="mt-3 flex flex-col items-center gap-1.5">
            <button
              type="button"
              onClick={handleLoadOlder}
              disabled={loadingMore}
              className="inline-flex items-center gap-1.5 text-[11.5px] px-3 py-1.5 rounded-md border border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-50"
            >
              {loadingMore ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : null}
              Load older
            </button>
            {loadOlderError && (
              <span className="text-[11px] text-[#B91C1C]">
                Couldn&apos;t load older: {loadOlderError}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
