'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
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
 * Phase 9N — TrustCenterCard (admin/owner only).
 *
 * Shows the public Trust Center URL, a packet preview button,
 * and download links for the standard + full packets. The
 * admin uses this to (a) verify the public page is rendering
 * what they expect and (b) export a markdown packet for
 * out-of-band sharing.
 */

interface PacketArtifact {
  type: string
  title: string
  visibility: string
  includedInScope: boolean
  scopeNote: string
}

interface PacketSummary {
  generatedAt: string
  disclaimer: string
  scope: string
  artifacts: PacketArtifact[]
  counts: {
    total: number
    included: number
    publicOnly: number
    gatedOnly: number
  }
  warnings: string[]
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; packet: PacketSummary }

export default function TrustCenterCard() {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [scope, setScope] = useState<
    'summary_only' | 'standard_packet' | 'full_packet'
  >('standard_packet')
  const [reloadTick, setReloadTick] = useState(0)

  const handlePreview = useCallback(() => {
    setReloadTick((n) => n + 1)
  }, [])

  useEffect(() => {
    if (reloadTick === 0) return
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch(
          `/api/admin/security/trust-center/packet?scope=${scope}&format=json`,
          { method: 'GET', signal: abort.signal, credentials: 'same-origin' }
        )
        if (!res.ok) {
          setState({ kind: 'error', message: `HTTP ${res.status}` })
          return
        }
        const body = (await res.json()) as { packet?: PacketSummary }
        if (!body.packet) {
          setState({ kind: 'error', message: 'empty_response' })
          return
        }
        setState({ kind: 'ready', packet: body.packet })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        })
      }
    })()
    return () => abort.abort()
  }, [reloadTick, scope])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <Globe className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Trust Center</CardTitle>
              <CardSubtitle>
                Public security/privacy posture + gated buyer packets.
                Trust materials are NOT a SOC&nbsp;2 certification — review
                with counsel before claiming contractual posture.
              </CardSubtitle>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/trust"
              target="_blank"
              rel="noopener"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              View public page
            </a>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex items-center gap-2">
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
          <button
            type="button"
            onClick={handlePreview}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Preview manifest
          </button>
          <a
            href={`/api/admin/security/trust-center/packet?scope=${scope}&format=markdown`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
            download
          >
            <FileText className="h-3.5 w-3.5" />
            Download Markdown
          </a>
        </div>

        {state.kind === 'loading' && (
          <div className="flex items-center justify-center py-6 text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}
        {state.kind === 'error' && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>Could not load packet: {state.message}</div>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <dl className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Total" value={state.packet.counts.total} />
              <Stat
                label="Included"
                value={state.packet.counts.included}
                tone="emerald"
              />
              <Stat label="Public" value={state.packet.counts.publicOnly} />
              <Stat label="Gated" value={state.packet.counts.gatedOnly} />
            </dl>
            <ul className="space-y-2">
              {state.packet.artifacts.map((a) => (
                <li
                  key={a.type}
                  className="rounded-md border border-slate-200 bg-white p-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-900">
                      {a.title}
                    </span>
                    <div className="flex items-center gap-1">
                      {chip(a.visibility, visibilityClass(a.visibility))}
                      {a.includedInScope
                        ? chip(
                            'included',
                            'bg-emerald-50 text-emerald-700 border-emerald-200'
                          )
                        : chip(
                            'excluded',
                            'bg-slate-50 text-slate-500 border-slate-200'
                          )}
                    </div>
                  </div>
                  <div className="mt-1 text-slate-500">{a.scopeNote}</div>
                </li>
              ))}
            </ul>
            <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              {state.packet.disclaimer}
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
  tone?: 'slate' | 'emerald'
}) {
  const toneClass =
    tone === 'emerald' ? 'text-emerald-700' : 'text-slate-700'
  return (
    <div className="rounded-md border border-slate-200 bg-white p-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className={`mt-0.5 font-mono text-base ${toneClass}`}>{value}</dd>
    </div>
  )
}

function chip(text: string, classes: string) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${classes}`}
    >
      {text}
    </span>
  )
}

function visibilityClass(v: string): string {
  if (v === 'public')
    return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (v === 'gated')
    return 'bg-amber-50 text-amber-700 border-amber-200'
  return 'bg-slate-50 text-slate-500 border-slate-200'
}
