'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  ChevronDown,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Sheet,
  Sprout,
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
 * Phase 9O — ComplianceCalendarCard (admin/owner only).
 *
 * Tracks operator-initiated reviews against the static
 * COMPLIANCE_REVIEW_POLICY. Stats + table + row expansion +
 * seed/create/exports.
 *
 * Honest disclaimer in footer: the calendar tracks operator
 * reviews; it does NOT prove continuous compliance.
 */

type Area =
  | 'vendor_risk'
  | 'subprocessors'
  | 'privacy_dsr'
  | 'retention_policy'
  | 'disaster_recovery'
  | 'backup_posture'
  | 'incident_response'
  | 'trust_center'
  | 'security_questionnaire'
  | 'evidence_pack'
  | 'sso_readiness'
  | 'rate_limit_coverage'
  | 'audit_coverage'
  | 'access_control'
  | 'security_headers'
  | 'data_lifecycle'
  | 'custom'

type Cadence = 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'ad_hoc'
type Status = 'upcoming' | 'due' | 'overdue' | 'completed' | 'waived'

interface Event {
  id: string
  policyId: string
  area: Area
  title: string
  cadence: Cadence
  status: Status
  source: string
  dueAt: string
  completedAt: string | null
  waivedAt: string | null
  waiverReason: string | null
  reviewNotes: string | null
  evidenceUrl: string | null
}

interface ListSummary {
  generatedAt: string
  counts: {
    total: number
    upcoming: number
    due: number
    overdue: number
    completedLast30d: number
    waived: number
  }
  events: Event[]
  warnings: string[]
}

interface FreshnessRow {
  policyId: string
  area: Area
  title: string
  cadence: Cadence
  ownerRole: string
  lastCompletedAt: string | null
  nextDueAt: string | null
  status: Status
  stale: boolean
  buyerImpactIfStale: string
}

interface FreshnessSummary {
  generatedAt: string
  disclaimer: string
  counts: {
    totalPolicyItems: number
    upcoming: number
    due: number
    overdue: number
    completedLast30d: number
    waived: number
    staleAreas: number
  }
  rows: FreshnessRow[]
  warnings: string[]
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; list: ListSummary; freshness: FreshnessSummary | null }

const AREAS: ReadonlyArray<Area> = [
  'vendor_risk',
  'subprocessors',
  'privacy_dsr',
  'retention_policy',
  'disaster_recovery',
  'backup_posture',
  'incident_response',
  'trust_center',
  'security_questionnaire',
  'evidence_pack',
  'sso_readiness',
  'rate_limit_coverage',
  'audit_coverage',
  'access_control',
  'security_headers',
  'data_lifecycle',
  'custom',
]
const CADENCES: ReadonlyArray<Cadence> = [
  'monthly',
  'quarterly',
  'semiannual',
  'annual',
  'ad_hoc',
]

