'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Loader2,
  AlertTriangle,
  FileText,
  Download,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'

/**
 * Phase 9I — SecurityEvidenceCenter (admin-only, read-only).
 *
 * Single card that consolidates the existing security controls
 * into a one-glance posture view. Pulls from
 * `/api/admin/security/evidence-report` (JSON branch for render,
 * markdown/CSV branches for download).
 *
 * Honest by construction: every control's status is sourced from
 * the static `EVIDENCE_CONTROLS` map. Adding a control without
 * the matching implementation is caught by code review +
 * scripts/check-evidence-packaging.mjs.
 */

type ControlStatus =
  | 'implemented'
  | 'partial'
  | 'manual'
  | 'unknown'
  | 'not_applicable'

interface Artifact {
  kind: string
  reference: string
  label?: string
}

interface Control {
  id: string
  title: string
  category: string
  soc2Categories: string[]
  status: ControlStatus
  description: string
  artifacts: Artifact[]
  limitations: string[]
  recommendedNext: string[]
}

interface Summary {
  total: number
  implemented: number
  partial: number
  manual: number
  unknown: number
  notApplicable: number
}

interface Report {
  generatedAt: string
  disclaimer: string
  summary: Summary
  controls: Control[]
  backupPosture?: {
    status: string
    rtoHours: number
    rpoHours: number
    retentionDays: number
    dryRunCadence: string
    lastCheckedAt: string
  }
  warnings: string[]
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; report: Report }

function statusChipClass(status: ControlStatus): string {
  if (status === 'implemented') {
    return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  }
  if (status === 'partial') {
    return 'bg-amber-50 text-amber-700 border-amber-200'
  }
  if (status === 'manual') {
    return 'bg-blue-50 text-blue-700 border-blue-200'
  }
  if (status === 'unknown') {
    return 'bg-slate-50 text-slate-600 border-slate-200'
  }
  return 'bg-slate-50 text-slate-500 border-slate-200'
}

const CATEGORY_ORDER: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'access_control', label: 'Access control' },
  { key: 'audit_logging', label: 'Audit logging' },
  { key: 'security_operations', label: 'Security operations' },
  { key: 'monitoring', label: 'Monitoring' },
  { key: 'availability', label: 'Availability & DR' },
  { key: 'incident_response', label: 'Incident response' },
  { key: 'data_lifecycle', label: 'Data lifecycle' },
  { key: 'change_management', label: 'Change management' },
  { key: 'vendor_management', label: 'Vendor management' },
  { key: 'confidentiality', label: 'Confidentiality' },
]

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

export default function SecurityEvidenceCenter() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch(
          '/api/admin/security/evidence-report?format=json',
          { method: 'GET', signal: abort.signal, credentials: 'same-origin' }
        )
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
        const body = (await res.json()) as { report?: Report }
        if (!body.report) {
          setState({ kind: 'error', message: 'empty_response' })
          return
        }
        setState({ kind: 'ready', report: body.report })
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

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Security evidence center</CardTitle>
              <CardSubtitle>
                Consolidated view of existing audit, RBAC, abuse, SSO,
                backup, and data lifecycle controls. Not a SOC 2
                attestation; formal certification requires an auditor.
              </CardSubtitle>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              aria-label="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
            <a
              href="/api/admin/security/evidence-report?format=markdown"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <FileText className="h-3.5 w-3.5" />
              Markdown
            </a>
            <a
              href="/api/admin/security/evidence-report?format=csv"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <Download className="h-3.5 w-3.5" />
              CSV
            </a>
          </div>
        </div>
      </CardHeader>
      <CardContent>
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
              <div className="font-medium">Could not load evidence report</div>
              <div className="text-xs">{state.message}</div>
            </div>
          </div>
        )}

        {state.kind === 'ready' && (
          <>
            {/* Summary chips */}
            <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <SummaryCell
                label="Total"
                value={state.report.summary.total}
                tone="slate"
              />
              <SummaryCell
                label="Implemented"
                value={state.report.summary.implemented}
                tone="emerald"
              />
              <SummaryCell
                label="Partial"
                value={state.report.summary.partial}
                tone="amber"
              />
              <SummaryCell
                label="Manual"
                value={state.report.summary.manual}
                tone="blue"
              />
              <SummaryCell
                label="Unknown"
                value={state.report.summary.unknown}
                tone="slate"
              />
            </dl>

            {/* Warnings */}
            {state.report.warnings.length > 0 && (
              <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <div className="mb-1 font-medium">Report warnings</div>
                <ul className="list-disc pl-5">
                  {state.report.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Grouped controls */}
            {CATEGORY_ORDER.map((cat) => {
              const items = state.report.controls.filter(
                (c) => c.category === cat.key
              )
              if (items.length === 0) return null
              return (
                <section key={cat.key} className="mb-5">
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                    {cat.label}
                  </h3>
                  <ul className="space-y-2">
                    {items.map((c) => (
                      <li
                        key={c.id}
                        className="rounded-md border border-slate-200 bg-white p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-slate-900">
                              {c.title}
                            </div>
                            <div className="mt-0.5 text-xs text-slate-600">
                              {c.description}
                            </div>
                          </div>
                          <span
                            className={`flex-shrink-0 inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${statusChipClass(c.status)}`}
                          >
                            {c.status}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                          <span>
                            Refs: <strong>{c.artifacts.length}</strong>
                          </span>
                          {c.limitations.length > 0 && (
                            <span>
                              Limitations:{' '}
                              <strong>{c.limitations.length}</strong>
                            </span>
                          )}
                          {c.recommendedNext.length > 0 && (
                            <span>
                              Next: <strong>{c.recommendedNext.length}</strong>
                            </span>
                          )}
                          <span className="text-slate-400">
                            SOC 2: {c.soc2Categories.join(', ')}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}

            <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              {state.report.disclaimer}
            </div>
            <div className="mt-2 text-[11px] text-slate-400">
              Generated {formatTime(state.report.generatedAt)}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function SummaryCell({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'slate' | 'emerald' | 'amber' | 'blue'
}) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : tone === 'blue'
          ? 'text-blue-700'
          : 'text-slate-700'
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className={`mt-0.5 font-mono text-lg ${toneClass}`}>{value}</dd>
    </div>
  )
}
