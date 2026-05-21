'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ClipboardList,
  Eye,
  Loader2,
  Plus,
  RefreshCw,
  Sheet,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'

/**
 * Phase 9M — DsrRequestsCard (admin/owner only).
 *
 * Tracks Data Subject Requests (DSRs). Operator workflow only —
 * NO automatic fulfillment. Export preview is metadata-only;
 * deletion review is non-destructive.
 */

type DsrType =
  | 'access'
  | 'export'
  | 'delete'
  | 'correct'
  | 'restrict_processing'
  | 'opt_out'
  | 'other'

type DsrStatus =
  | 'received'
  | 'triage'
  | 'identity_verification'
  | 'in_progress'
  | 'awaiting_legal_review'
  | 'fulfilled'
  | 'denied'
  | 'cancelled'

type DsrRiskLevel = 'low' | 'medium' | 'high'

interface DsrRequest {
  id: string
  venueId: string | null
  requestType: DsrType
  status: DsrStatus
  riskLevel: DsrRiskLevel
  subjectEmail: string | null
  subjectName: string | null
  subjectUserId: string | null
  requestedByEmail: string | null
  identityVerifiedAt: string | null
  legalReviewRequired: boolean
  legalReviewNotes: string | null
  description: string | null
  scope: string | null
  dueAt: string | null
  fulfilledAt: string | null
  deniedAt: string | null
  cancelledAt: string | null
  createdAt: string
}

interface DsrSummary {
  generatedAt: string
  counts: {
    total: number
    open: number
    awaitingLegalReview: number
    fulfilled: number
    denied: number
    cancelled: number
    overdue: number
  }
  requests: DsrRequest[]
  warnings: string[]
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; summary: DsrSummary }

const TYPES: ReadonlyArray<DsrType> = [
  'access',
  'export',
  'delete',
  'correct',
  'restrict_processing',
  'opt_out',
  'other',
]
const STATUSES: ReadonlyArray<DsrStatus> = [
  'received',
  'triage',
  'identity_verification',
  'in_progress',
  'awaiting_legal_review',
  'fulfilled',
  'denied',
  'cancelled',
]
const RISKS: ReadonlyArray<DsrRiskLevel> = ['low', 'medium', 'high']

