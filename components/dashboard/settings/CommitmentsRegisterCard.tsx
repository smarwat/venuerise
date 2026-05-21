'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FileSignature,
  Loader2,
  Plus,
  RefreshCw,
  Sheet,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'

/**
 * Phase 9P — CommitmentsRegisterCard (admin/owner only).
 *
 * Lists every operator-recorded commitment. New-commitment
 * form + filter chips + per-row expansion with timeline +
 * status / risk / fulfilment / review controls.
 */

type SourceType =
  | 'msa'
  | 'dpa'
  | 'security_addendum'
  | 'order_form'
  | 'trust_grant'
  | 'email'
  | 'other'
type Area =
  | 'security'
  | 'privacy'
  | 'availability'
  | 'support'
  | 'data_retention'
  | 'subprocessor'
  | 'sso'
  | 'scim'
  | 'incident_response'
  | 'backup_dr'
  | 'ai_use'
  | 'data_residency'
  | 'other'
type Status =
  | 'draft'
  | 'active'
  | 'fulfilled'
  | 'at_risk'
  | 'expired'
  | 'withdrawn'
type Risk = 'low' | 'medium' | 'high' | 'critical'

interface Commitment {
  id: string
  venueId: string | null
  buyerName: string | null
  buyerCompany: string | null
  buyerEmail: string | null
  sourceType: SourceType
  commitmentArea: Area
  title: string
  description: string
  status: Status
  riskLevel: Risk
  dueAt: string | null
  reviewAt: string | null
  fulfilledAt: string | null
  evidenceUrl: string | null
  internalNotes: string | null
  createdAt: string
}

interface ListSummary {
  generatedAt: string
  counts: {
    total: number
    draft: number
    active: number
    fulfilled: number
    atRisk: number
    expired: number
    withdrawn: number
    highRisk: number
    criticalRisk: number
    overdueReview: number
    dueWithin30Days: number
    unsupportedRiskFlags: number
  }
  commitments: Commitment[]
  warnings: string[]
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; summary: ListSummary }

const SOURCE_TYPES: ReadonlyArray<SourceType> = [
  'msa',
  'dpa',
  'security_addendum',
  'order_form',
  'trust_grant',
  'email',
  'other',
]
const AREAS: ReadonlyArray<Area> = [
  'security',
  'privacy',
  'availability',
  'support',
  'data_retention',
  'subprocessor',
  'sso',
  'scim',
  'incident_response',
  'backup_dr',
  'ai_use',
  'data_residency',
  'other',
]
const STATUSES: ReadonlyArray<Status> = [
  'draft',
  'active',
  'fulfilled',
  'at_risk',
  'expired',
  'withdrawn',
]
const RISKS: ReadonlyArray<Risk> = ['low', 'medium', 'high', 'critical']

