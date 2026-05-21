'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, AlertTriangle, Download, X, Shield, Copy, Check } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { Badge } from '@/components/dashboard/ui/Badge'

/**
 * Phase 9A — EnterpriseAuditEventsCard
 *
 * Surfaces `public.audit_events` (migration 027) on
 * `/dashboard/settings/billing`. Distinct from the Phase 8AC
 * DigestAuditLogCard (digest-specific) — this card is the
 * cross-cutting security audit log a reviewer would pull during an
 * incident or a vendor questionnaire.
 *
 * ── PII POSTURE ───────────────────────────────────────────────────────────
 *   - List view does NOT request `include_snapshots`, so the
 *     before/after snapshot jsonb payloads never enter the browser
 *     unless the operator opens the drawer.
 *   - The drawer fetches the single row with `?id=<uuid>&include_snapshots=1`
 *     and renders the sanitized snapshots verbatim — the helper
 *     already dropped sensitive keys + capped size at write time.
 *   - `ip_hash` is the salted-SHA-256 fingerprint, never the raw IP.
 *
 * ── SCOPE GUARDS ──────────────────────────────────────────────────────────
 *   - Admin/owner gate is enforced by both the route + the page-level
 *     `isAdmin` check that decides whether to mount this card at all.
 *   - Filter inputs are intentionally narrow: action (exact), target
 *     table (exact), actor user id (uuid). Free-text search is
 *     deliberately omitted in this first pass — operators searching
 *     metadata strings should drop into SQL.
 */

const PAGE_SIZE = 25

interface AuditEventListItem {
  id: string
  venue_id: string
  actor_user_id: string | null
  actor_kind: string
  route: string
  action: string
  target_table: string | null
  target_id: string | null
  request_id: string | null
  ip_hash: string | null
  user_agent: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

interface AuditEventFullItem extends AuditEventListItem {
  before_snapshot: Record<string, unknown> | null
  after_snapshot: Record<string, unknown> | null
}

type FeedState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      items: AuditEventListItem[]
      nextCursor: string | null
      hasMore: boolean
      loadingMore: boolean
      loadMoreError: string | null
    }

interface DrawerState {
  open: boolean
  loading: boolean
  error: string | null
  row: AuditEventFullItem | null
}

function actorLabel(item: AuditEventListItem): string {
  if (item.actor_kind === 'cron') return 'Cron'
  if (item.actor_kind === 'system') return 'System'
  if (item.actor_kind === 'webhook') return 'Webhook'
  if (item.actor_user_id) return `Operator · ${item.actor_user_id.slice(0, 8)}`
  return 'Operator'
}

