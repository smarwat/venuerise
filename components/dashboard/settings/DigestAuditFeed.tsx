'use client'

import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Loader2, AlertTriangle, Download, RefreshCw, X } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { Badge } from '@/components/dashboard/ui/Badge'

/**
 * Phase 8AB — case-insensitive search highlight.
 *
 * Splits the source text by the literal `q` substring (case-
 * insensitive, no regex injection — we use String.indexOf rather
 * than building a RegExp from user input) and wraps matches in
 * <mark>. No `dangerouslySetInnerHTML`: the React tree is built
 * piecewise so any `<` in the source becomes plain text.
 *
 * Returns the original string unchanged when `q` is empty or longer
 * than the source — both cases produce zero matches and the runtime
 * cost of wrapping is wasted.
 */
function highlight(text: string | null | undefined, q: string): ReactNode {
  if (text === null || text === undefined) return text
  const source = String(text)
  const term = q.trim()
  if (term.length === 0) return source
  if (term.length > source.length) return source
  const lowerSource = source.toLowerCase()
  const lowerTerm = term.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let key = 0
  while (cursor <= source.length) {
    const idx = lowerSource.indexOf(lowerTerm, cursor)
    if (idx === -1) {
      parts.push(<Fragment key={key++}>{source.slice(cursor)}</Fragment>)
      break
    }
    if (idx > cursor) {
      parts.push(<Fragment key={key++}>{source.slice(cursor, idx)}</Fragment>)
    }
    const matchEnd = idx + term.length
    parts.push(
      <mark
        key={key++}
        className="rounded bg-amber-100 px-0.5 text-amber-950"
      >
        {source.slice(idx, matchEnd)}
      </mark>
    )
    cursor = matchEnd
  }
  return parts
}

/**
 * Phase 8Y — DigestAuditFeed
 *
 * Operator-facing audit feed over /api/admin/digest/sends. Lists the
 * last 25 digest deliveries with a send-kind filter chip set + a CSV
 * export link. Mirrors the visual identity of the existing Phase 8O
 * TourStatusActivityFeed on the same page.
 *
 * ── DATA SOURCE CAVEAT ────────────────────────────────────────────────────
 * The feed reads `outbound_messages` rows — that's the "we asked the
 * provider to send this" log. It is NOT the same as the Resend webhook
 * delivery state; an outbound row reaches `delivered` only when the
 * Resend webhook fires back to /api/resend/webhook. So the `Status`
 * column may lag behind real-world delivery by a few seconds.
 *
 * ── RBAC ──────────────────────────────────────────────────────────────────
 * Mounted only when the calling user is admin/owner. The parent
 * (`billing/page.tsx`) does the role gate; this component's fetch
 * surface also returns 401/403 for non-admins, so a stray mount is
 * safe — it just renders an error state.
 */

const PAGE_SIZE = 25

// Phase 8AC archived-toggle key. Kept for backwards compat: an
// operator who had Show archived enabled before Phase 8AF shipped
// should keep the preference after upgrade. New code reads/writes
// the Phase 8AF key (`SEND_ARCHIVED_STORAGE_KEY` below) first.
const LEGACY_INCLUDE_ARCHIVED_STORAGE_KEY =
  'venuerise:digest-audit-feed:include-archived:v1'

// Phase 8AF — URL params + localStorage keys for the digest sends
// feed. Mirrors the Phase 8AE DigestAuditLogCard convention.
//   URL > localStorage > defaults
//   `q` is URL-only (never persisted — typed searches are ephemeral).
//   `cursor` is bookmark-only (read on mount, written by Load older).
const URL_PARAM_SEND_KIND = 'digest_send_kind'
const URL_PARAM_SEND_RECIPIENT = 'digest_send_recipient'
const URL_PARAM_SEND_Q = 'digest_send_q'
const URL_PARAM_SEND_CURSOR = 'digest_send_cursor'
const URL_PARAM_SEND_ARCHIVED = 'digest_send_archived'

