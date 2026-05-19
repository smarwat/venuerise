'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'

/**
 * Phase 8Z → 8AA — DigestSuppressionsCallout
 *
 * Inline amber banner that surfaces above DigestAuditFeed whenever
 * ≥1 owner/admin member of this venue has an email currently sitting
 * on the global email_suppressions list.
 *
 * Phase 8AA additions:
 *   - Inline "Remove suppression" button on each row. Confirms via
 *     `window.confirm` then POSTs `(venue_id, user_id)` to
 *     `/api/admin/digest/suppressions/remove`. Email is re-resolved
 *     server-side; the client never sends a raw address.
 *   - Listens for `venuerise:digest-suppression-refresh` custom
 *     events dispatched by `RealtimeDigestSendsLayer` whenever a
 *     newly-inserted digest send carries `status === 'suppressed'`.
 *     On every event the callout re-fetches so a fresh bounce shows
 *     up in seconds.
 */

interface SuppressionItem {
  user_id: string
  role: 'owner' | 'admin'
  email_masked: string | null
  reason: 'bounce' | 'complaint' | 'manual' | 'unknown'
  created_at: string | null
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; items: SuppressionItem[] }

interface RowRemovalState {
  removing: boolean
  error: string | null
}

const REFRESH_EVENT = 'venuerise:digest-suppression-refresh'

const CONFIRM_COPY =
  'Remove this admin email from the suppression list? Future digest emails may be sent to this address again.'

const CONFIRM_BULK_COPY =
  'Remove all suppressed admin emails for this venue? Future digest emails may be sent to these addresses again.'

const BULK_ACTION_THRESHOLD = 3

function reasonLabel(r: SuppressionItem['reason']): string {
  switch (r) {
    case 'bounce':    return 'hard bounce'
    case 'complaint': return 'spam complaint'
    case 'manual':    return 'manually suppressed'
    case 'unknown':   return 'suppressed'
  }
}

