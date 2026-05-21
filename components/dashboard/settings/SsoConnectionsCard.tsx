'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Loader2,
  AlertTriangle,
  KeyRound,
  Plus,
  Power,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { Badge } from '@/components/dashboard/ui/Badge'

/**
 * Phase 9G — SsoConnectionsCard (admin-only).
 *
 * Lists SSO connections for the venue + lets an owner create a
 * draft connection. No secrets / certs are surfaced in this UI —
 * those live in the vendor dashboard (WorkOS / Clerk / etc.) and
 * are referenced via `metadata` once a real adapter ships.
 *
 * Owner-only POST is enforced server-side (route + RLS). The card
 * doesn't currently distinguish owner from admin in the UI gate
 * — admins see the list but get a clean error message if they
 * attempt to create. Future polish can hide the form for admins;
 * not in scope for 9G.
 *
 * Empty state intentionally simple: "SSO is not configured yet."
 * No marketing copy, no SAML pitch.
 */

interface SsoConnection {
  id: string
  venue_id: string
  provider: string
  protocol: string
  domain: string
  status: string
  default_role: string
  jit_provisioning_enabled: boolean
  scim_enabled: boolean
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: SsoConnection[] }

type FormState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }

const PROVIDERS = [
  'workos',
  'clerk',
  'stytch',
  'supabase_sso',
  'custom_oidc',
] as const

const PROTOCOLS = ['saml', 'oidc'] as const

function statusBadgeVariant(
  status: string
): 'navy' | 'blue' | 'default' {
  if (status === 'active') return 'blue'
  if (status === 'pending') return 'navy'
  return 'default'
}

export default function SsoConnectionsCard() {
  const [state, setState] = useState<ListState>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  const [formOpen, setFormOpen] = useState(false)
  const [formDomain, setFormDomain] = useState('')
  const [formProvider, setFormProvider] = useState<(typeof PROVIDERS)[number]>('workos')
  const [formProtocol, setFormProtocol] = useState<(typeof PROTOCOLS)[number]>('saml')
  const [formState, setFormState] = useState<FormState>({ kind: 'idle' })

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch('/api/admin/security/sso-connections', {
          method: 'GET',
          signal: abort.signal,
          credentials: 'same-origin',
        })
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
        const body = (await res.json()) as { items?: SsoConnection[] }
        setState({
          kind: 'ready',
          items: Array.isArray(body.items) ? body.items : [],
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

  const handleCreate = useCallback(async () => {
    if (!formDomain.trim()) {
      setFormState({ kind: 'error', message: 'Domain is required' })
      return
    }
    setFormState({ kind: 'submitting' })
    try {
      const res = await fetch('/api/admin/security/sso-connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          domain: formDomain.trim(),
          provider: formProvider,
          protocol: formProtocol,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: unknown; detail?: unknown }
          | null
        const code =
          body && typeof body.error === 'string'
            ? body.error
            : `HTTP ${res.status}`
        const detail =
          body && typeof body.detail === 'string' ? ` — ${body.detail}` : ''
        setFormState({ kind: 'error', message: `${code}${detail}` })
        return
      }
      setFormState({ kind: 'idle' })
      setFormOpen(false)
      setFormDomain('')
      setReloadTick((n) => n + 1)
    } catch (err) {
      setFormState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }, [formDomain, formProvider, formProtocol])

  const handleDisable = useCallback(
    async (connectionId: string) => {
      try {
        const res = await fetch(
          `/api/admin/security/sso-connections/${connectionId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ status: 'disabled' }),
          }
        )
        if (!res.ok) {
          // Silent fail with a one-shot reload so the operator
          // can see whatever the server set. A future polish can
          // surface the error inline.
          setReloadTick((n) => n + 1)
          return
        }
        setReloadTick((n) => n + 1)
      } catch {
        setReloadTick((n) => n + 1)
      }
    },
    []
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
              <CardTitle>Enterprise SSO</CardTitle>
              <CardSubtitle>
                Configure SAML / OIDC connections per email domain. SSO is
                in readiness mode (Phase 9G) — connections persist but the
                vendor adapter isn&apos;t wired yet.
              </CardSubtitle>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setFormOpen((v) => !v)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Plus className="h-3.5 w-3.5" />
            New draft
          </button>
        </div>
      </CardHeader>
      <CardContent>
        {formOpen && (
          <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <input
                type="text"
                value={formDomain}
                onChange={(e) => setFormDomain(e.target.value)}
                placeholder="domain (e.g. acme.com)"
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
              />
              <select
                value={formProvider}
                onChange={(e) =>
                  setFormProvider(e.target.value as (typeof PROVIDERS)[number])
                }
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900"
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <select
                value={formProtocol}
                onChange={(e) =>
                  setFormProtocol(e.target.value as (typeof PROTOCOLS)[number])
                }
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900"
              >
                {PROTOCOLS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={handleCreate}
                disabled={formState.kind === 'submitting'}
                className="inline-flex h-8 items-center gap-2 rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {formState.kind === 'submitting' && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                Create draft
              </button>
              <button
                type="button"
                onClick={() => {
                  setFormOpen(false)
                  setFormState({ kind: 'idle' })
                }}
                className="text-xs text-slate-600 hover:text-slate-900"
              >
                Cancel
              </button>
              {formState.kind === 'error' && (
                <span className="text-xs text-amber-700">
                  {formState.message}
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Owner-only. Drafts persist but never open an auth path —
              flip the status to <code className="font-mono">active</code>{' '}
              when the vendor handshake is complete.
            </p>
          </div>
        )}

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
              <div className="font-medium">Could not load SSO connections</div>
              <div className="text-xs">{state.message}</div>
            </div>
          </div>
        )}

        {state.kind === 'ready' && state.items.length === 0 && (
          <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
            SSO is not configured yet.
          </div>
        )}

        {state.kind === 'ready' && state.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-3">Domain</th>
                  <th className="py-2 pr-3">Provider</th>
                  <th className="py-2 pr-3">Protocol</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Default role</th>
                  <th className="py-2 pr-3">JIT</th>
                  <th className="py-2 pr-3">SCIM</th>
                  <th className="py-2 pr-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
                  >
                    <td className="py-2 pr-3">
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800">
                        {item.domain}
                      </code>
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-700">
                      {item.provider}
                    </td>
                    <td className="py-2 pr-3 text-xs uppercase text-slate-700">
                      {item.protocol}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={statusBadgeVariant(item.status)}>
                        {item.status}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-700">
                      {item.default_role}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-700">
                      {item.jit_provisioning_enabled ? 'on' : 'off'}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-700">
                      {item.scim_enabled ? 'on' : 'off'}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {item.status !== 'disabled' && (
                        <button
                          type="button"
                          onClick={() => handleDisable(item.id)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          title="Disable this connection"
                        >
                          <Power className="h-3 w-3" />
                          Disable
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-xs text-slate-500">
          No secrets or certificates are stored on this surface. Vendor
          credentials live in the vendor dashboard; only the connection
          shape (domain / provider / protocol / status / role policy)
          lives in VenueRise.
        </p>
      </CardContent>
    </Card>
  )
}