export default function CommitmentsRegisterCard() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  const [showNew, setShowNew] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<Status | null>(null)
  const [filterRisk, setFilterRisk] = useState<Risk | null>(null)
  const [filterArea, setFilterArea] = useState<Area | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const url = new URL(
          '/api/admin/security/commitments',
          window.location.origin
        )
        url.searchParams.set('limit', '200')
        if (filterStatus) url.searchParams.set('status', filterStatus)
        if (filterRisk) url.searchParams.set('risk_level', filterRisk)
        if (filterArea) url.searchParams.set('commitment_area', filterArea)
        const res = await fetch(url.toString(), {
          signal: abort.signal,
          credentials: 'same-origin',
        })
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
  }, [reloadTick, filterStatus, filterRisk, filterArea])

  const handleRefresh = useCallback(() => setReloadTick((n) => n + 1), [])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <FileSignature className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Contract commitments register</CardTitle>
              <CardSubtitle>
                Operator-recorded customer-specific commitments. NOT
                legal advice and NOT contractual compliance proof —
                the platform does not autonomously parse contracts.
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
              onClick={() => setShowNew((v) => !v)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800"
            >
              <Plus className="h-3.5 w-3.5" />
              New commitment
            </button>
            <a
              href="/api/admin/security/commitments?format=csv"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <Sheet className="h-3.5 w-3.5" />
              Download CSV
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
            <div>Could not load commitments: {state.message}</div>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Total" value={state.summary.counts.total} />
              <Stat label="Active" value={state.summary.counts.active} tone="slate" />
              <Stat label="High+critical" value={state.summary.counts.highRisk + state.summary.counts.criticalRisk} tone="amber" />
              <Stat
                label="Overdue review"
                value={state.summary.counts.overdueReview}
                tone={state.summary.counts.overdueReview > 0 ? 'red' : 'slate'}
              />
              <Stat
                label="Due 30d"
                value={state.summary.counts.dueWithin30Days}
                tone="amber"
              />
            </dl>

            {/* Filter chips */}
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <select
                value={filterStatus ?? ''}
                onChange={(e) =>
                  setFilterStatus((e.target.value as Status) || null)
                }
                className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
              >
                <option value="">all statuses</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <select
                value={filterRisk ?? ''}
                onChange={(e) => setFilterRisk((e.target.value as Risk) || null)}
                className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
              >
                <option value="">all risks</option>
                {RISKS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <select
                value={filterArea ?? ''}
                onChange={(e) => setFilterArea((e.target.value as Area) || null)}
                className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
              >
                <option value="">all areas</option>
                {AREAS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              {(filterStatus || filterRisk || filterArea) && (
                <button
                  type="button"
                  onClick={() => {
                    setFilterStatus(null)
                    setFilterRisk(null)
                    setFilterArea(null)
                  }}
                  className="text-xs text-slate-500 underline"
                >
                  clear filters
                </button>
              )}
            </div>

            {showNew && (
              <NewCommitmentForm
                onCreated={() => {
                  setShowNew(false)
                  handleRefresh()
                }}
              />
            )}

            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="border-b border-slate-200 py-2 pr-3">Buyer</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Area</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Title</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Status</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Risk</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Review</th>
                    <th className="border-b border-slate-200 py-2 pr-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {state.summary.commitments.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="border-b border-slate-100 py-6 text-center text-xs text-slate-500"
                      >
                        No commitments recorded yet.
                      </td>
                    </tr>
                  )}
                  {state.summary.commitments.map((c) => (
                    <RowAndDetail
                      key={c.id}
                      commitment={c}
                      expanded={expandedId === c.id}
                      onToggle={() =>
                        setExpandedId((v) => (v === c.id ? null : c.id))
                      }
                      onChanged={handleRefresh}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              This register tracks operator-recorded commitments. It is not
              legal advice and does not prove contractual compliance.
              Unsupported-risk warnings flag commitments referencing
              capabilities the current product does not fully support today.
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
  tone?: 'slate' | 'amber' | 'red'
}) {
  const toneClass =
    tone === 'amber'
      ? 'text-amber-700'
      : tone === 'red'
        ? 'text-red-700'
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

function chip(text: string, classes: string) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${classes}`}
    >
      {text}
    </span>
  )
}

function StatusChip({ value }: { value: Status }) {
  if (value === 'fulfilled')
    return chip(
      'fulfilled',
      'bg-emerald-50 text-emerald-700 border-emerald-200'
    )
  if (value === 'active')
    return chip('active', 'bg-emerald-50 text-emerald-700 border-emerald-200')
  if (value === 'at_risk')
    return chip('at risk', 'bg-red-50 text-red-700 border-red-200')
  if (value === 'expired')
    return chip('expired', 'bg-slate-50 text-slate-500 border-slate-200')
  if (value === 'withdrawn')
    return chip('withdrawn', 'bg-slate-50 text-slate-500 border-slate-200')
  return chip('draft', 'bg-slate-50 text-slate-700 border-slate-200')
}

function RiskChip({ value }: { value: Risk }) {
  if (value === 'critical')
    return chip('critical', 'bg-red-50 text-red-700 border-red-200')
  if (value === 'high')
    return chip('high', 'bg-amber-50 text-amber-700 border-amber-200')
  if (value === 'medium')
    return chip('medium', 'bg-slate-50 text-slate-700 border-slate-200')
  return chip('low', 'bg-emerald-50 text-emerald-700 border-emerald-200')
}

function RowAndDetail({
  commitment,
  expanded,
  onToggle,
  onChanged,
}: {
  commitment: Commitment
  expanded: boolean
  onToggle: () => void
  onChanged: () => void
}) {
  const now = Date.now()
  const overdueReview =
    commitment.reviewAt !== null &&
    commitment.status !== 'fulfilled' &&
    commitment.status !== 'expired' &&
    commitment.status !== 'withdrawn' &&
    Date.parse(commitment.reviewAt) < now
  return (
    <>
      <tr>
        <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs">
          <div className="text-slate-700">
            {commitment.buyerCompany ?? '—'}
          </div>
          {commitment.buyerEmail && (
            <div className="text-[11px] text-slate-500">
              {commitment.buyerEmail}
            </div>
          )}
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs text-slate-600">
          {commitment.commitmentArea}
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top">
          <div className="font-medium text-slate-900">{commitment.title}</div>
          <div className="line-clamp-2 text-xs text-slate-500">
            {commitment.description}
          </div>
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top">
          <StatusChip value={commitment.status} />
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top">
          <RiskChip value={commitment.riskLevel} />
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs text-slate-500">
          {commitment.reviewAt
            ? new Date(commitment.reviewAt).toLocaleDateString()
            : '—'}
          {overdueReview && (
            <span className="ml-1 inline-flex items-center rounded-md border border-red-200 bg-red-50 px-1 text-[10px] font-medium text-red-700">
              overdue
            </span>
          )}
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top">
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
            {expanded ? 'Hide' : 'Open'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="border-b border-slate-100 bg-slate-50 p-4">
            <Detail commitment={commitment} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  )
}

interface Event {
  id: string
  eventType: string
  note: string | null
  createdAt: string
}

function Detail({
  commitment,
  onChanged,
}: {
  commitment: Commitment
  onChanged: () => void
}) {
  const [timeline, setTimeline] = useState<Event[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [evidenceUrl, setEvidenceUrl] = useState(commitment.evidenceUrl ?? '')
  const [targetStatus, setTargetStatus] = useState<Status>(commitment.status)
  const [targetRisk, setTargetRisk] = useState<Risk>(commitment.riskLevel)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(
        `/api/admin/security/commitments/${commitment.id}`,
        { credentials: 'same-origin' }
      )
      if (!res.ok) {
        setError(`HTTP ${res.status}`)
        return
      }
      const body = (await res.json()) as { timeline?: Event[] }
      setTimeline(body.timeline ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    }
  }, [commitment.id])

  useEffect(() => {
    void load()
  }, [load])

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch(
          `/api/admin/security/commitments/${commitment.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
          }
        )
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
        await load()
        onChanged()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error')
      } finally {
        setBusy(false)
      }
    },
    [commitment.id, load, onChanged]
  )

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <section>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
          Timeline
        </h4>
        <ol className="space-y-2">
          {!timeline && (
            <li className="flex items-center text-xs text-slate-500">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
              Loading timeline…
            </li>
          )}
          {timeline && timeline.length === 0 && (
            <li className="text-xs text-slate-500">No events yet.</li>
          )}
          {timeline?.map((e) => (
            <li
              key={e.id}
              className="rounded-md border border-slate-200 bg-white p-2 text-xs"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-800">
                  {e.eventType}
                </span>
                <span className="text-slate-400">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>
              {e.note && <div className="mt-1 text-slate-600">{e.note}</div>}
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-3">
        <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Update
        </h4>

        <div className="flex items-center gap-2">
          <select
            value={targetStatus}
            onChange={(e) => setTargetStatus(e.target.value as Status)}
            className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || targetStatus === commitment.status}
            onClick={() => patch({ status: targetStatus })}
            className="inline-flex h-8 items-center rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Set status
          </button>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={targetRisk}
            onChange={(e) => setTargetRisk(e.target.value as Risk)}
            className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
          >
            {RISKS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || targetRisk === commitment.riskLevel}
            onClick={() => patch({ risk_level: targetRisk })}
            className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Set risk
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || commitment.status === 'fulfilled'}
            onClick={() => patch({ mark_fulfilled: true })}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Mark fulfilled
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => patch({ mark_reviewed: true })}
            className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Mark reviewed
          </button>
        </div>

        <div>
          <label className="text-xs text-slate-500">Evidence URL</label>
          <input
            type="url"
            value={evidenceUrl}
            onChange={(e) => setEvidenceUrl(e.target.value)}
            placeholder="https://docs.example.com/dpa-buyer-x"
            className="mt-1 w-full rounded-md border border-slate-200 p-2 text-xs"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => patch({ evidence_url: evidenceUrl || null })}
            className="mt-1 inline-flex h-7 items-center rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Save URL
          </button>
        </div>

        <div>
          <label className="text-xs text-slate-500">Add note</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border border-slate-200 p-2 text-xs"
          />
          <button
            type="button"
            disabled={busy || note.length === 0}
            onClick={() => {
              void patch({ note }).then(() => setNote(''))
            }}
            className="mt-1 inline-flex h-7 items-center rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Append note
          </button>
        </div>

        {error && <div className="text-xs text-red-700">{error}</div>}
      </section>
    </div>
  )
}