const SEND_KIND_STORAGE_KEY = 'venuerise:digest-send-feed:kind:v1'
const SEND_RECIPIENT_STORAGE_KEY = 'venuerise:digest-send-feed:recipient:v1'
const SEND_ARCHIVED_STORAGE_KEY =
  'venuerise:digest-send-feed:include-archived:v1'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEND_KIND_FILTERS = [
  { value: 'all',     label: 'All'     },
  { value: 'cron',    label: 'Cron'    },
  { value: 'preview', label: 'Preview' },
  { value: 'manual',  label: 'Manual'  },
] as const

type SendKindFilter = (typeof SEND_KIND_FILTERS)[number]['value']

const VALID_SEND_KINDS: readonly string[] = SEND_KIND_FILTERS.map((f) => f.value)

function coerceSendKind(raw: string | null): SendKindFilter | null {
  if (raw && VALID_SEND_KINDS.includes(raw)) return raw as SendKindFilter
  return null
}

interface SendItem {
  id: string
  venue_id: string
  recipient_user_id: string | null
  recipient_email: string | null
  send_kind: string
  status: string
  provider: string | null
  event_count: number | null
  cadence: string | null
  weekly_day: string | null
  manual_initiator_user_id: string | null
  error: string | null
  created_at: string
  delivered_at: string | null
  /** Phase 8AC — surfaced by the Phase 8AB sends endpoint; tells the
   *  UI whether the Phase 8AB retention cron has soft-archived this
   *  row. Always present on the response shape. */
  archived?: boolean
}

// Phase 8Z — `ready` state now carries pagination metadata for the
// "Load older" button. `loadingMore` is a transient flag during the
// next-page fetch; the existing items stay visible (no full reload).
type FeedState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      items: SendItem[]
      nextCursor: string | null
      hasMore: boolean
      loadingMore: boolean
      loadMoreError: string | null
    }

function badgeForKind(kind: string): { label: string; variant: 'navy' | 'blue' | 'default' } {
  switch (kind) {
    case 'cron':    return { label: 'Cron',    variant: 'navy' }
    case 'preview': return { label: 'Preview', variant: 'blue' }
    case 'manual':  return { label: 'Manual',  variant: 'blue' }
    default:        return { label: kind || 'unknown', variant: 'default' }
  }
}