export default function DigestSuppressionsCallout() {
  const [state, setState] = useState<FetchState>({ kind: 'loading' })
  // Phase 8AA — per-row removal state. Keyed by user_id so two
  // concurrent removals don't stomp each other's feedback. Cleared on
  // refetch.
  const [rowState, setRowState] = useState<Record<string, RowRemovalState>>({})
  // Phase 8AB — bulk-remove state. Distinct from per-row state so a
  // pending bulk doesn't block individual row interactions. Surfaces
  // a callout-level red message on failure.
  const [bulkState, setBulkState] = useState<{ removing: boolean; error: string | null }>({
    removing: false,
    error: null,
  })

  // Phase 8AA — exposed as a useCallback so the event-listener effect
  // can register a stable reference and we can re-trigger after a
  // successful removal without duplicating the fetch logic.
  const fetchSuppressions = useCallback(async (signal?: AbortSignal) => {
    setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
    try {
      const res = await fetch('/api/admin/digest/suppressions', {
        method: 'GET',
        signal,
        credentials: 'same-origin',
      })
      if (!res.ok) {
        setState({ kind: 'error' })
        return
      }
      const body = (await res.json()) as { items?: SuppressionItem[] }
      setState({
        kind: 'ready',
        items: Array.isArray(body.items) ? body.items : [],
      })
      // Reset row state on any successful refetch — old per-row
      // errors don't apply to the new list.
      setRowState({})
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setState({ kind: 'error' })
    }
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    fetchSuppressions(abort.signal)
    return () => abort.abort()
  }, [fetchSuppressions])

  // Phase 8AA — listen for cross-component refresh events emitted by
  // the realtime layer when a fresh outbound row arrives with
  // `status === 'suppressed'`. Avoids a global store; a CustomEvent is
  // enough for one consumer.
  useEffect(() => {
    const handler = () => {
      fetchSuppressions()
    }
    window.addEventListener(REFRESH_EVENT, handler)
    return () => window.removeEventListener(REFRESH_EVENT, handler)
  }, [fetchSuppressions])

  async function handleRemove(item: SuppressionItem) {
    if (typeof window === 'undefined') return
    if (!window.confirm(CONFIRM_COPY)) return

    setRowState((prev) => ({
      ...prev,
      [item.user_id]: { removing: true, error: null },
    }))

    try {
      const res = await fetch('/api/admin/digest/suppressions/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: item.user_id }),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as
          | { error?: unknown }
          | null
        const code =
          errBody && typeof errBody.error === 'string'
            ? errBody.error
            : `HTTP ${res.status}`
        setRowState((prev) => ({
          ...prev,
          [item.user_id]: { removing: false, error: code },
        }))
        return
      }
      const body = (await res.json().catch(() => null)) as
        | { success?: boolean; removed?: boolean; reason?: string }
        | null
      if (body && body.success === true && body.removed === false) {
        // The suppression was already gone (someone else removed it,
        // or a race with a Resend webhook removal). Treat as success
        // — refetch to clear the row from the list.
        await fetchSuppressions()
        return
      }
      // Success path — refetch so the list shrinks. If it becomes
      // empty the callout auto-hides on next render.
      await fetchSuppressions()
    } catch (err) {
      setRowState((prev) => ({
        ...prev,
        [item.user_id]: {
          removing: false,
          error: err instanceof Error ? err.message : 'Network error',
        },
      }))
    }
  }

  async function handleRemoveAll() {
    if (typeof window === 'undefined') return
    if (!window.confirm(CONFIRM_BULK_COPY)) return
    setBulkState({ removing: true, error: null })
    try {
      const res = await fetch('/api/admin/digest/suppressions/remove-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as
          | { error?: unknown }
          | null
        const code =
          errBody && typeof errBody.error === 'string'
            ? errBody.error
            : `HTTP ${res.status}`
        setBulkState({ removing: false, error: code })
        return
      }
      // Server returns `{ success: true, removed_count, details }`.
      // We don't surface the per-member breakdown inline — the
      // refetch below either clears the callout entirely or shows
      // whichever members are still stuck (no email, etc).
      setBulkState({ removing: false, error: null })
      await fetchSuppressions()
    } catch (err) {
      setBulkState({
        removing: false,
        error: err instanceof Error ? err.message : 'Network error',
      })
    }
  }

  if (state.kind !== 'ready') return null
  if (state.items.length === 0) return null

  const count = state.items.length
  const headline =
    count === 1
      ? '1 admin email is currently suppressed. Manual and cron digests to this address may fail.'
      : `${count} admin emails are currently suppressed. Manual and cron digests to these addresses may fail.`

  return (
    <div className="rounded-2xl border border-[#FDE68A] bg-[#FFFBEB] p-4 flex items-start gap-3">
      <AlertTriangle className="w-4 h-4 text-[#B45309] mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <p className="text-[13px] font-medium text-[#92400E]">{headline}</p>
          {/* Phase 8AB — bulk action surfaces only when there are
              enough suppressions to make individual clicks tedious.
              Threshold of 3 mirrors the prompt; tweakable via the
              BULK_ACTION_THRESHOLD const if the volume distribution
              changes. */}
          {count >= BULK_ACTION_THRESHOLD && (
            <button
              type="button"
              onClick={handleRemoveAll}
              disabled={bulkState.removing}
              className="shrink-0 inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#92400E] bg-white border border-[#FDE68A] hover:border-[#F59E0B] hover:bg-[#FEF3C7] px-2.5 py-1 rounded-lg disabled:opacity-60"
            >
              {bulkState.removing ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Removing all…
                </>
              ) : (
                'Remove all suppressions'
              )}
            </button>
          )}
        </div>
        {bulkState.error && (
          <p className="mt-1 text-[11px] text-[#B91C1C]">
            Couldn&apos;t remove all: {bulkState.error}
          </p>
        )}
        <ul className="mt-2 space-y-1.5">
          {state.items.map((item) => {
            const row = rowState[item.user_id]
            const removing = row?.removing ?? false
            return (
              <li
                key={item.user_id}
                className="text-[12px] text-[#78350F] flex items-center gap-2 flex-wrap"
              >
                <span className="font-medium text-[#92400E]">
                  {item.email_masked ?? `${item.role} · ${item.user_id.slice(0, 8)}`}
                </span>
                <span className="text-[#B45309]">·</span>
                <span>{reasonLabel(item.reason)}</span>
                {item.created_at ? (
                  <>
                    <span className="text-[#B45309]">·</span>
                    <span className="text-[#A16207]">
                      {new Date(item.created_at).toLocaleDateString()}
                    </span>
                  </>
                ) : null}
                {/* Phase 8AA — inline removal action. Confirm dialog
                    on click; server re-resolves the email so the
                    client can't influence the address. Per-row state
                    so two concurrent removals on a multi-suppression
                    venue don't stomp each other. */}
                <button
                  type="button"
                  onClick={() => handleRemove(item)}
                  disabled={removing}
                  className="ml-1 inline-flex items-center gap-1 text-[11px] text-[#B45309] hover:text-[#92400E] underline decoration-dotted hover:decoration-solid disabled:opacity-60 disabled:no-underline"
                  title="Remove this email from the suppression list"
                >
                  {removing ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Removing…
                    </>
                  ) : (
                    'Remove suppression'
                  )}
                </button>
                {row?.error ? (
                  <span className="block w-full mt-0.5 text-[11px] text-[#B91C1C]">
                    Couldn&apos;t remove: {row.error}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
        <p className="mt-2 text-[11px] text-[#A16207]">
          Resolve from your Resend dashboard or remove the suppression here. The
          send surfaces will continue to return <code>409 suppressed</code> for
          these recipients until the entry is removed.
        </p>
      </div>
    </div>
  )
}