export default function DsrRequestsCard() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  const [showNew, setShowNew] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const res = await fetch(
          '/api/admin/privacy/dsr-requests?limit=25',
          {
            method: 'GET',
            signal: abort.signal,
            credentials: 'same-origin',
          }
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
        const body = (await res.json()) as { summary?: DsrSummary }
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

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <ClipboardList className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Data subject requests</CardTitle>
              <CardSubtitle>
                Operator-controlled DSR workflow. Export preview is
                metadata-only; deletion review is non-destructive. No
                request is fulfilled automatically — every export and
                deletion routes through operator + legal review.
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
              New DSR
            </button>
            <a
              href="/api/admin/privacy/dsr-requests?format=csv"
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
            <div>
              <div className="font-medium">Could not load DSRs</div>
              <div className="text-xs">{state.message}</div>
            </div>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Open"
                value={state.summary.counts.open}
                tone="amber"
              />
              <Stat
                label="Awaiting legal"
                value={state.summary.counts.awaitingLegalReview}
                tone="amber"
              />
              <Stat
                label="Fulfilled"
                value={state.summary.counts.fulfilled}
                tone="emerald"
              />
              <Stat
                label="Overdue"
                value={state.summary.counts.overdue}
                tone={state.summary.counts.overdue > 0 ? 'red' : 'slate'}
              />
            </dl>

            {showNew && (
              <NewDsrForm
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
                    <th className="border-b border-slate-200 py-2 pr-3">Type</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Status</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Risk</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Subject</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Due</th>
                    <th className="border-b border-slate-200 py-2 pr-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {state.summary.requests.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="border-b border-slate-100 py-6 text-center text-xs text-slate-500"
                      >
                        No DSR requests recorded yet.
                      </td>
                    </tr>
                  )}
                  {state.summary.requests.map((r) => (
                    <RowAndDetail
                      key={r.id}
                      request={r}
                      expanded={expandedId === r.id}
                      onToggle={() =>
                        setExpandedId((v) => (v === r.id ? null : r.id))
                      }
                      onChanged={handleRefresh}
                    />
                  ))}
                </tbody>
              </table>
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
  tone,
}: {
  label: string
  value: number
  tone: 'slate' | 'amber' | 'red' | 'emerald'
}) {
  const toneClass =
    tone === 'amber'
      ? 'text-amber-700'
      : tone === 'red'
        ? 'text-red-700'
        : tone === 'emerald'
          ? 'text-emerald-700'
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

function StatusChip({ value }: { value: DsrStatus }) {
  if (value === 'fulfilled')
    return chip('fulfilled', 'bg-emerald-50 text-emerald-700 border-emerald-200')
  if (value === 'denied')
    return chip('denied', 'bg-red-50 text-red-700 border-red-200')
  if (value === 'cancelled')
    return chip('cancelled', 'bg-slate-50 text-slate-500 border-slate-200')
  if (value === 'awaiting_legal_review')
    return chip('awaiting legal', 'bg-amber-50 text-amber-700 border-amber-200')
  return chip(value, 'bg-amber-50 text-amber-700 border-amber-200')
}

function RiskChip({ value }: { value: DsrRiskLevel }) {
  if (value === 'high')
    return chip('high', 'bg-red-50 text-red-700 border-red-200')
  if (value === 'medium')
    return chip('medium', 'bg-amber-50 text-amber-700 border-amber-200')
  return chip('low', 'bg-emerald-50 text-emerald-700 border-emerald-200')
}

function RowAndDetail({
  request,
  expanded,
  onToggle,
  onChanged,
}: {
  request: DsrRequest
  expanded: boolean
  onToggle: () => void
  onChanged: () => void
}) {
  const overdue =
    request.dueAt &&
    !['fulfilled', 'denied', 'cancelled'].includes(request.status) &&
    Date.parse(request.dueAt) < Date.now()
  return (
    <>
      <tr>
        <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs font-medium text-slate-700">
          {request.requestType}
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top">
          <StatusChip value={request.status} />
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top">
          <RiskChip value={request.riskLevel} />
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top">
          <div className="text-xs text-slate-700">
            {request.subjectEmail ?? '(no email)'}
          </div>
          {request.subjectName && (
            <div className="text-[11px] text-slate-500">{request.subjectName}</div>
          )}
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs text-slate-500">
          {request.dueAt
            ? new Date(request.dueAt).toLocaleDateString()
            : '—'}
          {overdue && (
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
          <td colSpan={6} className="border-b border-slate-100 bg-slate-50 p-4">
            <DsrDetail
              dsrId={request.id}
              onChanged={onChanged}
            />
          </td>
        </tr>
      )}
    </>
  )
}

interface TimelineEvent {
  id: string
  eventType: string
  actorUserId: string | null
  message: string | null
  createdAt: string
}

interface DetailResponse {
  request: DsrRequest
  timeline: TimelineEvent[]
  warnings: string[]
}

function DsrDetail({
  dsrId,
  onChanged,
}: {
  dsrId: string
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<DetailResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [legalNote, setLegalNote] = useState('')
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [deletionCount, setDeletionCount] = useState<number | null>(null)
  const [targetStatus, setTargetStatus] = useState<DsrStatus>('triage')

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/admin/privacy/dsr-requests/${dsrId}`, {
        credentials: 'same-origin',
      })
      if (!res.ok) {
        setError(`HTTP ${res.status}`)
        return
      }
      const body = (await res.json()) as DetailResponse
      setDetail(body)
      setTargetStatus(body.request.status)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    }
  }, [dsrId])

  useEffect(() => {
    void load()
  }, [load])

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch(
          `/api/admin/privacy/dsr-requests/${dsrId}`,
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
    [dsrId, load, onChanged]
  )

  const runPreview = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/admin/privacy/dsr-requests/${dsrId}/export-preview`,
        { method: 'POST', credentials: 'same-origin' }
      )
      if (!res.ok) {
        setError(`preview: HTTP ${res.status}`)
        return
      }
      const body = (await res.json()) as {
        preview?: { items?: Array<unknown> }
      }
      setPreviewCount(body.preview?.items?.length ?? 0)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }, [dsrId, load])

  const runDeletionReview = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/admin/privacy/dsr-requests/${dsrId}/deletion-review`,
        { method: 'POST', credentials: 'same-origin' }
      )
      if (!res.ok) {
        setError(`deletion review: HTTP ${res.status}`)
        return
      }
      const body = (await res.json()) as {
        review?: { items?: Array<unknown> }
      }
      setDeletionCount(body.review?.items?.length ?? 0)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }, [dsrId, load])

  if (error) {
    return (
      <div className="text-xs text-red-700">Error loading detail: {error}</div>
    )
  }
  if (!detail) {
    return (
      <div className="flex items-center text-xs text-slate-500">
        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
        Loading…
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <section>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
          Timeline
        </h4>
        <ol className="space-y-2">
          {detail.timeline.length === 0 && (
            <li className="text-xs text-slate-500">No events yet.</li>
          )}
          {detail.timeline.map((e) => (
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
              {e.message && (
                <div className="mt-1 text-slate-600">{e.message}</div>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-3">
        <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Workflow
        </h4>

        <div className="flex items-center gap-2">
          <select
            value={targetStatus}
            onChange={(e) => setTargetStatus(e.target.value as DsrStatus)}
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
            disabled={busy}
            onClick={() => patch({ status: targetStatus })}
            className="inline-flex h-8 items-center rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Set status
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || Boolean(detail.request.identityVerifiedAt)}
            onClick={() => patch({ mark_identity_verified: true })}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {detail.request.identityVerifiedAt
              ? 'Identity verified'
              : 'Mark identity verified'}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={runPreview}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <Eye className="h-3.5 w-3.5" />
            Export preview (metadata only)
            {previewCount !== null && (
              <span className="ml-1 text-slate-500">· {previewCount}</span>
            )}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={runDeletionReview}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Deletion review (non-destructive)
            {deletionCount !== null && (
              <span className="ml-1 text-slate-500">· {deletionCount}</span>
            )}
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

        <div>
          <label className="text-xs text-slate-500">
            Legal review note
          </label>
          <textarea
            value={legalNote}
            onChange={(e) => setLegalNote(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-md border border-slate-200 p-2 text-xs"
          />
          <button
            type="button"
            disabled={busy || legalNote.length === 0}
            onClick={() => {
              void patch({ legal_review_notes: legalNote }).then(() =>
                setLegalNote('')
              )
            }}
            className="mt-1 inline-flex h-7 items-center rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Append legal note
          </button>
        </div>
      </section>
    </div>
  )
}

function NewDsrForm({ onCreated }: { onCreated: () => void }) {
  const [requestType, setRequestType] = useState<DsrType>('access')
  const [riskLevel, setRiskLevel] = useState<DsrRiskLevel>('medium')
  const [subjectEmail, setSubjectEmail] = useState('')
  const [subjectName, setSubjectName] = useState('')
  const [requestedByEmail, setRequestedByEmail] = useState('')
  const [description, setDescription] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        request_type: requestType,
        risk_level: riskLevel,
        subject_email: subjectEmail || null,
        subject_name: subjectName || null,
        requested_by_email: requestedByEmail || null,
        description: description || null,
        legal_review_required: true,
      }
      if (dueAt) body.due_at = new Date(dueAt).toISOString()
      const res = await fetch('/api/admin/privacy/dsr-requests', {
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
    requestType,
    riskLevel,
    subjectEmail,
    subjectName,
    requestedByEmail,
    description,
    dueAt,
    onCreated,
  ])

  return (
    <div className="mb-4 rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-2 text-sm font-medium text-slate-900">New DSR</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <select
          value={requestType}
          onChange={(e) => setRequestType(e.target.value as DsrType)}
          className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={riskLevel}
          onChange={(e) => setRiskLevel(e.target.value as DsrRiskLevel)}
          className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
        >
          {RISKS.map((r) => (
            <option key={r} value={r}>
              risk: {r}
            </option>
          ))}
        </select>
        <input
          type="email"
          placeholder="Subject email"
          value={subjectEmail}
          onChange={(e) => setSubjectEmail(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
        <input
          type="text"
          placeholder="Subject name"
          value={subjectName}
          onChange={(e) => setSubjectName(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
        <input
          type="email"
          placeholder="Requested by (email)"
          value={requestedByEmail}
          onChange={(e) => setRequestedByEmail(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
        <input
          type="date"
          placeholder="Due"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
      </div>
      <textarea
        rows={2}
        placeholder="Description / scope (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="mt-2 w-full rounded-md border border-slate-200 p-2 text-sm"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-slate-500">
          Legal review will be required by default.
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="inline-flex h-8 items-center rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Create
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-red-700">{error}</div>}
    </div>
  )
}