function badgeForActor(
  actorKind: string
): { label: string; variant: 'navy' | 'blue' | 'default' } {
  if (actorKind === 'cron') return { label: 'cron', variant: 'blue' }
  if (actorKind === 'system') return { label: 'system', variant: 'navy' }
  if (actorKind === 'webhook') return { label: 'webhook', variant: 'blue' }
  return { label: 'operator', variant: 'default' }
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

interface EnterpriseAuditEventsCardProps {
  /**
   * Phase 9C — mirror indicator. Server-rendered into the card so
   * the operator sees the mirror config state without a new admin
   * endpoint. `null` means "config unknown" (legacy mount path that
   * didn't pass the prop); the card renders the line only when a
   * concrete boolean is supplied.
   */
  auditMirrorEnabled?: boolean | null
}

export default function EnterpriseAuditEventsCard({
  auditMirrorEnabled = null,
}: EnterpriseAuditEventsCardProps = {}) {
  const [actionFilter, setActionFilter] = useState<string>('')
  const [targetTableFilter, setTargetTableFilter] = useState<string>('')
  const [actorUserFilter, setActorUserFilter] = useState<string>('')
  // Debounced applied filters drive the fetch — keystrokes don't
  // refetch on every char.
  const [appliedAction, setAppliedAction] = useState<string>('')
  const [appliedTargetTable, setAppliedTargetTable] = useState<string>('')
  const [appliedActorUser, setAppliedActorUser] = useState<string>('')
  const [state, setState] = useState<FeedState>({ kind: 'loading' })
  const [drawer, setDrawer] = useState<DrawerState>({
    open: false,
    loading: false,
    error: null,
    row: null,
  })

  // 300ms debounce for the three filter inputs → applied state.
  useEffect(() => {
    const handle = setTimeout(() => {
      setAppliedAction(actionFilter.trim())
      setAppliedTargetTable(targetTableFilter.trim())
      setAppliedActorUser(actorUserFilter.trim())
    }, 300)
    return () => clearTimeout(handle)
  }, [actionFilter, targetTableFilter, actorUserFilter])

  // Initial fetch + refetch on any applied filter change.
  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const params = new URLSearchParams()
        params.set('limit', String(PAGE_SIZE))
        if (appliedAction) params.set('action', appliedAction)
        if (appliedTargetTable) params.set('target_table', appliedTargetTable)
        if (appliedActorUser) params.set('actor_user_id', appliedActorUser)
        const res = await fetch(
          `/api/admin/audit-events?${params.toString()}`,
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
          items?: AuditEventListItem[]
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
  }, [appliedAction, appliedTargetTable, appliedActorUser])

  const handleLoadMore = useCallback(async () => {
    if (state.kind !== 'ready' || !state.hasMore || !state.nextCursor) return
    setState({ ...state, loadingMore: true, loadMoreError: null })
    try {
      const params = new URLSearchParams()
      params.set('limit', String(PAGE_SIZE))
      params.set('occurred_before', state.nextCursor)
      if (appliedAction) params.set('action', appliedAction)
      if (appliedTargetTable) params.set('target_table', appliedTargetTable)
      if (appliedActorUser) params.set('actor_user_id', appliedActorUser)
      const res = await fetch(
        `/api/admin/audit-events?${params.toString()}`,
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
        items?: AuditEventListItem[]
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
  }, [state, appliedAction, appliedTargetTable, appliedActorUser])

  const openDrawer = useCallback(async (id: string) => {
    setDrawer({ open: true, loading: true, error: null, row: null })
    try {
      const res = await fetch(
        `/api/admin/audit-events?id=${encodeURIComponent(id)}&include_snapshots=1`,
        { method: 'GET', credentials: 'same-origin' }
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null
        const code =
          body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
        setDrawer({ open: true, loading: false, error: code, row: null })
        return
      }
      const body = (await res.json()) as { item?: AuditEventFullItem }
      setDrawer({
        open: true,
        loading: false,
        error: null,
        row: body.item ?? null,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error'
      setDrawer({ open: true, loading: false, error: message, row: null })
    }
  }, [])

  function closeDrawer(): void {
    setDrawer({ open: false, loading: false, error: null, row: null })
  }

  // CSV link inherits the active filters. Cursor deliberately omitted
  // — operators get the full current filter at limit=200, same
  // convention as DigestAuditLogCard.
  const csvHref = (() => {
    const params = new URLSearchParams()
    params.set('format', 'csv')
    params.set('limit', '200')
    params.set('include_snapshots', '1')
    if (appliedAction) params.set('action', appliedAction)
    if (appliedTargetTable) params.set('target_table', appliedTargetTable)
    if (appliedActorUser) params.set('actor_user_id', appliedActorUser)
    return `/api/admin/audit-events?${params.toString()}`
  })()

  const hasActiveFilter =
    appliedAction.length > 0 ||
    appliedTargetTable.length > 0 ||
    appliedActorUser.length > 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <Shield className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Enterprise audit log</CardTitle>
              <CardSubtitle>
                Every sensitive write — leads, tours, settings, AI safety,
                digest. Snapshots are sanitized + capped at 4KB.
              </CardSubtitle>
              {/* Phase 9C — best-effort mirror state. Renders only
                  when the billing page passed a concrete boolean
                  prop (server-side env read). Legacy mounts that
                  didn't pass the prop stay silent — avoids a
                  misleading "Mirror: disabled" line when the truth
                  is "unknown to this card." */}
              {auditMirrorEnabled !== null && (
                <div className="mt-1 text-xs text-slate-500">
                  Mirror:{' '}
                  <span
                    className={
                      auditMirrorEnabled
                        ? 'font-medium text-emerald-600'
                        : 'font-medium text-slate-500'
                    }
                  >
                    {auditMirrorEnabled ? 'best-effort enabled' : 'disabled'}
                  </span>
                  {' · '}
                  <span className="text-slate-400">
                    audit_event_mirror, owner-only RLS
                  </span>
                </div>
              )}
            </div>
          </div>
          <a
            href={csvHref}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
            download
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </a>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <input
            type="text"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            placeholder="action (e.g. lead_update)"
            className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
          />
          <input
            type="text"
            value={targetTableFilter}
            onChange={(e) => setTargetTableFilter(e.target.value)}
            placeholder="target table (e.g. leads)"
            className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
          />
          <input
            type="text"
            value={actorUserFilter}
            onChange={(e) => setActorUserFilter(e.target.value)}
            placeholder="actor user id (uuid)"
            className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
          />
        </div>

        {state.kind === 'loading' && (
          <div className="flex items-center justify-center py-10 text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading audit events…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <div className="font-medium">Could not load audit events</div>
              <div className="text-xs">{state.message}</div>
            </div>
          </div>
        )}

        {state.kind === 'ready' && state.items.length === 0 && (
          <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
            {hasActiveFilter
              ? 'No audit events match the current filters.'
              : 'No audit events recorded yet. Activity will appear here as operators and crons make changes.'}
          </div>
        )}

        {state.kind === 'ready' && state.items.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs font-medium uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2 pr-3">When</th>
                    <th className="py-2 pr-3">Action</th>
                    <th className="py-2 pr-3">Actor</th>
                    <th className="py-2 pr-3">Target</th>
                    <th className="py-2 pr-3 text-right">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {state.items.map((item) => {
                    const actor = badgeForActor(item.actor_kind)
                    return (
                      <tr
                        key={item.id}
                        className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
                      >
                        <td className="whitespace-nowrap py-2 pr-3 text-slate-700">
                          {formatTime(item.created_at)}
                        </td>
                        <td className="py-2 pr-3">
                          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800">
                            {item.action}
                          </code>
                        </td>
                        <td className="py-2 pr-3 text-slate-700">
                          <div className="flex items-center gap-1.5">
                            <Badge variant={actor.variant}>{actor.label}</Badge>
                            <span className="text-xs">{actorLabel(item)}</span>
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-xs text-slate-600">
                          {item.target_table ? (
                            <>
                              <code className="font-mono">
                                {item.target_table}
                              </code>
                              {item.target_id && (
                                <span className="ml-1 text-slate-400">
                                  · {item.target_id.slice(0, 8)}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          <button
                            type="button"
                            className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                            onClick={() => openDrawer(item.id)}
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {state.hasMore && (
              <div className="mt-4 flex flex-col items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  onClick={handleLoadMore}
                  disabled={state.loadingMore}
                >
                  {state.loadingMore ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : null}
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

      {drawer.open && (
        <div className="fixed inset-0 z-50 flex">
          <div
            className="flex-1 bg-slate-900/40"
            onClick={closeDrawer}
            aria-label="Close audit event drawer"
          />
          <div className="w-full max-w-lg overflow-y-auto bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Audit event
                </div>
                <div className="flex items-center gap-2">
                  <div className="truncate font-mono text-sm text-slate-900">
                    {drawer.row?.id ?? '—'}
                  </div>
                  {drawer.row && (
                    <CopyButton
                      value={drawer.row.id}
                      label="Copy audit id"
                    />
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={closeDrawer}
                className="rounded-md p-1 hover:bg-slate-100"
                aria-label="Close"
              >
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>

            {drawer.loading && (
              <div className="flex items-center justify-center py-10 text-slate-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading…
              </div>
            )}

            {drawer.error && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div>{drawer.error}</div>
              </div>
            )}

            {drawer.row && (
              <div className="space-y-4 text-sm">
                <DrawerField label="When" value={formatTime(drawer.row.created_at)} />
                <DrawerField label="Action" value={drawer.row.action} mono />
                <DrawerField label="Route" value={drawer.row.route} mono />
                <DrawerField label="Actor kind" value={drawer.row.actor_kind} />
                <DrawerField
                  label="Actor user"
                  value={drawer.row.actor_user_id ?? '—'}
                  mono
                  copyable
                />
                <DrawerField
                  label="Target table"
                  value={drawer.row.target_table ?? '—'}
                  mono
                />
                <DrawerField
                  label="Target id"
                  value={drawer.row.target_id ?? '—'}
                  mono
                  copyable
                />
                <DrawerField
                  label="Request id"
                  value={drawer.row.request_id ?? '—'}
                  mono
                  copyable
                  copyLabel="Copy request id"
                />
                <DrawerField
                  label="IP fingerprint"
                  value={drawer.row.ip_hash ?? '—'}
                  mono
                />
                <DrawerField
                  label="User agent"
                  value={drawer.row.user_agent ?? '—'}
                />
                {/* Phase 9B — JSON blocks collapsed by default. The
                    sanitization happens at WRITE time in
                    lib/enterprise/audit-events.ts (sensitive keys
                    dropped, snapshot size-capped at 4 KB); the
                    drawer just renders the saved payload. Operators
                    expand only when they need the detail. */}
                <DrawerJson label="Before snapshot" value={drawer.row.before_snapshot} />
                <DrawerJson label="After snapshot" value={drawer.row.after_snapshot} />
                <DrawerJson label="Metadata" value={drawer.row.metadata} />
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        // Fallback for older browsers / non-secure contexts. The
        // textarea trick is documented in MDN; we still render the
        // copied check so the operator sees feedback.
        const ta = document.createElement('textarea')
        ta.value = value
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard refused (permission, focus). Silent — operator
      // can still select + Ctrl-C the visible value.
    }
  }, [value])
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded hover:bg-slate-100"
      aria-label={label}
      title={label}
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-600" />
      ) : (
        <Copy className="h-3 w-3 text-slate-500" />
      )}
    </button>
  )
}

function DrawerField({
  label,
  value,
  mono,
  copyable,
  copyLabel,
}: {
  label: string
  value: string
  copyable?: boolean
  copyLabel?: string
  mono?: boolean
}) {
  // Only attach the copy affordance when the value is non-empty +
  // not the placeholder dash — copying "—" would just confuse the
  // operator.
  const canCopy = copyable && value !== '—' && value.length > 0
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        <div
          className={
            mono
              ? 'min-w-0 flex-1 break-all font-mono text-sm text-slate-900'
              : 'min-w-0 flex-1 text-sm text-slate-900'
          }
        >
          {value}
        </div>
        {canCopy && <CopyButton value={value} label={copyLabel ?? `Copy ${label.toLowerCase()}`} />}
      </div>
    </div>
  )
}

function DrawerJson({
  label,
  value,
}: {
  label: string
  value: Record<string, unknown> | null
}) {
  const [expanded, setExpanded] = useState(false)
  if (!value || Object.keys(value).length === 0) {
    return (
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {label}
        </div>
        <div className="mt-0.5 text-sm text-slate-400">—</div>
      </div>
    )
  }
  // Compact preview when collapsed — show the top-level keys so an
  // operator can decide whether to expand without paying for the
  // full JSON render. Expanded form is the same sanitized payload
  // the helper saved (no further redaction needed at render time).
  const keys = Object.keys(value)
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {label}
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          {expanded ? 'Collapse' : `Expand (${keys.length} ${keys.length === 1 ? 'field' : 'fields'})`}
        </button>
      </div>
      {expanded ? (
        <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2 font-mono text-xs text-slate-800">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : (
        <div className="mt-1 truncate font-mono text-xs text-slate-500">
          {keys.slice(0, 4).join(', ')}
          {keys.length > 4 ? ', …' : ''}
        </div>
      )}
    </div>
  )
}