function statusToneClass(status: string): string {
  // Color the status pill to match the existing billing-page activity
  // feed conventions: green for delivered, amber for suppressed,
  // red for failures, slate for in-flight.
  if (status === 'delivered') return 'bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]'
  if (status === 'suppressed') return 'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]'
  if (status === 'bounced' || status === 'complained' || status === 'failed')
    return 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]'
  return 'bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]'
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function DigestAuditFeed() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Phase 8AF — URL > localStorage > defaults. Mirrors the Phase 8AE
  // DigestAuditLogCard initialization. Read synchronously on render
  // so the first fetch already targets the right filter (no double-
  // fetch on mount).
  const initialSendKindFromUrl =
    typeof window !== 'undefined'
      ? coerceSendKind(searchParams?.get(URL_PARAM_SEND_KIND) ?? null)
      : null
  const initialRecipientFromUrl = (() => {
    if (typeof window === 'undefined') return null
    const raw = searchParams?.get(URL_PARAM_SEND_RECIPIENT) ?? null
    return raw && UUID_RE.test(raw) ? raw : null
  })()
  const initialQFromUrl =
    typeof window !== 'undefined'
      ? searchParams?.get(URL_PARAM_SEND_Q) ?? ''
      : ''
  const initialCursorFromUrl = (() => {
    if (typeof window === 'undefined') return null
    const raw = searchParams?.get(URL_PARAM_SEND_CURSOR) ?? null
    if (!raw) return null
    const parsed = new Date(raw)
    return Number.isFinite(parsed.getTime()) ? raw : null
  })()
  // Archived URL value is opt-in: '1' or 'true' both turn it on.
  // Anything else (absent / other strings) coerces to false to match
  // the API default.
  const initialArchivedFromUrl = (() => {
    if (typeof window === 'undefined') return null
    const raw = searchParams?.get(URL_PARAM_SEND_ARCHIVED)
    if (raw === null || raw === undefined) return null
    return raw === '1' || raw === 'true'
  })()
  const initialSendKindFromStorage =
    typeof window !== 'undefined' && initialSendKindFromUrl === null
      ? (() => {
          try {
            return coerceSendKind(
              window.localStorage.getItem(SEND_KIND_STORAGE_KEY)
            )
          } catch {
            return null
          }
        })()
      : null
  const initialRecipientFromStorage =
    typeof window !== 'undefined' && initialRecipientFromUrl === null
      ? (() => {
          try {
            const raw = window.localStorage.getItem(SEND_RECIPIENT_STORAGE_KEY)
            return raw && UUID_RE.test(raw) ? raw : null
          } catch {
            return null
          }
        })()
      : null
  const initialArchivedFromStorage =
    typeof window !== 'undefined' && initialArchivedFromUrl === null
      ? (() => {
          try {
            // Prefer the Phase 8AF key, fall back to the Phase 8AC
            // legacy key so an operator who had Show archived
            // enabled before the upgrade keeps their preference.
            const raw =
              window.localStorage.getItem(SEND_ARCHIVED_STORAGE_KEY) ??
              window.localStorage.getItem(LEGACY_INCLUDE_ARCHIVED_STORAGE_KEY)
            return raw === 'true'
          } catch {
            return false
          }
        })()
      : null

  const [filter, setFilterState] = useState<SendKindFilter>(
    initialSendKindFromUrl ?? initialSendKindFromStorage ?? 'all'
  )
  const [state, setState] = useState<FeedState>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  const [searchInput, setSearchInput] = useState<string>(initialQFromUrl)
  const [searchTerm, setSearchTerm] = useState<string>(initialQFromUrl.trim())
  const [recipientFilter, setRecipientFilterState] = useState<string | null>(
    initialRecipientFromUrl ?? initialRecipientFromStorage
  )
  const [includeArchived, setIncludeArchivedState] = useState<boolean>(
    initialArchivedFromUrl ?? initialArchivedFromStorage ?? false
  )
  const [initialCursor, setInitialCursor] = useState<string | null>(
    initialCursorFromUrl
  )

  // Phase 8AF — single URL writer. Sync ALL feed params with one
  // router.replace so chip / search / recipient / archived changes
  // don't stack history entries. Preserves unrelated billing-page
  // params (e.g. the Phase 8AE audit-log params live alongside).
  const writeUrl = useCallback(
    (next: {
      kind: SendKindFilter
      q: string
      recipient: string | null
      archived: boolean
      cursor: string | null
    }) => {
      if (typeof window === 'undefined') return
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      if (next.kind === 'all') params.delete(URL_PARAM_SEND_KIND)
      else params.set(URL_PARAM_SEND_KIND, next.kind)
      if (next.q.length === 0) params.delete(URL_PARAM_SEND_Q)
      else params.set(URL_PARAM_SEND_Q, next.q)
      if (!next.recipient) params.delete(URL_PARAM_SEND_RECIPIENT)
      else params.set(URL_PARAM_SEND_RECIPIENT, next.recipient)
      // Archived only present in URL when on — keeps the URL clean
      // in the default off case.
      if (!next.archived) params.delete(URL_PARAM_SEND_ARCHIVED)
      else params.set(URL_PARAM_SEND_ARCHIVED, '1')
      if (next.cursor === null) params.delete(URL_PARAM_SEND_CURSOR)
      else params.set(URL_PARAM_SEND_CURSOR, next.cursor)
      const nextStr = params.toString()
      const href = nextStr.length > 0 ? `${pathname}?${nextStr}` : pathname
      router.replace(href, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  function setFilter(next: SendKindFilter): void {
    setFilterState(next)
    if (typeof window !== 'undefined') {
      try {
        if (next === 'all') {
          window.localStorage.removeItem(SEND_KIND_STORAGE_KEY)
        } else {
          window.localStorage.setItem(SEND_KIND_STORAGE_KEY, next)
        }
      } catch {
        // best-effort
      }
    }
    setInitialCursor(null)
    writeUrl({
      kind: next,
      q: searchTerm,
      recipient: recipientFilter,
      archived: includeArchived,
      cursor: null,
    })
  }

  function setRecipientFilter(next: string | null): void {
    setRecipientFilterState(next)
    if (typeof window !== 'undefined') {
      try {
        if (next) {
          window.localStorage.setItem(SEND_RECIPIENT_STORAGE_KEY, next)
        } else {
          window.localStorage.removeItem(SEND_RECIPIENT_STORAGE_KEY)
        }
      } catch {
        // best-effort
      }
    }
    setInitialCursor(null)
    writeUrl({
      kind: filter,
      q: searchTerm,
      recipient: next,
      archived: includeArchived,
      cursor: null,
    })
  }

  function updateIncludeArchived(next: boolean): void {
    setIncludeArchivedState(next)
    if (typeof window !== 'undefined') {
      try {
        if (next) {
          window.localStorage.setItem(SEND_ARCHIVED_STORAGE_KEY, 'true')
        } else {
          window.localStorage.removeItem(SEND_ARCHIVED_STORAGE_KEY)
          // Also clear the Phase 8AC legacy key so we don't pick it
          // back up on next reload.
          window.localStorage.removeItem(LEGACY_INCLUDE_ARCHIVED_STORAGE_KEY)
        }
      } catch {
        // best-effort
      }
    }
    setInitialCursor(null)
    writeUrl({
      kind: filter,
      q: searchTerm,
      recipient: recipientFilter,
      archived: next,
      cursor: null,
    })
  }

  // Phase 8AF — Jump to latest. Clears the URL cursor + the in-
  // memory initialCursor, triggering a clean page-1 refetch via the
  // fetch effect dependency. Filters stay where they were.
  function handleJumpToLatest(): void {
    setInitialCursor(null)
    writeUrl({
      kind: filter,
      q: searchTerm,
      recipient: recipientFilter,
      archived: includeArchived,
      cursor: null,
    })
  }

  function handleResetFilters(): void {
    setFilterState('all')
    setSearchInput('')
    setSearchTerm('')
    setRecipientFilterState(null)
    setIncludeArchivedState(false)
    setInitialCursor(null)
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(SEND_KIND_STORAGE_KEY)
        window.localStorage.removeItem(SEND_RECIPIENT_STORAGE_KEY)
        window.localStorage.removeItem(SEND_ARCHIVED_STORAGE_KEY)
        window.localStorage.removeItem(LEGACY_INCLUDE_ARCHIVED_STORAGE_KEY)
      } catch {
        // best-effort
      }
    }
    writeUrl({
      kind: 'all',
      q: '',
      recipient: null,
      archived: false,
      cursor: null,
    })
  }

  // Debounce searchInput → searchTerm by 300ms so a fast typist
  // doesn't fire a fetch per keystroke. Filter chip / recipient
  // filter / reload all bypass this debounce (they're discrete
  // events).
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = searchInput.trim()
      // Phase 8AF — avoid a no-op URL replace when nothing changed
      // (avoids churning the browser history on an unchanged term).
      if (next === searchTerm) return
      setSearchTerm(next)
      setInitialCursor(null)
      writeUrl({
        kind: filter,
        q: next,
        recipient: recipientFilter,
        archived: includeArchived,
        cursor: null,
      })
    }, 300)
    return () => clearTimeout(handle)
  }, [
    searchInput,
    searchTerm,
    filter,
    recipientFilter,
    includeArchived,
    writeUrl,
  ])

  useEffect(() => {
    let cancelled = false
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const params = new URLSearchParams()
        params.set('limit', String(PAGE_SIZE))
        if (filter !== 'all') params.set('send_kind', filter)
        if (recipientFilter) params.set('recipient_user_id', recipientFilter)
        if (searchTerm) params.set('q', searchTerm)
        if (includeArchived) params.set('include_archived', 'true')
        // Phase 8AF — honor URL-supplied cursor on initial mount
        // (and any subsequent setInitialCursor change). Lets a
        // shared link drop the operator on the same page boundary.
        if (initialCursor) params.set('occurred_before', initialCursor)
        const res = await fetch(`/api/admin/digest/sends?${params.toString()}`, {
          method: 'GET',
          signal: abort.signal,
          credentials: 'same-origin',
        })
        if (cancelled) return
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null
          const code =
            body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
          setState({ kind: 'error', message: code })
          return
        }
        const body = (await res.json()) as {
          items?: SendItem[]
          next_cursor?: string | null
          has_more?: boolean
        }
        const items = Array.isArray(body.items) ? body.items : []
        setState({
          kind: 'ready',
          items,
          nextCursor: typeof body.next_cursor === 'string' ? body.next_cursor : null,
          hasMore: Boolean(body.has_more),
          loadingMore: false,
          loadMoreError: null,
        })
      } catch (err) {
        if (cancelled) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        })
      }
    })()
    return () => {
      cancelled = true
      abort.abort()
    }
    // Phase 8AA — also reset pagination on search / recipient filter
    // change (the dependency list re-runs the effect, which always
    // restarts at page 1). The two new dependencies guarantee that.
    // Phase 8AC — `includeArchived` joins the dependency list so
    // toggling on/off resets to page 1 with the new filter.
    // Phase 8AF — `initialCursor` joins so Jump to latest /
    // shared-link-with-cursor changes trigger a clean refetch.
  }, [filter, reloadTick, searchTerm, recipientFilter, includeArchived, initialCursor])

  // CSV download URL mirrors the live filter — the operator gets a
  // CSV of what they're currently looking at, not the full unfiltered
  // feed. The endpoint's hard limit (200) caps how much the CSV can
  // dump; the operator can chain calls with `since` for wider windows.
  //
  // Phase 8Z note — CSV export deliberately ignores the pagination
  // cursor. An operator who wants a wider window via `?occurred_before=`
  // can hit the endpoint directly. The CSV button is a one-click
  // "export what I'm looking at, plus headroom".
  const csvHref = (() => {
    const params = new URLSearchParams()
    params.set('format', 'csv')
    params.set('limit', '200')
    if (filter !== 'all') params.set('send_kind', filter)
    if (recipientFilter) params.set('recipient_user_id', recipientFilter)
    if (searchTerm) params.set('q', searchTerm)
    if (includeArchived) params.set('include_archived', 'true')
    return `/api/admin/digest/sends?${params.toString()}`
  })()

  // Phase 8Z — "Load older" fetcher. Appends the next page to the
  // existing items rather than replacing them. Uses the cursor from
  // the most-recent successful fetch; on error stores an inline
  // message but keeps the visible rows intact.
  async function handleLoadMore() {
    if (state.kind !== 'ready' || !state.hasMore || !state.nextCursor) return
    // Phase 8AF — reflect cursor to URL so a refresh doesn't dump
    // the operator back to page 1 mid-investigation. Same pattern
    // as DigestAuditLogCard.
    writeUrl({
      kind: filter,
      q: searchTerm,
      recipient: recipientFilter,
      archived: includeArchived,
      cursor: state.nextCursor,
    })
    setState({ ...state, loadingMore: true, loadMoreError: null })
    try {
      const params = new URLSearchParams()
      params.set('limit', String(PAGE_SIZE))
      params.set('occurred_before', state.nextCursor)
      if (filter !== 'all') params.set('send_kind', filter)
      if (recipientFilter) params.set('recipient_user_id', recipientFilter)
      if (searchTerm) params.set('q', searchTerm)
      if (includeArchived) params.set('include_archived', 'true')
      const res = await fetch(`/api/admin/digest/sends?${params.toString()}`, {
        method: 'GET',
        credentials: 'same-origin',
      })
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
        items?: SendItem[]
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

  // Phase 8Z — top-3-recipients mini-summary over the currently
  // loaded slice. Pure derived state; no extra fetch. Helps operators
  // spot a single bouncing recipient absorbing all the sends.
  const topRecipients = (() => {
    if (state.kind !== 'ready' || state.items.length === 0) return []
    // Phase 8AA — also carry the underlying user_id so the rendered
    // summary can clickably pin a recipient filter. `unknown` rows
    // (no recipient_user_id, typically a preview without the marker)
    // get `userId: null` and render as un-clickable text.
    const counts = new Map<
      string,
      { label: string; n: number; userId: string | null }
    >()
    for (const row of state.items) {
      const key = row.recipient_user_id ?? 'unknown'
      const label =
        row.recipient_email ??
        (row.recipient_user_id ? `user ${row.recipient_user_id.slice(0, 8)}` : 'unknown')
      const existing = counts.get(key)
      if (existing) {
        existing.n++
      } else {
        counts.set(key, { label, n: 1, userId: row.recipient_user_id ?? null })
      }
    }
    return Array.from(counts.values())
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
  })()

  // Phase 8AF — Reset surfaces only when something is narrowing the
  // feed. `initialCursor` counts as a filter even though it isn't a
  // chip/search — the operator landed on it via a shared link and
  // Reset is the canonical recover path.
  const sendFeedHasActiveFilter =
    filter !== 'all' ||
    searchTerm.length > 0 ||
    recipientFilter !== null ||
    includeArchived ||
    initialCursor !== null

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Digest send activity</CardTitle>
          <CardSubtitle>
            Recent digest deliveries for this venue (last {PAGE_SIZE}). Includes
            scheduled cron, preview, and manual sends.
          </CardSubtitle>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {/* Phase 8AF — Reset surfaces only when any filter is
              actively narrowing the feed. Clears URL params +
              every localStorage key + the in-memory cursor. */}
          {sendFeedHasActiveFilter && (
            <button
              type="button"
              onClick={handleResetFilters}
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
            operator landed via a shared link with
            ?digest_send_cursor= so they see "this isn't page 1"
            and can recover with one click. */}
        {initialCursor && (
          <div className="mb-3 rounded-lg bg-[#FFFBEB] border border-[#FDE68A] px-3 py-2 text-[12px] text-[#92400E] flex items-center justify-between gap-2">
            <span>Viewing an earlier digest send page.</span>
            <button
              type="button"
              onClick={handleJumpToLatest}
              className="inline-flex items-center text-[11px] font-semibold text-[#92400E] bg-white border border-[#FDE68A] hover:border-[#F59E0B] hover:bg-[#FEF3C7] px-2 py-1 rounded-md"
            >
              Jump to latest
            </button>
          </div>
        )}

        {/* Phase 8AA — free-text search input. 300ms debounce
            handles fetch backoff; the short-query hint below explains
            the 3-char threshold. Active recipient pin shows as a
            small chip to the right of the input so the operator
            knows what's narrowing the result set. */}
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search status, provider, error, cadence, day, recipient or initiator id…"
            maxLength={120}
            className="flex-1 min-w-[200px] rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-[12px] text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#1D4ED8]"
          />
          {recipientFilter && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-[#1D4ED8] bg-[#EFF6FF] border border-[#BFDBFE] px-2 py-1 rounded-full">
              <span>Recipient pinned</span>
              <button
                type="button"
                onClick={() => setRecipientFilter(null)}
                className="text-[#1D4ED8] hover:text-[#1E40AF] text-[13px] leading-none"
                title="Clear recipient filter"
                aria-label="Clear recipient filter"
              >
                ×
              </button>
            </span>
          )}
        </div>
        {/* Short-query hint — matches the Phase 8U status-events
            activity feed's amber pill copy. Renders only when the
            input has 1 or 2 chars. */}
        {searchInput.trim().length > 0 && searchInput.trim().length < 3 && (
          <p className="text-[11px] text-[#B45309] bg-[#FFFBEB] border border-[#FDE68A] rounded-md px-2 py-1 mb-2 inline-block">
            Searching core fields only. Type 3+ characters for fuller metadata matching.
          </p>
        )}

        {/* Phase 8AC — `Show archived` toggle. Persisted in
            localStorage (storage key: INCLUDE_ARCHIVED_STORAGE_KEY).
            Hides archived rows in the default view; toggle threads
            ?include_archived=true into JSON, Load older, and CSV
            export URLs. */}
        <label className="inline-flex items-center gap-2 text-[11px] text-[#475569] mb-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => updateIncludeArchived(e.target.checked)}
            className="accent-[#1D4ED8]"
          />
          Show archived
        </label>

        {/* Send-kind filter chips. Mirrors the Phase 8O billing-page
            activity feed's chip pattern. */}
        <div className="flex items-center gap-1.5 mb-3 flex-wrap">
          {SEND_KIND_FILTERS.map((opt) => {
            const active = filter === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setFilter(opt.value)}
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
            Loading digest sends…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2.5 text-[12px] text-[#B91C1C] flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p>Couldn&apos;t load digest sends: {state.message}</p>
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
            No digest sends recorded yet.
          </div>
        )}

        {/* Phase 8Z + 8AA — top-3-recipients summary over the
            currently loaded slice. Phase 8AA — each entry is a button
            that pins the feed to that recipient's sends (uses the
            existing `recipient_user_id` endpoint filter). The
            `unknown` bucket (rows without a recipient_user_id) stays
            as plain text since there's nothing to pin to. */}
        {state.kind === 'ready' && topRecipients.length > 0 && (
          <p className="text-[11px] text-[#64748B] mb-2">
            <span className="text-[#94A3B8]">Last loaded sends: </span>
            {topRecipients.map((r, idx) => {
              const clickable = r.userId !== null
              const isActive = clickable && recipientFilter === r.userId
              return (
                <span key={`${r.label}-${idx}`}>
                  {clickable ? (
                    <button
                      type="button"
                      onClick={() =>
                        setRecipientFilter(isActive ? null : r.userId)
                      }
                      title={
                        isActive
                          ? 'Clear recipient filter'
                          : `Filter to sends to ${r.label}`
                      }
                      className={`font-medium underline decoration-dotted hover:decoration-solid ${
                        isActive ? 'text-[#1D4ED8]' : 'text-[#0F172A] hover:text-[#1D4ED8]'
                      }`}
                    >
                      {r.label}
                    </button>
                  ) : (
                    <span className="text-[#0F172A] font-medium">{r.label}</span>
                  )}
                  <span className="text-[#475569]"> {r.n}</span>
                  {idx < topRecipients.length - 1 ? (
                    <span className="text-[#CBD5E1]"> · </span>
                  ) : null}
                </span>
              )
            })}
          </p>
        )}

        {state.kind === 'ready' && state.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-[#94A3B8]">
                  <th className="py-2 pr-3 font-semibold">Kind</th>
                  <th className="py-2 pr-3 font-semibold">Recipient</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 pr-3 font-semibold">Events</th>
                  <th className="py-2 pr-3 font-semibold">Cadence</th>
                  <th className="py-2 pr-3 font-semibold">Sent</th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((row) => {
                  const kindBadge = badgeForKind(row.send_kind)
                  return (
                    <tr
                      key={row.id}
                      className="border-t border-[#F1F5F9] hover:bg-[#F8FAFC]"
                    >
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {/* Phase 8AB — Badge label still wraps the
                            chip; the highlight wraps only the inner
                            text node so the surrounding pill stays
                            intact.
                            Phase 8AC — additional slate "Archived"
                            tag for rows tagged by the retention cron,
                            so an operator with the toggle on can
                            tell archived from live at a glance. */}
                        <span className="inline-flex items-center gap-1.5">
                          <Badge variant={kindBadge.variant}>
                            {highlight(kindBadge.label, searchTerm)}
                          </Badge>
                          {row.archived && (
                            <span
                              className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]"
                              title="Soft-archived by the weekly retention cron"
                            >
                              Archived
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-[#0F172A] whitespace-nowrap">
                        {row.recipient_email ? (
                          highlight(row.recipient_email, searchTerm)
                        ) : (
                          <span className="text-[#94A3B8]">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span
                          className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border ${statusToneClass(row.status)}`}
                        >
                          {highlight(row.status, searchTerm)}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-[#475569] whitespace-nowrap">
                        {row.event_count ?? 0}
                      </td>
                      <td className="py-2 pr-3 text-[#475569] whitespace-nowrap">
                        {row.cadence ? (
                          <>
                            {highlight(row.cadence, searchTerm)}
                            {row.cadence === 'weekly' && row.weekly_day ? (
                              <>
                                {' · '}
                                {highlight(row.weekly_day, searchTerm)}
                              </>
                            ) : null}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 pr-3 text-[#475569] whitespace-nowrap">
                        {formatTime(row.created_at)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Phase 8Z — "Load older" pagination footer. Appears only when
            the most recent fetch reported `has_more: true`. Inline
            error keeps the table visible if a load-more fetch fails. */}
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
                Couldn&apos;t load older sends: {state.loadMoreError}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
