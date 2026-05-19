'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { History, Search } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { Badge } from '@/components/dashboard/ui/Badge'
import {
  actorLabel,
  actionLabel,
  formatAuditTime,
  statusLabel,
  type TourStatusActorKind,
  type TourStatusEvent,
} from '@/components/dashboard/tours/tour-audit-types'

/**
 * Phase 8O — interactive variant of the billing-page tour status activity
 * feed. Renders the same compact table as the Phase 8N
 * `TourStatusActivityFeed`, plus two filter selects (`actor_kind` and
 * `action`) that narrow the visible rows client-side over the already-
 * loaded 25-row slice.
 *
 * Server-side filtering is intentionally NOT used yet. The billing page
 * fetches 25 rows; the operator filters interactively. If they need
 * deeper queries (different window, larger limit), they pivot through
 * the admin endpoint — `?actor_kind=…&action=…&limit=200&format=csv`
 * is the documented escape hatch.
 *
 * Empty states intentionally distinguish:
 *   - no events at all          → "No tour status events recorded yet."
 *   - no events match filters   → "No events match the active filters."
 *
 * This phase keeps the surface narrow on purpose. The filter set
 * matches the union of action verbs the four Phase 8M write paths
 * currently emit, plus the Phase 8N synthetic `legacy_status_snapshot`.
 * If a future phase adds a new verb, the `'all'` option still works;
 * the operator just won't see a chip for the new verb until we
 * extend the constant below.
 */

interface TourStatusActivityFeedClientProps {
  events: TourStatusEvent[]
}

type ActorKindFilter = TourStatusActorKind | 'all'

type ActionFilter =
  | 'all'
  | 'confirm'
  | 'cancel'
  | 'reschedule'
  | 'status_change'
  | 'bulk_cancel'
  | 'auto_pause_cancel'
  | 'legacy_status_snapshot'

const ACTOR_FILTERS: ReadonlyArray<{ value: ActorKindFilter; label: string }> = [
  { value: 'all', label: 'All actors' },
  { value: 'lead_token', label: actorLabel('lead_token') },
  { value: 'operator', label: actorLabel('operator') },
  { value: 'cron', label: actorLabel('cron') },
  { value: 'system', label: actorLabel('system') },
]

const ACTION_FILTERS: ReadonlyArray<{ value: ActionFilter; label: string }> = [
  { value: 'all', label: 'All actions' },
  { value: 'confirm', label: actionLabel('confirm') },
  { value: 'cancel', label: actionLabel('cancel') },
  { value: 'reschedule', label: actionLabel('reschedule') },
  { value: 'status_change', label: actionLabel('status_change') },
  { value: 'bulk_cancel', label: actionLabel('bulk_cancel') },
  { value: 'auto_pause_cancel', label: actionLabel('auto_pause_cancel') },
  { value: 'legacy_status_snapshot', label: actionLabel('legacy_status_snapshot') },
]

// Phase 8P — URL ↔ filter-state coercion helpers. Anything outside the
// allow-list (typo, stale link, malicious) coerces to 'all' silently.
const VALID_ACTOR_KINDS = new Set<string>(
  ACTOR_FILTERS.filter((o) => o.value !== 'all').map((o) => o.value)
)
const VALID_ACTIONS = new Set<string>(
  ACTION_FILTERS.filter((o) => o.value !== 'all').map((o) => o.value)
)

function coerceActor(raw: string | null | undefined): ActorKindFilter {
  if (raw && VALID_ACTOR_KINDS.has(raw)) return raw as ActorKindFilter
  return 'all'
}
function coerceAction(raw: string | null | undefined): ActionFilter {
  if (raw && VALID_ACTIONS.has(raw)) return raw as ActionFilter
  return 'all'
}

// ============================================================================
// Phase 8Q — per-user filter persistence (localStorage)
// ============================================================================

const STORAGE_KEY = 'venuerise:tour-status-feed:filters:v1'
const SEARCH_DEBOUNCE_MS = 300
// Mirror the server-side cap so a stale localStorage value can't ship a
// 100KB blob back into the URL. The server route validates 120 chars too.
const Q_MAX_LEN = 120

interface PersistedFilters {
  actor?: string
  action?: string
  q?: string
}

function loadPersistedFilters(): PersistedFilters | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const out: PersistedFilters = {}
    const obj = parsed as Record<string, unknown>
    if (typeof obj.actor === 'string') out.actor = obj.actor
    if (typeof obj.action === 'string') out.action = obj.action
    if (typeof obj.q === 'string') out.q = obj.q.slice(0, Q_MAX_LEN)
    return out
  } catch {
    // Invalid JSON — treat as absent. The next valid change overwrites
    // the slot.
    return null
  }
}

function savePersistedFilters(next: PersistedFilters) {
  if (typeof window === 'undefined') return
  try {
    // Only persist non-default values so a cleared filter set
    // round-trips to "removed from storage" naturally on the next
    // load.
    const slim: PersistedFilters = {}
    if (next.actor && next.actor !== 'all') slim.actor = next.actor
    if (next.action && next.action !== 'all') slim.action = next.action
    if (next.q && next.q.length > 0) slim.q = next.q.slice(0, Q_MAX_LEN)
    if (Object.keys(slim).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY)
      return
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slim))
  } catch {
    // localStorage can throw (quota, private mode, disabled). Persistence
    // is a nice-to-have — never bubble out to the operator.
  }
}

