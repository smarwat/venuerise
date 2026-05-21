'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'

/**
 * Phase 9N — TrustAccessGrantsCard (admin/owner only).
 *
 * Lists active / expired / revoked grants. New-grant form
 * returns the bearer URL ONCE — the operator copies + sends
 * it. Revoke button stops further access.
 */

interface Grant {
  id: string
  venueId: string | null
  buyerName: string | null
  buyerEmail: string | null
  buyerCompany: string | null
  scope: string
  status: string
  expiresAt: string
  lastAccessedAt: string | null
  accessCount: number
  createdAt: string
}

interface ListSummary {
  generatedAt: string
  counts: {
    total: number
    active: number
    expired: number
    revoked: number
    accessedLast30d: number
  }
  grants: Grant[]
  warnings: string[]
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; summary: ListSummary }

interface CreatedGrant {
  grantId: string
  token: string
  url: string | null
  expiresAt: string
  warning: string
}

export default function TrustAccessGrantsCard() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  const [showNew, setShowNew] = useState(false)
  const [created, setCreated] = useState<CreatedGrant | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch(
          '/api/admin/security/trust-center/grants?limit=25',
          { method: 'GET', signal: abort.signal, credentials: 'same-origin' }
        )
        if (!res.ok) {
          setState({ kind: 'error', message: `HTTP ${res.status}` })
          return
        }
        const body = (await res.json()) as { summary?: ListSummary }
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

  const handleRevoke = useCallback(
    async (grantId: string) => {
      // UI_INTERACTION_EXEMPT: admin-only trust-access grant revocation — native confirm is intentional friction.
      const ok = window.confirm('Revoke this grant? It cannot be undone.')
      if (!ok) return
      try {
        const res = await fetch(
          `/api/admin/security/trust-center/grants/${grantId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ revoke: true }),
          }
        )
        if (!res.ok) {
          window.alert(`Revoke failed: HTTP ${res.status}`)
          return
        }
        handleRefresh()
      } catch (err) {
        window.alert(
          'Revoke failed: ' +
            (err instanceof Error ? err.message : 'Network error')
        )
      }
    },
    [handleRefresh]
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <KeyRound className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Trust access grants</CardTitle>
              <CardSubtitle>
                Bearer-token grants for buyer access to security packets.
                Grant URLs are bearer credentials — share only with intended
                recipients and revoke when no longer needed.
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
            <button
              type="button"
              onClick={() => {
                setShowNew((v) => !v)
                setCreated(null)
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800"
            >
              <Plus className="h-3.5 w-3.5" />
              New grant
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {created && (
          <CreatedGrantPanel
            grant={created}
            onDismiss={() => {
              setCreated(null)
              handleRefresh()
            }}
          />
        )}

        {showNew && !created && (
          <NewGrantForm
            onCreated={(g) => {
              setCreated(g)
              setShowNew(false)
            }}
          />
        )}

        {state.kind === 'loading' && (
          <div className="flex items-center justify-center py-6 text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}
        {state.kind === 'error' && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>Could not load grants: {state.message}</div>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <dl className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Total" value={state.summary.counts.total} />
              <Stat
                label="Active"
                value={state.summary.counts.active}
                tone="emerald"
              />
              <Stat
                label="Expired"
                value={state.summary.counts.expired}
                tone="amber"
              />
              <Stat
                label="Revoked"
                value={state.summary.counts.revoked}
                tone="amber"
              />
              <Stat
                label="Accessed 30d"
                value={state.summary.counts.accessedLast30d}
              />
            </dl>

            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="border-b border-slate-200 py-2 pr-3">Buyer</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Scope</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Status</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Expires</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Accesses</th>
                    <th className="border-b border-slate-200 py-2 pr-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {state.summary.grants.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="border-b border-slate-100 py-6 text-center text-xs text-slate-500"
                      >
                        No grants yet. Create one to share a security packet
                        with a buyer.
                      </td>
                    </tr>
                  )}
                  {state.summary.grants.map((g) => (
                    <tr key={g.id}>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top">
                        <div className="text-xs text-slate-700">
                          {g.buyerEmail ?? '(no email)'}
                        </div>
                        {g.buyerCompany && (
                          <div className="text-[11px] text-slate-500">
                            {g.buyerCompany}
                          </div>
                        )}
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs text-slate-600">
                        {g.scope}
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top">
                        <StatusChip status={g.status} />
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs text-slate-500">
                        {new Date(g.expiresAt).toLocaleDateString()}
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs text-slate-600">
                        {g.accessCount}
                      </td>
                      <td className="border-b border-slate-100 py-2 pr-3 align-top">
                        {g.status === 'active' && (
                          <button
                            type="button"
                            onClick={() => handleRevoke(g.id)}
                            className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              Grant URLs are bearer links. Anyone with the URL can access the
              packet until expiry or revocation. Share only with intended
              recipients.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({
  label,
  value,
  tone = 'slate',
}: {
  label: string
  value: number
  tone?: 'slate' | 'emerald' | 'amber'
}) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : 'text-slate-700'
  return (
    <div className="rounded-md border border-slate-200 bg-white p-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className={`mt-0.5 font-mono text-base ${toneClass}`}>{value}</dd>
    </div>
  )
}

function StatusChip({ status }: { status: string }) {
  const classes =
    status === 'active'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : status === 'revoked'
        ? 'bg-red-50 text-red-700 border-red-200'
        : 'bg-slate-50 text-slate-500 border-slate-200'
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${classes}`}
    >
      {status}
    </span>
  )
}

function CreatedGrantPanel({
  grant,
  onDismiss,
}: {
  grant: CreatedGrant
  onDismiss: () => void
}) {
  const url = grant.url ?? `Token: ${grant.token}`
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      window.prompt('Copy this URL:', url)
    }
  }, [url])
  return (
    <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-medium text-emerald-900">
          Grant created — save this URL now
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-emerald-700 underline"
        >
          Dismiss
        </button>
      </div>
      <p className="mt-2 text-xs text-emerald-900">{grant.warning}</p>
      <div className="mt-2 break-all rounded-md border border-emerald-200 bg-white p-2 font-mono text-xs text-slate-700">
        {url}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-200 bg-white px-2 text-xs text-emerald-800 hover:bg-emerald-100"
        >
          <Copy className="h-3.5 w-3.5" />
          Copy URL
        </button>
        <span className="text-xs text-emerald-700">
          Expires {new Date(grant.expiresAt).toLocaleString()}
        </span>
      </div>
    </div>
  )
}