function NewCommitmentForm({ onCreated }: { onCreated: () => void }) {
  const [buyerCompany, setBuyerCompany] = useState('')
  const [buyerEmail, setBuyerEmail] = useState('')
  const [sourceType, setSourceType] = useState<SourceType>('msa')
  const [commitmentArea, setCommitmentArea] = useState<Area>('security')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<Status>('draft')
  const [riskLevel, setRiskLevel] = useState<Risk>('medium')
  const [dueAt, setDueAt] = useState('')
  const [reviewAt, setReviewAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        buyer_company: buyerCompany || null,
        buyer_email: buyerEmail || null,
        source_type: sourceType,
        commitment_area: commitmentArea,
        title,
        description,
        status,
        risk_level: riskLevel,
      }
      if (dueAt) body.due_at = new Date(dueAt).toISOString()
      if (reviewAt) body.review_at = new Date(reviewAt).toISOString()
      const res = await fetch('/api/admin/security/commitments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
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
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }, [
    buyerCompany,
    buyerEmail,
    sourceType,
    commitmentArea,
    title,
    description,
    status,
    riskLevel,
    dueAt,
    reviewAt,
    onCreated,
  ])

  return (
    <div className="mb-4 rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-2 text-sm font-medium text-slate-900">
        New commitment
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          type="text"
          placeholder="Buyer company"
          value={buyerCompany}
          onChange={(e) => setBuyerCompany(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
        <input
          type="email"
          placeholder="Buyer email"
          value={buyerEmail}
          onChange={(e) => setBuyerEmail(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
        <select
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value as SourceType)}
          className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
        >
          {SOURCE_TYPES.map((s) => (
            <option key={s} value={s}>
              source: {s}
            </option>
          ))}
        </select>
        <select
          value={commitmentArea}
          onChange={(e) => setCommitmentArea(e.target.value as Area)}
          className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
        >
          {AREAS.map((a) => (
            <option key={a} value={a}>
              area: {a}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
        <div className="flex gap-2">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
            className="h-8 flex-1 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={riskLevel}
            onChange={(e) => setRiskLevel(e.target.value as Risk)}
            className="h-8 flex-1 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
          >
            {RISKS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <input
          type="date"
          placeholder="Due"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
        <input
          type="date"
          placeholder="Review"
          value={reviewAt}
          onChange={(e) => setReviewAt(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
      </div>
      <textarea
        rows={3}
        placeholder="Description — what did we commit to in this customer's contract / addendum / email?"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="mt-2 w-full rounded-md border border-slate-200 p-2 text-sm"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-slate-500">
          This is operator-recorded. Not legal advice. Not contractual proof.
        </span>
        <button
          type="button"
          disabled={
            busy || title.length === 0 || description.length === 0
          }
          onClick={submit}
          className="inline-flex h-8 items-center rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Record commitment
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-red-700">{error}</div>}
    </div>
  )
}