export default function ComplianceCalendarCard() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  const [seeding, setSeeding] = useState(false)
  const [showCustom, setShowCustom] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const [listRes, freshnessRes] = await Promise.all([
          fetch('/api/admin/security/compliance/calendar?limit=200', {
            signal: abort.signal,
            credentials: 'same-origin',
          }),
          fetch('/api/admin/security/compliance/freshness?format=json', {
            signal: abort.signal,
            credentials: 'same-origin',
          }),
        ])
        if (!listRes.ok) {
          setState({ kind: 'error', message: `list HTTP ${listRes.status}` })
          return
        }
        const listBody = (await listRes.json()) as { summary?: ListSummary }
        if (!listBody.summary) {
          setState({ kind: 'error', message: 'empty_response' })
          return
        }
        let freshness: FreshnessSummary | null = null
        if (freshnessRes.ok) {
          const fb = (await freshnessRes.json()) as {
            summary?: FreshnessSummary
          }
          freshness = fb.summary ?? null
        }
        setState({ kind: 'ready', list: listBody.summary, freshness })
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

  const handleSeed = useCallback(async () => {
    setSeeding(true)
    try {
      const res = await fetch('/api/admin/security/compliance/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'seed' }),
      })
      if (!res.ok) {
        window.alert(`Seed failed: HTTP ${res.status}`)
        return
      }
      handleRefresh()
    } catch (err) {
      window.alert(
        'Seed failed: ' +
          (err instanceof Error ? err.message : 'Network error')
      )
    } finally {
      setSeeding(false)
    }
  }, [handleRefresh])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <CalendarCheck className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Compliance operations calendar</CardTitle>
              <CardSubtitle>
                Recurring review tracking against the static
                COMPLIANCE_REVIEW_POLICY. Tracks operator reviews —
                does NOT prove continuous compliance or auto-refresh
                evidence.
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
              onClick={handleSeed}
              disabled={seeding}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              <Sprout className="h-3.5 w-3.5" />
              {seeding ? 'Seeding…' : 'Seed missing'}
            </button>
            <button
              type="button"
              onClick={() => setShowCustom((v) => !v)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Custom review
            </button>
            <a
              href="/api/admin/security/compliance/calendar?format=csv"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <Sheet className="h-3.5 w-3.5" />
              Calendar CSV
            </a>
            <a
              href="/api/admin/security/compliance/freshness?format=markdown"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              <FileText className="h-3.5 w-3.5" />
              Freshness MD
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
            <div>Could not load calendar: {state.message}</div>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Total" value={state.list.counts.total} tone="slate" />
              <Stat
                label="Upcoming"
                value={state.list.counts.upcoming}
                tone="slate"
              />
              <Stat
                label="Due"
                value={state.list.counts.due}
                tone="amber"
              />
              <Stat
                label="Overdue"
                value={state.list.counts.overdue}
                tone={state.list.counts.overdue > 0 ? 'red' : 'slate'}
              />
              <Stat
                label="Completed 30d"
                value={state.list.counts.completedLast30d}
                tone="emerald"
              />
              {state.freshness && (
                <Stat
                  label="Stale areas"
                  value={state.freshness.counts.staleAreas}
                  tone={
                    state.freshness.counts.staleAreas > 0 ? 'amber' : 'slate'
                  }
                />
              )}
            </dl>

            {state.list.warnings.length > 0 && (
              <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                {state.list.warnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            )}

            {showCustom && (
              <CustomReviewForm
                onCreated={() => {
                  setShowCustom(false)
                  handleRefresh()
                }}
              />
            )}

            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="border-b border-slate-200 py-2 pr-3">Due</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Area</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Title</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Cadence</th>
                    <th className="border-b border-slate-200 py-2 pr-3">Status</th>
                    <th className="border-b border-slate-200 py-2 pr-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {state.list.events.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="border-b border-slate-100 py-6 text-center text-xs text-slate-500"
                      >
                        No reviews yet. Click <strong>Seed missing</strong> to
                        populate the calendar against the static policy.
                      </td>
                    </tr>
                  )}
                  {state.list.events.map((e) => (
                    <RowAndDetail
                      key={e.id}
                      event={e}
                      expanded={expandedId === e.id}
                      onToggle={() =>
                        setExpandedId((v) => (v === e.id ? null : e.id))
                      }
                      onChanged={handleRefresh}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {state.freshness && (
              <details className="mt-4 rounded-md border border-slate-200 bg-white p-3 text-xs text-slate-600">
                <summary className="cursor-pointer text-sm font-medium text-slate-900">
                  Per-area freshness ({state.freshness.rows.length} policy items)
                </summary>
                <table className="mt-2 w-full border-separate border-spacing-0">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="border-b border-slate-200 py-1 pr-3">Area</th>
                      <th className="border-b border-slate-200 py-1 pr-3">Title</th>
                      <th className="border-b border-slate-200 py-1 pr-3">Last completed</th>
                      <th className="border-b border-slate-200 py-1 pr-3">Status</th>
                      <th className="border-b border-slate-200 py-1 pr-3">Stale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.freshness.rows.map((r) => (
                      <tr key={r.policyId}>
                        <td className="border-b border-slate-100 py-1 pr-3 text-xs text-slate-600">
                          {r.area}
                        </td>
                        <td className="border-b border-slate-100 py-1 pr-3 text-xs text-slate-700">
                          {r.title}
                        </td>
                        <td className="border-b border-slate-100 py-1 pr-3 text-xs text-slate-500">
                          {r.lastCompletedAt
                            ? new Date(r.lastCompletedAt).toLocaleDateString()
                            : 'never'}
                        </td>
                        <td className="border-b border-slate-100 py-1 pr-3">
                          <StatusChip value={r.status} />
                        </td>
                        <td className="border-b border-slate-100 py-1 pr-3">
                          {r.stale ? (
                            <span className="inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                              stale
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}

            <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              Compliance calendar tracks operator reviews. It does not prove
              continuous compliance or automatically update evidence. Stale-
              flagging is a soft signal, not a control failure.
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

function StatusChip({ value }: { value: Status }) {
  if (value === 'completed')
    return chip(
      'completed',
      'bg-emerald-50 text-emerald-700 border-emerald-200'
    )
  if (value === 'waived')
    return chip('waived', 'bg-slate-50 text-slate-500 border-slate-200')
  if (value === 'overdue')
    return chip('overdue', 'bg-red-50 text-red-700 border-red-200')
  if (value === 'due')
    return chip('due', 'bg-amber-50 text-amber-700 border-amber-200')
  return chip('upcoming', 'bg-slate-50 text-slate-700 border-slate-200')
}

function RowAndDetail({
  event,
  expanded,
  onToggle,
  onChanged,
}: {
  event: Event
  expanded: boolean
  onToggle: () => void
  onChanged: () => void
}) {
  const now = Date.now()
  const dueMs = Date.parse(event.dueAt)
  const overdue =
    event.status !== 'completed' &&
    event.status !== 'waived' &&
    dueMs < now - 24 * 60 * 60 * 1000
  const derivedStatus: Status =
    event.status === 'completed' || event.status === 'waived'
      ? event.status
      : overdue
        ? 'overdue'
        : dueMs <= now
          ? 'due'
          : 'upcoming'
  return (
    <>
      <tr>
        <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs text-slate-700">
          {new Date(event.dueAt).toLocaleDateString()}
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs text-slate-600">
          {event.area}
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top">
          <div className="font-medium text-slate-900">{event.title}</div>
          {event.reviewNotes && (
            <div className="line-clamp-2 text-xs text-slate-500">
              {event.reviewNotes}
            </div>
          )}
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top text-xs text-slate-600">
          {event.cadence}
        </td>
        <td className="border-b border-slate-100 py-2 pr-3 align-top">
          <StatusChip value={derivedStatus} />
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
            <EventDetail event={event} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  )
}

function EventDetail({
  event,
  onChanged,
}: {
  event: Event
  onChanged: () => void
}) {
  const [reviewNotes, setReviewNotes] = useState(event.reviewNotes ?? '')
  const [evidenceUrl, setEvidenceUrl] = useState(event.evidenceUrl ?? '')
  const [waiverReason, setWaiverReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch(
          `/api/admin/security/compliance/calendar/${event.id}`,
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
        onChanged()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error')
      } finally {
        setBusy(false)
      }
    },
    [event.id, onChanged]
  )

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <section>
        <div className="mb-1 text-xs text-slate-500">Review notes</div>
        <textarea
          value={reviewNotes}
          onChange={(e) => setReviewNotes(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-slate-200 p-2 text-xs"
        />
        <div className="mb-1 mt-2 text-xs text-slate-500">Evidence URL</div>
        <input
          type="url"
          value={evidenceUrl}
          onChange={(e) => setEvidenceUrl(e.target.value)}
          placeholder="https://docs.example.com/q3-dr-drill"
          className="w-full rounded-md border border-slate-200 p-2 text-xs"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={busy || event.status === 'completed'}
            onClick={() =>
              patch({
                action: 'complete',
                review_notes: reviewNotes || null,
                evidence_url: evidenceUrl || null,
              })
            }
            className="inline-flex h-8 items-center gap-1 rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Mark completed
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              patch({
                action: 'update',
                review_notes: reviewNotes || null,
                evidence_url: evidenceUrl || null,
              })
            }
            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Update notes
          </button>
        </div>
      </section>

      <section>
        <div className="mb-1 text-xs text-slate-500">Waive (with reason)</div>
        <textarea
          value={waiverReason}
          onChange={(e) => setWaiverReason(e.target.value)}
          rows={3}
          placeholder="Why is this review being waived?"
          className="w-full rounded-md border border-slate-200 p-2 text-xs"
        />
        <button
          type="button"
          disabled={busy || waiverReason.length === 0}
          onClick={() =>
            patch({
              action: 'waive',
              waiver_reason: waiverReason,
            })
          }
          className="mt-2 inline-flex h-8 items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
        >
          <XCircle className="h-3.5 w-3.5" />
          Waive
        </button>
        {event.status === 'waived' && event.waiverReason && (
          <div className="mt-3 rounded-md border border-slate-200 bg-white p-2 text-xs text-slate-600">
            <div className="font-medium text-slate-800">Waived</div>
            <div>{event.waiverReason}</div>
          </div>
        )}
        {event.status === 'completed' && event.completedAt && (
          <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
            Completed {new Date(event.completedAt).toLocaleString()}
            {event.evidenceUrl && (
              <>
                {' '}·{' '}
                <a
                  href={event.evidenceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  evidence
                </a>
              </>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="md:col-span-2 text-xs text-red-700">{error}</div>
      )}
    </div>
  )
}

function CustomReviewForm({ onCreated }: { onCreated: () => void }) {
  const [area, setArea] = useState<Area>('custom')
  const [title, setTitle] = useState('')
  const [cadence, setCadence] = useState<Cadence>('quarterly')
  const [dueAt, setDueAt] = useState('')
  const [reviewNotes, setReviewNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        action: 'create_custom',
        area,
        title,
        cadence,
        due_at: new Date(dueAt).toISOString(),
      }
      if (reviewNotes) body.review_notes = reviewNotes
      const res = await fetch('/api/admin/security/compliance/calendar', {
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
  }, [area, title, cadence, dueAt, reviewNotes, onCreated])

  return (
    <div className="mb-4 rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-2 text-sm font-medium text-slate-900">
        New custom review
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          type="text"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
        <input
          type="date"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-2 text-sm"
        />
        <select
          value={area}
          onChange={(e) => setArea(e.target.value as Area)}
          className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
        >
          {AREAS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select
          value={cadence}
          onChange={(e) => setCadence(e.target.value as Cadence)}
          className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
        >
          {CADENCES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <textarea
        rows={2}
        placeholder="Notes (optional)"
        value={reviewNotes}
        onChange={(e) => setReviewNotes(e.target.value)}
        className="mt-2 w-full rounded-md border border-slate-200 p-2 text-xs"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-slate-500">
          Use for one-off reviews not in the standard policy.
        </span>
        <button
          type="button"
          disabled={busy || title.length === 0 || !dueAt}
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