function NewGrantForm({
  onCreated,
}: {
  onCreated: (g: CreatedGrant) => void
}) {
  const [buyerName, setBuyerName] = useState('')
  const [buyerEmail, setBuyerEmail] = useState('')
  const [buyerCompany, setBuyerCompany] = useState('')
  const [scope, setScope] = useState<
    'summary_only' | 'standard_packet' | 'full_packet'
  >('standard_packet')
  const [expiresInDays, setExpiresInDays] = useState(14)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/security/trust-center/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          buyer_name: buyerName || null,
          buyer_email: buyerEmail || null,
          buyer_company: buyerCompany || null,
          scope,
          expires_in_days: expiresInDays,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: unknown }
          | null
        setError(
          body && typeof body.error === 'string'
            ? body.error
            : `HTTP ${res.status}`
        )
        return
      }
      const body = (await res.json()) as {
        grantId: string
        token: string
        url: string | null
        expiresAt: string
        warning: string
      }
      onCreated({
        grantId: body.grantId,
        token: body.token,
        url: body.url,
        expiresAt: body.expiresAt,
        warning: body.warning,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }, [buyerName, buyerEmail, buyerCompany, scope, expiresInDays, onCreated])

  return (
    <div className="mb-4 rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-2 text-sm font-medium text-slate-900">New grant</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          type="text"
          placeholder="Buyer name"
          value={buyerName}
          onChange={(e) => setBuyerName(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
        <input
          type="email"
          placeholder="Buyer email"
          value={buyerEmail}
          onChange={(e) => setBuyerEmail(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
        <input
          type="text"
          placeholder="Buyer company"
          value={buyerCompany}
          onChange={(e) => setBuyerCompany(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
        <select
          value={scope}
          onChange={(e) =>
            setScope(
              e.target.value as
                | 'summary_only'
                | 'standard_packet'
                | 'full_packet'
            )
          }
          className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
        >
          <option value="summary_only">summary_only</option>
          <option value="standard_packet">standard_packet</option>
          <option value="full_packet">full_packet</option>
        </select>
        <input
          type="number"
          min={1}
          max={90}
          value={expiresInDays}
          onChange={(e) =>
            setExpiresInDays(Math.max(1, Math.min(90, Number(e.target.value))))
          }
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-slate-500">
          Default 14-day expiry. Max 90 days. Token is shown once.
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="inline-flex h-8 items-center rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Create grant
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-red-700">{error}</div>}
    </div>
  )
}
