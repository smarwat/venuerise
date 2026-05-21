'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Timer,
  XCircle,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { cn } from '@/lib/utils'
import { formatDistanceToNow } from 'date-fns'

/**
 * Phase 8AZ — Autopilot Shadow Evaluation review queue.
 *
 * Sits between AutopilotSimulationPanel and AIDraftAuditCard on
 * /dashboard/settings/billing. Renders the list of `ai_actions`
 * rows where the Phase 8AX autopilot decision and the Phase 8AW
 * operator outcome disagreed, and lets the operator label each
 * one with a verdict that future calibration can read.
 *
 * Labels DO NOT enable autonomy. They DO NOT auto-tune
 * guardrails. They DO NOT change anything about how the system
 * scores future drafts. They are calibration evidence the next
 * phase (8BA — Per-Venue Autonomy Readiness Gate) will read
 * to decide whether a venue is even eligible to OPT IN to
 * autopilot consideration.
 *
 * Data sources:
 *   - GET  /api/admin/ai/autopilot-reviews  — queue + summary
 *   - POST /api/admin/ai/autopilot-reviews/[aiActionId]  — label
 *
 * Refreshes on the same `venuerise:ai-draft-audit-fired` realtime
 * event the calibration / simulation panels listen to.
 */

type ReviewState =
  | 'needs_review'
  | 'confirmed_guardrail_too_strict'
  | 'confirmed_guardrail_correct'
  | 'confirmed_operator_error'
  | 'deferred'
type WritableReviewState = Exclude<ReviewState, 'needs_review'>

type Alignment =
  | 'operator_more_conservative'
  | 'operator_less_conservative'
  | 'aligned'
  | 'unknown'

interface RuleSignal {
  rule: string
  total: number
  reviewed: number
  confirmedTooStrict: number
  confirmedCorrect: number
  confirmedOperatorError: number
  deferred: number
  falsePositiveRate: number | null
}

interface QueueItem {
  ai_action_id: string
  venue_id: string
  lead_id: string | null
  lead_name: string | null
  created_at: string
  autopilot_mode: 'eligible' | 'review_required' | 'blocked' | null
  operator_outcome: string | null
  edit_distance_bucket: string | null
  final_confidence: number | null
  operator_alignment: Alignment
  risk_flags: string[]
  review_state: ReviewState
  review_note: string | null
  reviewed_at: string | null
  reviewer_user_id: string | null
}

interface QueueSummary {
  total_disagreements: number
  reviewed_disagreements: number
  reviewed_disagreements_pct: number | null
  needs_review: number
  confirmed_guardrail_too_strict: number
  confirmed_guardrail_correct: number
  confirmed_operator_error: number
  deferred: number
  operator_more_conservative: number
  operator_less_conservative: number
  rule_signals: RuleSignal[]
}

interface QueueResponse {
  items: QueueItem[]
  next_cursor: string | null
  has_more: boolean
  summary: QueueSummary
}

type StateFilter = ReviewState | 'all'
type AlignmentFilter =
  | 'all'
  | 'operator_more_conservative'
  | 'operator_less_conservative'

const STATE_FILTERS: ReadonlyArray<{ value: StateFilter; label: string }> = [
  { value: 'needs_review', label: 'Needs review' },
  { value: 'confirmed_guardrail_too_strict', label: 'Too strict' },
  { value: 'confirmed_guardrail_correct', label: 'Correct' },
  { value: 'confirmed_operator_error', label: 'Operator error' },
  { value: 'deferred', label: 'Deferred' },
  { value: 'all', label: 'All' },
]

const ALIGNMENT_FILTERS: ReadonlyArray<{
  value: AlignmentFilter
  label: string
}> = [
  { value: 'all', label: 'All' },
  { value: 'operator_more_conservative', label: 'Operator more conservative' },
  { value: 'operator_less_conservative', label: 'Operator less conservative' },
]

const REALTIME_EVENT = 'venuerise:ai-draft-audit-fired'

type PanelState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: QueueResponse }

interface AutopilotReviewQueueProps {
  venueId: string
}

