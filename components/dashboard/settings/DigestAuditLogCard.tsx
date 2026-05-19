'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Loader2, AlertTriangle, Download, RefreshCw, X } from 'lucide-react'
import DigestAuditEventDrawer, {
  type DigestAuditEventDrawerItem,
} from './DigestAuditEventDrawer'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { Badge } from '@/components/dashboard/ui/Badge'

/**
 * Phase 8AC → 8AD — DigestAuditLogCard
 *
 * Surfaces `public.digest_audit_events` (migration 017) as a compact
 * table on `/dashboard/settings/billing`. Sister card to the Phase 8Y
 * `DigestAuditFeed` — that one shows digest SENDS; this one shows
 * operator + cron ACTIONS against the digest system.
 *
 * Phase 8AD additions:
 *   - Free-text search input (300ms debounce) above the chip strip.
 *     Server-side `?q=` matches action / reason / target_email_masked.
 *   - Action-family chips now use the server-side `?action_family=`
 *     parameter; the chip click is now a single round-trip instead
 *     of the Phase 8AC client-side multi-fetch.
 *   - Load older button with cursor pagination (`?occurred_before=`).
 *     Preserves the active chip + search.
 *   - Empty state distinguishes "no events ever" from "no matches".
 */

const PAGE_SIZE = 25

const ACTION_FAMILIES = [
  { value: 'all',          label: 'All'         },
  { value: 'suppression',  label: 'Suppression' },
  { value: 'retention',    label: 'Retention'   },
  { value: 'cron',         label: 'Cron'        },
  // Phase 8AE — preview family. Populated only when
  // DIGEST_AUDIT_LOG_CRON_SENDS=1 was set at the time the operator
  // clicked Send sample.
  { value: 'preview',      label: 'Preview'     },
] as const

type ActionFamily = (typeof ACTION_FAMILIES)[number]['value']

// Phase 8AE — URL state + localStorage keys. URL > localStorage >
// default. `q` is URL-only by design: persisting a typed search
// across pageloads is rarely what the operator wants and tends to
// look like a stuck filter. `family` persists in localStorage so the
// operator's preferred chip survives reloads, but URL wins.
const URL_PARAM_FAMILY = 'digest_audit_family'
const URL_PARAM_Q = 'digest_audit_q'
const URL_PARAM_CURSOR = 'digest_audit_cursor'
const STORAGE_KEY_FAMILY = 'venuerise:digest-audit-log:family:v1'

const VALID_FAMILIES: readonly string[] = ACTION_FAMILIES.map((f) => f.value)

function coerceFamily(raw: string | null): ActionFamily | null {
  if (raw && VALID_FAMILIES.includes(raw)) return raw as ActionFamily
  return null
}

interface AuditItem {
  id: string
  venue_id: string
  actor_user_id: string | null
  actor_kind: 'operator' | 'cron' | 'system'
  action: string
  target_user_id: string | null
  target_email_masked: string | null
  reason: string | null
  metadata: Record<string, unknown> | null
  occurred_at: string
}

type FeedState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      items: AuditItem[]
      nextCursor: string | null
      hasMore: boolean
      loadingMore: boolean
      loadMoreError: string | null
    }

function actionBadge(action: string): { label: string; variant: 'navy' | 'blue' | 'default' } {
  if (action.startsWith('suppression_remove')) {
    return { label: action.replace(/^suppression_/, '').replace(/_/g, ' '), variant: 'blue' }
  }
  if (action === 'digest_retention_archive') {
    return { label: 'retention archive', variant: 'navy' }
  }
  if (action === 'digest_send_cron') {
    return { label: 'cron send', variant: 'navy' }
  }
  return { label: action.replace(/_/g, ' '), variant: 'default' }
}

function actorLabel(item: AuditItem): string {
  if (item.actor_kind === 'cron') return 'Cron'
  if (item.actor_kind === 'system') return 'System'
  if (item.actor_user_id) return `Operator · ${item.actor_user_id.slice(0, 8)}`
  return 'Operator'
}