function clearPersistedFilters() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // see above
  }
}

export default function TourStatusActivityFeedClient({
  events,
}: TourStatusActivityFeedClientProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Phase 8P — read the URL on every render so a router.refresh() or a
  // deep-linked tab opens with the right filters. We don't memo the
  // coerced values themselves — `searchParams` is a stable reference
  // that updates by reference on navigation, so `actorFilter` /
  // `actionFilter` re-derive automatically.
  const actorFilter = coerceActor(searchParams.get('actor'))
  const actionFilter = coerceAction(searchParams.get('action'))
  // Phase 8Q — `q` is the source of truth for filtering; `qInput` mirrors
  // it for the controlled <input> so typing feels instant while the URL
  // write is debounced.
  const qFromUrl = (searchParams.get('q') ?? '').slice(0, Q_MAX_LEN)
  const [qInput, setQInput] = useState(qFromUrl)

  // Write helper: merges new values into the existing search string so
  // unrelated params (e.g. a future ?tab=… or anchor) survive. Uses
  // router.replace so the filter-change doesn't pollute browser history
  // — operators expect the Back button to leave the page, not undo a
  // filter selection.
  //
  // Phase 8Q — also writes/clears the localStorage persistence slot on
  // every change. The URL stays the source of truth; localStorage is
  // the "next session default" fallback.
  const updateUrl = useCallback(
    (next: { actor?: ActorKindFilter; action?: ActionFilter; q?: string }) => {
      const params = new URLSearchParams(searchParams.toString())
      if ('actor' in next) {
        if (next.actor && next.actor !== 'all') params.set('actor', next.actor)
        else params.delete('actor')
      }
      if ('action' in next) {
        if (next.action && next.action !== 'all') params.set('action', next.action)
        else params.delete('action')
      }
      if ('q' in next) {
        const trimmed = (next.q ?? '').trim().slice(0, Q_MAX_LEN)
        if (trimmed.length > 0) params.set('q', trimmed)
        else params.delete('q')
      }
      // After applying the change, persist whatever the URL would
      // resolve to — that way operators get consistent restoration
      // whether they navigated, refreshed, or returned days later.
      savePersistedFilters({
        actor: params.get('actor') ?? undefined,
        action: params.get('action') ?? undefined,
        q: params.get('q') ?? undefined,
      })
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams]
  )

  // Phase 8Q — bootstrap from localStorage when the URL has no filter
  // params on first visit. URL ALWAYS wins when present; localStorage
  // is the fallback. Runs once on mount; if the operator clears
  // localStorage in another tab the next visit picks up the absence.
  const bootstrappedRef = useRef(false)
  useEffect(() => {
    if (bootstrappedRef.current) return
    bootstrappedRef.current = true
    const hasUrlFilters =
      searchParams.get('actor') !== null ||
      searchParams.get('action') !== null ||
      searchParams.get('q') !== null
    if (hasUrlFilters) return
    const stored = loadPersistedFilters()
    if (!stored) return
    const next = {
      actor: coerceActor(stored.actor),
      action: coerceAction(stored.action),
      q: stored.q ?? '',
    }
    // Only write the URL if at least one stored value is non-default.
    if (next.actor === 'all' && next.action === 'all' && next.q.length === 0) return
    updateUrl(next)
    setQInput(next.q)
    // We only want this to run once on first mount. `searchParams` +
    // `updateUrl` are stable enough that the URL write triggers a
    // re-render but won't re-enter this branch (bootstrappedRef).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Phase 8Q — re-sync the local input when the URL `q` changes via an
  // external nav (Back/Forward, deep link, another tab). Skips the
  // round-trip when the values already match so typing isn't disrupted.
  useEffect(() => {
    if (qFromUrl !== qInput) setQInput(qFromUrl)
    // We intentionally don't depend on `qInput` — that would fight the
    // debounced URL writes initiated by typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qFromUrl])

  // Phase 8Q — 300ms trailing debounce on URL writes for the search
  // input. Each keystroke updates `qInput` immediately (controlled
  // input stays snappy), then schedules a single URL/localStorage
  // write after the user pauses.
  useEffect(() => {
    if (qInput === qFromUrl) return
    const handle = setTimeout(() => {
      updateUrl({ q: qInput })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [qInput, qFromUrl, updateUrl])

  // Phase 8Q — client-side search over the loaded slice. Matches the
  // documented columns (reason, actor_id, action, previous_status,
  // new_status) PLUS the stringified metadata so operators can
  // grep-style search for "stripe_event" or "past_due_7_days" without
  // the server-side metadata::text limitation hitting the UI.
  const visible = useMemo(() => {
    const needle = qFromUrl.trim().toLowerCase()
    return events.filter((event) => {
      if (actorFilter !== 'all' && event.actor_kind !== actorFilter) return false
      if (actionFilter !== 'all' && event.action !== actionFilter) return false
      if (needle.length === 0) return true
      const haystack = [
        event.reason ?? '',
        event.actor_id ?? '',
        event.action ?? '',
        event.previous_status ?? '',
        event.new_status ?? '',
        JSON.stringify(event.metadata ?? {}),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(needle)
    })
  }, [events, actorFilter, actionFilter, qFromUrl])

  const filtersActive =
    actorFilter !== 'all' || actionFilter !== 'all' || qFromUrl.length > 0

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Tour status activity</CardTitle>
          <CardSubtitle>
            Recent confirm, cancel, reschedule, and auto-pause events for
            this venue. Filter chips narrow the loaded slice; use the admin
            CSV export for a wider window.
          </CardSubtitle>
        </div>
        <div className="shrink-0">
          <div className="w-9 h-9 rounded-xl bg-[#F1F5F9] border border-[#E2E8F0] flex items-center justify-center">
            <History className="w-4 h-4 text-[#475569]" />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Filter chips — paired selects styled to look like a Phase 8E
            MonthNavClient cluster. Native <select> keeps a11y free + uses
            the OS dropdown on mobile. */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-[#475569]">
            <span className="text-[#94A3B8]">Actor</span>
            <select
              value={actorFilter}
              onChange={(e) =>
                updateUrl({ actor: coerceActor(e.target.value) })
              }
              className="rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1 text-[12px] text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#1D4ED8]"
            >
              {ACTOR_FILTERS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-flex items-center gap-1.5 text-[11px] text-[#475569]">
            <span className="text-[#94A3B8]">Action</span>
            <select
              value={actionFilter}
              onChange={(e) =>
                updateUrl({ action: coerceAction(e.target.value) })
              }
              className="rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1 text-[12px] text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#1D4ED8]"
            >
              {ACTION_FILTERS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          {/* Phase 8Q — search input. Controlled with local state so
              typing is instant; URL writes are debounced 300ms via the
              useEffect above. Server-side search lives on the admin
              endpoint (?q=…); this client also filters the loaded slice
              over `metadata` JSON which the server can't easily index. */}
          <label className="inline-flex items-center gap-1.5 text-[11px] text-[#475569] ml-auto flex-1 max-w-xs min-w-[180px]">
            <Search className="w-3 h-3 text-[#94A3B8] shrink-0" />
            <input
              type="search"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search reason, actor, metadata…"
              maxLength={Q_MAX_LEN}
              className="flex-1 rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1 text-[12px] text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#1D4ED8]"
            />
          </label>
          {filtersActive && (
            <button
              type="button"
              onClick={() => {
                clearPersistedFilters()
                setQInput('')
                updateUrl({ actor: 'all', action: 'all', q: '' })
              }}
              className="text-[11px] text-[#1D4ED8] hover:text-[#1E40AF] transition-colors"
            >
              Reset filters
            </button>
          )}
        </div>

        {/* Phase 8U — search coverage hint. When the operator types 1-2
            chars, the server-side `?q=` short-circuits to scalar
            columns only (Phase 8T) and metadata is NOT searched. This
            pill explains that gap so the operator doesn't think the
            feed is silently missing metadata matches. */}
        {qInput.trim().length > 0 && qInput.trim().length < 3 && (
          <div
            role="note"
            className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-[#FFFBEB] border border-[#FDE68A] text-[#92400E] text-[11px] px-3 py-1.5"
          >
            Searching core fields only. Type 3+ characters to include metadata.
          </div>
        )}

        {events.length === 0 ? (
          <p className="text-[12px] text-[#64748B] px-1 py-3">
            No tour status events recorded yet.
          </p>
        ) : visible.length === 0 ? (
          <p className="text-[12px] text-[#64748B] px-1 py-3">
            No events match the active filters.
          </p>
        ) : (
          <div className="border border-[#E2E8F0] rounded-2xl overflow-hidden">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                  <th className="px-4 py-2 text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                    Actor
                  </th>
                  <th className="px-4 py-2 text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                    Action
                  </th>
                  <th className="px-4 py-2 text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                    Change
                  </th>
                  <th className="px-4 py-2 text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                    When
                  </th>
                  <th className="px-4 py-2 text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                    Reason
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((event) => (
                  <tr
                    key={event.id}
                    className="border-b border-[#F1F5F9] last:border-b-0 hover:bg-[#F8FAFC] transition-colors"
                  >
                    <td className="px-4 py-2.5">
                      <Badge
                        variant={
                          event.actor_kind === 'lead_token'
                            ? 'blue'
                            : event.actor_kind === 'operator'
                              ? 'navy'
                              : 'default'
                        }
                      >
                        {actorLabel(event.actor_kind)}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-[#0F172A] font-medium">
                      {actionLabel(event.action)}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-[#475569]">
                      {statusLabel(event.previous_status)} →{' '}
                      {statusLabel(event.new_status)}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-[#475569] whitespace-nowrap">
                      {formatAuditTime(event.occurred_at)}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-[#64748B]">
                      {event.reason ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