export default function AutopilotReviewQueue({
  venueId,
}: AutopilotReviewQueueProps) {
  const [state, setState] = useState<PanelState>({ kind: 'loading' })
  const [stateFilter, setStateFilter] = useState<StateFilter>('needs_review')
  const [alignmentFilter, setAlignmentFilter] = useState<AlignmentFilter>('all')
  const [reloadTick, setReloadTick] = useState(0)
  // Per-row pending-write flag. Optimistic update flips the
  // visible review state immediately; the in-flight POST flips
  // the flag back when it resolves. Failures revert and surface
  // an inline error.
  const [pendingByActionId, setPendingByActionId] = useState<
    Record<string, boolean>
  >({})
  // Per-row note buffer. We don't post until the operator picks
  // a label so the note is collected alongside the verdict.
  const [noteByActionId, setNoteByActionId] = useState<
    Record<string, string>
  >({})
  const [labelErrorByActionId, setLabelErrorByActionId] = useState<
    Record<string, string | null>
  >({})

  // Refetch on realtime fire so the queue + summary track new
  // drafts as the operator works through them.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onFire = () => setReloadTick((n) => n + 1)
    window.addEventListener(REALTIME_EVENT, onFire)
    return () => window.removeEventListener(REALTIME_EVENT, onFire)
  }, [])

  const fetchQueue = useCallback(async () => {
    setState({ kind: 'loading' })
    const params = new URLSearchParams()
    params.set('venue_id', venueId)
    params.set('state', stateFilter)
    params.set('alignment', alignmentFilter)
    params.set('limit', '25')
    try {
      const res = await fetch(
        `/api/admin/ai/autopilot-reviews?${params.toString()}`,
        { credentials: 'same-origin' }
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        setState({
          kind: 'error',
          message: body?.error ?? `HTTP ${res.status}`,
        })
        return
      }
      const body = (await res.json()) as QueueResponse
      setState({ kind: 'ready', data: body })
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }, [venueId, stateFilter, alignmentFilter])

  useEffect(() => {
    fetchQueue()
  }, [fetchQueue, reloadTick])

  const handleLabel = useCallback(
    async (aiActionId: string, reviewState: WritableReviewState) => {
      setPendingByActionId((m) => ({ ...m, [aiActionId]: true }))
      setLabelErrorByActionId((m) => ({ ...m, [aiActionId]: null }))
      // Optimistic local update: flip the row's visible state +
      // bump the summary counters so the operator sees the change
      // immediately. If the POST fails we revert.
      const previousState = state
      if (state.kind === 'ready') {
        setState({
          kind: 'ready',
          data: {
            ...state.data,
            items: state.data.items.map((it) =>
              it.ai_action_id === aiActionId
                ? {
                    ...it,
                    review_state: reviewState,
                    reviewed_at: new Date().toISOString(),
                  }
                : it
            ),
          },
        })
      }
      try {
        const note = (noteByActionId[aiActionId] ?? '').trim()
        const res = await fetch(
          `/api/admin/ai/autopilot-reviews/${aiActionId}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              review_state: reviewState,
              ...(note.length > 0 ? { note: note.slice(0, 500) } : {}),
            }),
          }
        )
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | null
          setLabelErrorByActionId((m) => ({
            ...m,
            [aiActionId]: body?.error ?? `HTTP ${res.status}`,
          }))
          // Revert optimistic state.
          setState(previousState)
          return
        }
        // Refresh on success so the summary (counts + rule_signals)
        // updates against the authoritative server response.
        setReloadTick((n) => n + 1)
      } catch (err) {
        setLabelErrorByActionId((m) => ({
          ...m,
          [aiActionId]: err instanceof Error ? err.message : 'Network error',
        }))
        setState(previousState)
      } finally {
        setPendingByActionId((m) => ({ ...m, [aiActionId]: false }))
      }
    },
    [noteByActionId, state]
  )

  return (
    <Card>
      <CardHeader>
        <div>
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#64748B]">
            Shadow evaluation
          </div>
          <CardTitle>Review autopilot disagreements</CardTitle>
          <CardSubtitle>
            Label where the AI and operator disagreed. This tunes
            future guardrails without enabling autonomy.
          </CardSubtitle>
        </div>
        <div className="shrink-0 w-9 h-9 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center">
          <ClipboardList className="w-4 h-4 text-[#1D4ED8]" />
        </div>
      </CardHeader>
      <CardContent>
        {state.kind === 'loading' && (
          <div className="flex items-center gap-2 text-[12.5px] text-[#475569] py-3">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading review queue…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2.5 text-[12px] text-[#B91C1C] flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p>Couldn&apos;t load review queue: {state.message}</p>
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

        {state.kind === 'ready' && (
          <QueueBody
            data={state.data}
            stateFilter={stateFilter}
            alignmentFilter={alignmentFilter}
            onStateFilter={setStateFilter}
            onAlignmentFilter={setAlignmentFilter}
            pendingByActionId={pendingByActionId}
            noteByActionId={noteByActionId}
            onNoteChange={(id, v) =>
              setNoteByActionId((m) => ({ ...m, [id]: v }))
            }
            labelErrorByActionId={labelErrorByActionId}
            onLabel={handleLabel}
          />
        )}
      </CardContent>
    </Card>
  )
}

function QueueBody({
  data,
  stateFilter,
  alignmentFilter,
  onStateFilter,
  onAlignmentFilter,
  pendingByActionId,
  noteByActionId,
  onNoteChange,
  labelErrorByActionId,
  onLabel,
}: {
  data: QueueResponse
  stateFilter: StateFilter
  alignmentFilter: AlignmentFilter
  onStateFilter: (s: StateFilter) => void
  onAlignmentFilter: (a: AlignmentFilter) => void
  pendingByActionId: Record<string, boolean>
  noteByActionId: Record<string, string>
  onNoteChange: (aiActionId: string, value: string) => void
  labelErrorByActionId: Record<string, string | null>
  onLabel: (aiActionId: string, state: WritableReviewState) => void
}) {
  const { items, summary } = data
  const showEmpty = items.length === 0
  const reviewedPctLabel =
    summary.reviewed_disagreements_pct === null
      ? '—'
      : `${Math.round(summary.reviewed_disagreements_pct * 100)}%`

  return (
    <div className="space-y-3">
      {/* Top summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <SummaryPill
          label="Needs review"
          count={summary.needs_review}
          tone="slate"
        />
        <SummaryPill
          label="Too strict"
          count={summary.confirmed_guardrail_too_strict}
          tone="amber"
        />
        <SummaryPill
          label="Correct"
          count={summary.confirmed_guardrail_correct}
          tone="green"
        />
        <SummaryPill
          label="Operator too aggressive"
          count={summary.confirmed_operator_error}
          tone="red"
        />
        <SummaryPill
          label="Deferred"
          count={summary.deferred}
          tone="blue"
        />
      </div>
      <div className="text-[10.5px] text-[#64748B]">
        {summary.total_disagreements} disagreement
        {summary.total_disagreements === 1 ? '' : 's'} in window ·{' '}
        {reviewedPctLabel} reviewed ·{' '}
        <span className="text-[#475569]">
          {summary.operator_more_conservative} more-conservative
        </span>{' '}
        ·{' '}
        <span
          className={cn(
            summary.operator_less_conservative > 0
              ? 'text-[#B91C1C]'
              : 'text-[#475569]'
          )}
        >
          {summary.operator_less_conservative} less-conservative
        </span>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold mr-1">
            State
          </span>
          {STATE_FILTERS.map((f) => {
            const active = f.value === stateFilter
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => onStateFilter(f.value)}
                className={cn(
                  'text-[11px] px-2.5 py-1 rounded-full border transition-colors',
                  active
                    ? 'bg-[#0F172A] text-white border-[#0F172A]'
                    : 'border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC]'
                )}
              >
                {f.label}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold mr-1">
            Alignment
          </span>
          {ALIGNMENT_FILTERS.map((f) => {
            const active = f.value === alignmentFilter
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => onAlignmentFilter(f.value)}
                className={cn(
                  'text-[11px] px-2.5 py-1 rounded-full border transition-colors',
                  active
                    ? 'bg-[#1D4ED8] text-white border-[#1D4ED8]'
                    : 'border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC]'
                )}
              >
                {f.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Rows */}
      {showEmpty ? (
        <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B] text-center">
          {summary.total_disagreements === 0
            ? 'No disagreements found in this window. Guardrails and operators are currently aligned.'
            : 'No rows match this review filter.'}
        </div>
      ) : (
        <div className="rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden">
          {items.map((row, i) => (
            <ReviewRow
              key={row.ai_action_id}
              row={row}
              borderTop={i > 0}
              pending={pendingByActionId[row.ai_action_id] ?? false}
              note={noteByActionId[row.ai_action_id] ?? ''}
              onNoteChange={(v) => onNoteChange(row.ai_action_id, v)}
              labelError={labelErrorByActionId[row.ai_action_id] ?? null}
              onLabel={(s) => onLabel(row.ai_action_id, s)}
            />
          ))}
        </div>
      )}

      <p className="text-[11px] text-[#94A3B8] italic">
        These labels do not enable autopilot. They only improve
        future calibration.
      </p>
    </div>
  )
}

function SummaryPill({
  label,
  count,
  tone,
}: {
  label: string
  count: number
  tone: 'green' | 'amber' | 'red' | 'blue' | 'slate'
}) {
  const palette =
    tone === 'green'
      ? 'bg-[#ECFDF5] border-[#A7F3D0] text-[#059669]'
      : tone === 'amber'
        ? 'bg-[#FFFBEB] border-[#FCD9A1] text-[#B45309]'
        : tone === 'red'
          ? 'bg-[#FEF2F2] border-[#FECACA] text-[#B91C1C]'
          : tone === 'blue'
            ? 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]'
            : 'bg-[#F1F5F9] border-[#E2E8F0] text-[#475569]'
  return (
    <div
      className={cn(
        'rounded-xl border px-2.5 py-2 flex flex-col items-start',
        palette
      )}
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em]">
        {label}
      </span>
      <span className="text-[16px] font-semibold text-[#0F172A] mt-0.5 leading-tight">
        {count}
      </span>
    </div>
  )
}

function ReviewRow({
  row,
  borderTop,
  pending,
  note,
  onNoteChange,
  labelError,
  onLabel,
}: {
  row: QueueItem
  borderTop: boolean
  pending: boolean
  note: string
  onNoteChange: (value: string) => void
  labelError: string | null
  onLabel: (state: WritableReviewState) => void
}) {
  return (
    <div
      className={cn(
        'px-4 py-3 flex flex-col gap-2',
        borderTop && 'border-t border-[#F1F5F9]'
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {row.lead_id ? (
              <Link
                href={`/dashboard/leads?lead=${row.lead_id}`}
                className="text-[13px] font-semibold text-[#0F172A] hover:text-[#1D4ED8] truncate"
              >
                {row.lead_name ?? 'Unknown lead'}
              </Link>
            ) : (
              <span className="text-[13px] font-semibold text-[#0F172A] truncate">
                {row.lead_name ?? 'Unknown lead'}
              </span>
            )}
            <AlignmentBadge alignment={row.operator_alignment} />
            <StateBadge state={row.review_state} />
          </div>
          <div className="mt-1 text-[11.5px] text-[#475569] flex items-center gap-1.5 flex-wrap">
            <span>
              Autopilot ·{' '}
              {AUTOPILOT_LABEL[row.autopilot_mode ?? 'review_required']}
            </span>
            <span>·</span>
            <span>
              Operator ·{' '}
              {row.operator_outcome
                ? OUTCOME_LABEL[row.operator_outcome] ??
                  row.operator_outcome
                : 'pending'}
            </span>
            {row.final_confidence !== null && (
              <>
                <span>·</span>
                <span>Confidence {row.final_confidence}</span>
              </>
            )}
            {row.risk_flags.length > 0 && (
              <>
                <span>·</span>
                <span className="text-[#B45309]">
                  {row.risk_flags.join(' / ')} risk
                </span>
              </>
            )}
          </div>
        </div>
        <div className="shrink-0 text-[10.5px] text-[#94A3B8] font-mono text-right">
          {formatDistanceToNow(new Date(row.created_at), {
            addSuffix: true,
          })}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <input
          type="text"
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder="Optional note for this verdict (500 chars max)"
          maxLength={500}
          className="flex-1 text-[11.5px] bg-[#F8FAFC] border border-[#E2E8F0] rounded-md px-2.5 py-1.5 outline-none text-[#0F172A] placeholder:text-[#94A3B8] focus:border-[#1D4ED8] focus:bg-white"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <LabelButton
            onClick={() => onLabel('confirmed_guardrail_too_strict')}
            disabled={pending}
            icon={<ShieldAlert className="w-3 h-3" />}
            tone="amber"
          >
            Guardrail too strict
          </LabelButton>
          <LabelButton
            onClick={() => onLabel('confirmed_guardrail_correct')}
            disabled={pending}
            icon={<ShieldCheck className="w-3 h-3" />}
            tone="green"
          >
            Guardrail correct
          </LabelButton>
          <LabelButton
            onClick={() => onLabel('confirmed_operator_error')}
            disabled={pending}
            icon={<XCircle className="w-3 h-3" />}
            tone="red"
          >
            Operator too aggressive
          </LabelButton>
          <LabelButton
            onClick={() => onLabel('deferred')}
            disabled={pending}
            icon={<Timer className="w-3 h-3" />}
            tone="blue"
          >
            Defer
          </LabelButton>
        </div>
      </div>

      {labelError && (
        <div className="text-[11px] text-[#B91C1C] flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />
          Couldn&apos;t save label: {labelError}
        </div>
      )}
    </div>
  )
}

function LabelButton({
  onClick,
  disabled,
  icon,
  tone,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  icon: React.ReactNode
  tone: 'green' | 'amber' | 'red' | 'blue'
  children: React.ReactNode
}) {
  const palette =
    tone === 'green'
      ? 'border-[#A7F3D0] text-[#059669] hover:bg-[#ECFDF5]'
      : tone === 'amber'
        ? 'border-[#FCD9A1] text-[#B45309] hover:bg-[#FFFBEB]'
        : tone === 'red'
          ? 'border-[#FECACA] text-[#B91C1C] hover:bg-[#FEF2F2]'
          : 'border-[#BFDBFE] text-[#1D4ED8] hover:bg-[#EFF6FF]'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] px-2 py-1 rounded-md border bg-white transition-colors disabled:opacity-50',
        palette
      )}
    >
      {disabled ? <Loader2 className="w-3 h-3 animate-spin" /> : icon}
      {children}
    </button>
  )
}

function AlignmentBadge({ alignment }: { alignment: Alignment }) {
  if (alignment === 'operator_less_conservative') {
    return (
      <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-[0.08em] px-1.5 py-0.5 rounded bg-[#FEF2F2] text-[#B91C1C] border border-[#FECACA]">
        Operator less conservative
      </span>
    )
  }
  if (alignment === 'operator_more_conservative') {
    return (
      <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-[0.08em] px-1.5 py-0.5 rounded bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]">
        Operator more conservative
      </span>
    )
  }
  return null
}

function StateBadge({ state }: { state: ReviewState }) {
  const config =
    state === 'needs_review'
      ? { label: 'Needs review', cls: 'bg-[#F1F5F9] text-[#475569] border-[#E2E8F0]' }
      : state === 'confirmed_guardrail_too_strict'
        ? { label: 'Too strict', cls: 'bg-[#FFFBEB] text-[#B45309] border-[#FCD9A1]' }
        : state === 'confirmed_guardrail_correct'
          ? { label: 'Correct', cls: 'bg-[#ECFDF5] text-[#059669] border-[#A7F3D0]' }
          : state === 'confirmed_operator_error'
            ? { label: 'Operator error', cls: 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]' }
            : { label: 'Deferred', cls: 'bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE]' }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] px-1.5 py-0.5 rounded border',
        config.cls
      )}
    >
      {state === 'confirmed_guardrail_correct' && (
        <CheckCircle2 className="w-3 h-3" />
      )}
      {config.label}
    </span>
  )
}

const AUTOPILOT_LABEL: Record<
  'eligible' | 'review_required' | 'blocked',
  string
> = {
  eligible: 'Eligible',
  review_required: 'Review required',
  blocked: 'Blocked',
}

const OUTCOME_LABEL: Record<string, string> = {
  sent_as_is: 'sent as-is',
  sent_after_edit: 'sent after edit',
  regenerated: 'regenerated',
  abandoned: 'abandoned',
}