function targetLabel(item: AuditItem): string {
  if (item.target_email_masked) return item.target_email_masked
  if (item.target_user_id) return `user ${item.target_user_id.slice(0, 8)}`
  return '—'
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

export default function DigestAuditLogCard() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Phase 8AE — URL > localStorage > default. We read these
  // SYNCHRONOUSLY during the initial render so the first fetch
  // already targets the right filter (no double-fetch on mount).
  //
  // `usePathname` + `useSearchParams` are SSR-safe in the App Router;
  // both return null during SSR and the initial values from the
  // route on hydration. We treat null as "no URL state" — same as
  // when the page genuinely has no params.
  const initialFamilyFromUrl =
    typeof window !== 'undefined'
      ? coerceFamily(searchParams?.get(URL_PARAM_FAMILY) ?? null)
      : null
  const initialQFromUrl =
    typeof window !== 'undefined' ? searchParams?.get(URL_PARAM_Q) ?? '' : ''
  const initialFamilyFromStorage =
    typeof window !== 'undefined' && initialFamilyFromUrl === null
      ? (() => {
          try {
            return coerceFamily(
              window.localStorage.getItem(STORAGE_KEY_FAMILY)
            )
          } catch {
            return null
          }
        })()
      : null

  const [family, setFamilyState] = useState<ActionFamily>(
    initialFamilyFromUrl ?? initialFamilyFromStorage ?? 'all'
  )
  const [searchInput, setSearchInput] = useState<string>(initialQFromUrl)
  const [searchTerm, setSearchTerm] = useState<string>(initialQFromUrl.trim())
  const [state, setState] = useState<FeedState>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  // Phase 8AF — initial cursor from URL. Drives the first-page fetch
  // when the operator landed on a shared link with
  // `?digest_audit_cursor=<iso>`. Distinct from `state.nextCursor`
  // (which only exists after a fetch): this is the cursor that
  // controls WHICH first page renders. Cleared by chip / search
  // change / Reset / Jump to latest.
  const initialCursorFromUrl = (() => {
    if (typeof window === 'undefined') return null
    const raw = searchParams?.get(URL_PARAM_CURSOR) ?? null
    if (!raw) return null
    // Validate ISO datetime defensively — a hand-edited URL with
    // `?digest_audit_cursor=garbage` should be ignored, not
    // 400-error the API.
    const parsed = new Date(raw)
    return Number.isFinite(parsed.getTime()) ? raw : null
  })()
  const [initialCursor, setInitialCursor] = useState<string | null>(
    initialCursorFromUrl
  )
  // Phase 8AF — audit-event drawer state. `selected` holds the row
  // most recently clicked; clearing it (or setting open=false)
  // closes the drawer. Card-local — no global store.
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<DigestAuditEventDrawerItem | null>(null)

  // Phase 8AE — URL-write helper. Uses `router.replace` rather than
  // `push` so the browser back button still gets the user OUT of the
  // billing page on first click, not back through their typing
  // history. Preserves every unrelated query param the billing page
  // already uses (none today, but the convention is cheap to keep).
  const writeUrl = useCallback(
    (nextFamily: ActionFamily, nextQ: string, nextCursor: string | null) => {
      if (typeof window === 'undefined') return
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      // Family: omit when 'all' so the URL stays clean on default.
      if (nextFamily === 'all') params.delete(URL_PARAM_FAMILY)
      else params.set(URL_PARAM_FAMILY, nextFamily)
      // Q: omit when empty so we don't trail a `&digest_audit_q=`.
      if (nextQ.length === 0) params.delete(URL_PARAM_Q)
      else params.set(URL_PARAM_Q, nextQ)
      // Cursor: only set on Load older clicks. Initial fetch /
      // reset clears it.
      if (nextCursor === null) params.delete(URL_PARAM_CURSOR)
      else params.set(URL_PARAM_CURSOR, nextCursor)
      const next = params.toString()
      const href = next.length > 0 ? `${pathname}?${next}` : pathname
      router.replace(href, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  function setFamily(next: ActionFamily): void {
    setFamilyState(next)
    if (typeof window !== 'undefined') {
      try {
        if (next === 'all') {
          window.localStorage.removeItem(STORAGE_KEY_FAMILY)
        } else {
          window.localStorage.setItem(STORAGE_KEY_FAMILY, next)
        }
      } catch {
        // localStorage unavailable (private mode / quota) — toggle
        // still works in-memory.
      }
    }
    // Reset cursor on chip change so a stale ?digest_audit_cursor
    // from a previous Load older doesn't paginate past the start.
    // Phase 8AF — also clear the in-memory initialCursor so the
    // Earlier-page banner disappears + the fetch effect re-runs at
    // page 1.
    setInitialCursor(null)
    writeUrl(next, searchTerm, null)
  }

  // 300ms debounce for the search input → searchTerm. Mirrors the
  // Phase 8AA DigestAuditFeed pattern. The URL is updated when the
  // debounced searchTerm settles, not on every keystroke (avoids
  // 50-entry browser history clutter on a slow typist).
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = searchInput.trim()
      // Phase 8AF — only act if the debounced term actually changes
      // from the current state. Avoids a redundant URL/cursor reset
      // when a search input mount value already matches state.
      if (next === searchTerm) return
      setSearchTerm(next)
      setInitialCursor(null)
      writeUrl(family, next, null)
    }, 300)
    return () => clearTimeout(handle)
  }, [searchInput, family, searchTerm, writeUrl])

  // Phase 8AE — Reset filters. Clears URL params + the family
  // localStorage key, restores defaults. Operator-facing label
  // matches the existing "Reset" patterns on other billing surfaces.
  function handleReset(): void {
    setFamilyState('all')
    setSearchInput('')
    setSearchTerm('')
    setInitialCursor(null)
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(STORAGE_KEY_FAMILY)
      } catch {
        // best-effort
      }
    }
    writeUrl('all', '', null)
  }

  // Phase 8AF — Jump to latest. Clears the URL cursor + the in-
  // memory initialCursor, triggering a clean page-1 refetch via the
  // fetch effect dependency. Family + q stay where they were so the
  // operator returns to "live tail" of their current investigation.
  function handleJumpToLatest(): void {
    setInitialCursor(null)
    writeUrl(family, searchTerm, null)
  }

  // Phase 8AE/8AF — cursor URL state is read+written. `writeUrl`
  // emits `digest_audit_cursor` whenever a non-null cursor is
  // passed (Load older). Initial mount reads the URL cursor via
  // `initialCursorFromUrl` above and threads it into the first
  // fetch; Jump to latest clears it.

  // Phase 8AF — deep-link the sibling DigestAuditFeed (sends feed)
  // to the related outbound row. Sets `digest_send_q=<id>` so the
  // sends feed's debounced search resolves to the matching row.
  // Mirrors the URL-state convention from Phase 8AE so unrelated
  // params on the billing page survive.
  const handleViewRelatedSend = useCallback(
    (outboundMessageId: string) => {
      if (typeof window === 'undefined') return
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.set('digest_send_q', outboundMessageId)
      // Clear any stale cursor on the sends feed so it lands on
      // page 1 of the search rather than mid-pagination on an
      // unrelated slice.
      params.delete('digest_send_cursor')
      const next = params.toString()
      const href = next.length > 0 ? `${pathname}?${next}` : pathname
      router.replace(href, { scroll: false })
      setDrawerOpen(false)
    },
    [pathname, router, searchParams]
  )

  function openDrawer(row: DigestAuditEventDrawerItem): void {
    setSelectedEvent(row)
    setDrawerOpen(true)
  }

  // Initial fetch + refetch on any filter change. Pagination resets
  // to page 1 implicitly via the useEffect dependency list.
  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const params = new URLSearchParams()
        params.set('limit', String(PAGE_SIZE))
        if (family !== 'all') params.set('action_family', family)
        if (searchTerm) params.set('q', searchTerm)
        // Phase 8AF — initial cursor starts the visible slice at a
        // specific occurred_at boundary when the operator landed on
        // a shared link. Load older appends from there; the cursor
        // stays unchanged unless Jump to latest / chip / search
        // clears it.
        if (initialCursor) params.set('occurred_before', initialCursor)
        const res = await fetch(
          `/api/admin/digest/audit-events?${params.toString()}`,
          { method: 'GET', signal: abort.signal, credentials: 'same-origin' }
        )
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null
          const code =
            body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
          setState({ kind: 'error', message: code })
          return
        }
        const body = (await res.json()) as {
          items?: AuditItem[]
          next_cursor?: string | null
          has_more?: boolean
        }
        setState({
          kind: 'ready',
          items: Array.isArray(body.items) ? body.items : [],
          nextCursor: typeof body.next_cursor === 'string' ? body.next_cursor : null,
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
    // Phase 8AF — `initialCursor` joins the dependency list so
    // Jump to latest (setInitialCursor(null)) triggers a clean
    // page-1 refetch.
  }, [family, searchTerm, reloadTick, initialCursor])

  async function handleLoadMore() {
    if (state.kind !== 'ready' || !state.hasMore || !state.nextCursor) return
    // Phase 8AE — reflect the cursor to the URL so a refresh
    // doesn't dump the operator back to page 1 mid-investigation.
    writeUrl(family, searchTerm, state.nextCursor)
    setState({ ...state, loadingMore: true, loadMoreError: null })
    try {
      const params = new URLSearchParams()
      params.set('limit', String(PAGE_SIZE))
      params.set('occurred_before', state.nextCursor)
      if (family !== 'all') params.set('action_family', family)
      if (searchTerm) params.set('q', searchTerm)
      const res = await fetch(
        `/api/admin/digest/audit-events?${params.toString()}`,
        { method: 'GET', credentials: 'same-origin' }
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null
        const code =
          body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
        setState((prev) =>
          prev.kind === 'ready'
            ? { ...prev, loadingMore: false, loadMoreError: code }
            : prev
        )
        return
      }
      const body = (await res.json()) as {
        items?: AuditItem[]
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
  }

  // CSV link inherits the active family + search. Pagination cursor
  // is deliberately omitted — operators get "export the current
  // filter at limit=200", same convention as DigestAuditFeed.
  const csvHref = (() => {
    const params = new URLSearchParams()
    params.set('format', 'csv')
    params.set('limit', '200')
    if (family !== 'all') params.set('action_family', family)
    if (searchTerm) params.set('q', searchTerm)
    return `/api/admin/digest/audit-events?${params.toString()}`
  })()

  const hasActiveFilter = family !== 'all' || searchTerm.length > 0

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Digest audit log</CardTitle>
          <CardSubtitle>
            Operator + cron actions against the digest system for this venue.
          </CardSubtitle>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {/* Phase 8AE — Reset surfaces only when a filter is
              actually active. Clears URL params + localStorage
              family key. */}
          {hasActiveFilter && (
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1.5 text-[12px] text-[#475569] hover:text-[#0F172A] px-2 py-1 rounded-lg hover:bg-[#F1F5F9]"
              title="Reset filters"
            >
              <X className="w-3.5 h-3.5" />
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={() => setReloadTick((n) => n + 1)}
            className="inline-flex items-center gap-1.5 text-[12px] text-[#475569] hover:text-[#0F172A] px-2 py-1 rounded-lg hover:bg-[#F1F5F9]"
            title="Reload"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          <a
            href={csvHref}
            className="inline-flex items-center gap-1.5 text-[12px] text-[#1D4ED8] hover:text-[#1E40AF] px-2 py-1 rounded-lg hover:bg-[#EFF6FF]"
            title="Export the current filter as CSV"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </a>
        </div>
      </CardHeader>
      <CardContent>
        {/* Phase 8AF — earlier-page banner. Renders when the
            operator landed via a shared link with ?digest_audit_cursor=
            so they see "this isn't page 1" and can recover with one
            click instead of hunting for a Reset. */}
        {initialCursor && (
          <div className="mb-3 rounded-lg bg-[#FFFBEB] border border-[#FDE68A] px-3 py-2 text-[12px] text-[#92400E] flex items-center justify-between gap-2">
            <span>Viewing an earlier audit page.</span>
            <button
              type="button"
              onClick={handleJumpToLatest}
              className="inline-flex items-center text-[11px] font-semibold text-[#92400E] bg-white border border-[#FDE68A] hover:border-[#F59E0B] hover:bg-[#FEF3C7] px-2 py-1 rounded-md"
            >
              Jump to latest
            </button>
          </div>
        )}

        {/* Phase 8AD — search input. 120-char cap matches the API
            schema. The endpoint searches action / reason /
            target_email_masked (no metadata jsonb search — no
            trigram index on this table). */}
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search action, reason, recipient (masked)…"
          maxLength={120}
          className="w-full mb-2 rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-[12px] text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#1D4ED8]"
        />

        <div className="flex items-center gap-1.5 mb-3 flex-wrap">
          {ACTION_FAMILIES.map((opt) => {
            const active = family === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setFamily(opt.value)}
                className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                  active
                    ? 'bg-[#0F172A] text-white border-[#0F172A]'
                    : 'bg-white text-[#475569] border-[#E2E8F0] hover:border-[#CBD5E1] hover:bg-[#F8FAFC]'
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>

        {state.kind === 'loading' && (
          <div className="flex items-center gap-2 text-[13px] text-[#475569] py-6">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading audit events…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2.5 text-[12px] text-[#B91C1C] flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p>Couldn&apos;t load audit events: {state.message}</p>
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

        {state.kind === 'ready' && state.items.length === 0 && (
          <div className="text-[13px] text-[#64748B] py-6 text-center">
            {/* Phase 8AD — distinguish "no events ever" from "no
                matches under the active filter". Matters for an
                operator who searched a typo and wonders why the
                feed went empty. */}
            {hasActiveFilter
              ? 'No digest audit events match these filters.'
              : 'No digest audit events recorded yet.'}
          </div>
        )}

        {state.kind === 'ready' && state.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-[#94A3B8]">
                  <th className="py-2 pr-3 font-semibold">When</th>
                  <th className="py-2 pr-3 font-semibold">Actor</th>
                  <th className="py-2 pr-3 font-semibold">Action</th>
                  <th className="py-2 pr-3 font-semibold">Target</th>
                  <th className="py-2 pr-3 font-semibold">Reason</th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((row) => {
                  const badge = actionBadge(row.action)
                  return (
                    <tr
                      key={row.id}
                      onClick={() => openDrawer(row)}
                      className="border-t border-[#F1F5F9] hover:bg-[#F8FAFC] cursor-pointer"
                      title="Open audit event drawer"
                    >
                      <td className="py-2 pr-3 text-[#475569] whitespace-nowrap">
                        {formatTime(row.occurred_at)}
                      </td>
                      <td className="py-2 pr-3 text-[#475569] whitespace-nowrap">
                        {actorLabel(row)}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </td>
                      <td className="py-2 pr-3 text-[#0F172A] whitespace-nowrap">
                        {targetLabel(row)}
                      </td>
                      <td className="py-2 pr-3 text-[#475569]">
                        {row.reason ?? <span className="text-[#94A3B8]">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Phase 8AD — Load older pagination footer. Same shape as
            the audit feed (Phase 8Z). Active chip + search persist. */}
        {state.kind === 'ready' && state.hasMore && (
          <div className="mt-3 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={state.loadingMore}
              className="inline-flex items-center gap-1.5 text-[12px] text-[#475569] hover:text-[#0F172A] px-3 py-1.5 rounded-lg border border-[#E2E8F0] hover:border-[#CBD5E1] hover:bg-[#F8FAFC] disabled:opacity-60"
            >
              {state.loadingMore ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Loading…
                </>
              ) : (
                'Load older'
              )}
            </button>
            {state.loadMoreError && (
              <span className="text-[11px] text-[#B91C1C]">
                Couldn&apos;t load older events: {state.loadMoreError}
              </span>
            )}
          </div>
        )}
      </CardContent>

      {/* Phase 8AF — row-click drawer. Selected row state is
          card-local; closing the drawer preserves every filter and
          the visible page. */}
      <DigestAuditEventDrawer
        open={drawerOpen}
        item={selectedEvent}
        onClose={() => setDrawerOpen(false)}
        onViewRelatedSend={handleViewRelatedSend}
      />
    </Card>
  )
}
