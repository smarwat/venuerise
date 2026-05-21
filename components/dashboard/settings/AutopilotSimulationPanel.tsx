'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  Clock,
  Loader2,
  ShieldCheck,
  Sparkles,
  TimerReset,
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
 * Phase 8AY — Autopilot Simulation panel.
 *
 * Sits between BrandVoiceCalibrationPanel and AIDraftAuditCard on
 * /dashboard/settings/billing. Answers the question:
 *
 *   "If we turned autopilot on tomorrow, would it have been safe
 *    for the last 30 days?"
 *
 * The panel renders four tiles (would_send / review / would_block
 * / time saved), a readiness card with three states, a bucket
 * section showing per-autopilot-mode operator outcomes, and a
 * recent-mismatches list deep-linking to the lead drawer for any
 * row where the operator and autopilot disagreed.
 *
 * Data: /api/admin/ai/autopilot-simulation. Window default 30
 * days; the panel doesn't expose the slider for now (the spec
 * keeps this surface read-only and operator-friendly — a future
 * phase can add the window control if there's demand).
 *
 * Refreshes on the same `venuerise:ai-draft-audit-fired` event
 * the calibration panel + audit card listen to, so new drafts
 * land here without a manual reload.
 *
 * Critical: every copy line on this card reinforces that the
 * simulation does NOT enable autonomous sending. Operator
 * approval remains mandatory.
 */

type SimulationMode = 'would_send' | 'would_require_review' | 'would_block'
type Alignment =
  | 'aligned'
  | 'operator_more_conservative'
  | 'operator_less_conservative'
  | 'unknown'
type Readiness = 'not_ready' | 'watch' | 'promising'

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

interface SimulationSummary {
  total_scored: number
  would_send: number
  would_require_review: number
  would_block: number
  eligible_sent_as_is: number
  blocked_sent_as_is: number
  review_required_edited_or_regenerated: number
  aligned: number
  operator_more_conservative: number
  operator_less_conservative: number
  unknown: number
  estimated_minutes_saved: number
  readiness: Readiness
  // Phase 8AZ — review-aware extension. Optional so the panel
  // renders gracefully against a server build that pre-dates 8AZ
  // (every count just falls back to 0 / empty array).
  reviewed_disagreements_pct?: number | null
  needs_review_count?: number
  confirmed_guardrail_too_strict?: number
  confirmed_guardrail_correct?: number
  confirmed_operator_error?: number
  deferred?: number
  rule_signals?: RuleSignal[]
}

interface BucketCounts {
  total: number
  sent_as_is: number
  sent_after_edit: number
  regenerated: number
  rejected: number
  unknown: number
}

interface RecentRow {
  ai_action_id: string
  lead_id: string | null
  lead_name: string | null
  created_at: string
  autopilot_mode: 'eligible' | 'review_required' | 'blocked' | null
  operator_outcome: string | null
  edit_distance_bucket: string | null
  final_confidence: number | null
  simulation_mode: SimulationMode
  operator_alignment: Alignment
}

interface SimulationResponse {
  venue_id: string
  window_days: number
  summary: SimulationSummary
  buckets: {
    eligible: BucketCounts
    review_required: BucketCounts
    blocked: BucketCounts
  }
  recent_rows: RecentRow[]
}

type PanelState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: SimulationResponse }

const REALTIME_EVENT = 'venuerise:ai-draft-audit-fired'

interface AutopilotSimulationPanelProps {
  venueId: string
}

export default function AutopilotSimulationPanel({
  venueId,
}: AutopilotSimulationPanelProps) {
  const [state, setState] = useState<PanelState>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onFire = () => setReloadTick((n) => n + 1)
    window.addEventListener(REALTIME_EVENT, onFire)
    return () => window.removeEventListener(REALTIME_EVENT, onFire)
  }, [])

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    const params = new URLSearchParams()
    params.set('venue_id', venueId)
    // Default 30-day window. Surfaced in copy so the operator
    // knows what they're looking at.
    params.set('days', '30')
    ;(async () => {
      try {
        const res = await fetch(
          `/api/admin/ai/autopilot-simulation?${params.toString()}`,
          { credentials: 'same-origin' }
        )
        if (cancelled) return
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
        const body = (await res.json()) as SimulationResponse
        setState({ kind: 'ready', data: body })
      } catch (err) {
        if (cancelled) return
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [venueId, reloadTick])

  return (
    <Card>
      <CardHeader>
        <div>
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#64748B]">
            Autopilot simulation
          </div>
          <CardTitle>Would the AI have been safe to send?</CardTitle>
          <CardSubtitle>
            Simulation only. No autonomous messages are sent.
          </CardSubtitle>
        </div>
        <div className="shrink-0 w-9 h-9 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center">
          <ShieldCheck className="w-4 h-4 text-[#1D4ED8]" />
        </div>
      </CardHeader>
      <CardContent>
        {state.kind === 'loading' && (
          <div className="flex items-center gap-2 text-[12.5px] text-[#475569] py-3">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading simulation…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2.5 text-[12px] text-[#B91C1C] flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p>
                Couldn&apos;t load autopilot simulation: {state.message}
              </p>
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

        {state.kind === 'ready' && <SimulationBody data={state.data} />}
      </CardContent>
    </Card>
  )
}

function SimulationBody({ data }: { data: SimulationResponse }) {
  const { summary, buckets, recent_rows, window_days } = data
  // Empty state. The summary's `total_scored` counts rows with
  // BOTH autopilot mode AND operator outcome — i.e. rows that
  // could legally contribute to readiness. If that's zero, the
  // panel nudges the operator toward regenerate + approve.
  if (summary.total_scored === 0 && summary.unknown === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B] text-center">
        No simulation data yet. Regenerate and approve a few drafts
        to build a safety profile.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Tile
          label="Would send"
          value={String(summary.would_send)}
          hint={hintFromCount(summary.would_send, summary.total_scored)}
          icon={<Sparkles className="w-3.5 h-3.5 text-[#059669]" />}
          tone="green"
        />
        <Tile
          label="Review required"
          value={String(summary.would_require_review)}
          hint={hintFromCount(
            summary.would_require_review,
            summary.total_scored
          )}
          icon={<TimerReset className="w-3.5 h-3.5 text-[#B45309]" />}
          tone="amber"
        />
        <Tile
          label="Would block"
          value={String(summary.would_block)}
          hint={hintFromCount(summary.would_block, summary.total_scored)}
          icon={<AlertTriangle className="w-3.5 h-3.5 text-[#B91C1C]" />}
          tone="red"
        />
        <Tile
          label="Estimated time saved"
          value={
            summary.estimated_minutes_saved > 0
              ? `${summary.estimated_minutes_saved}m`
              : '—'
          }
          hint={`Last ${window_days} days`}
          icon={<Clock className="w-3.5 h-3.5 text-[#1D4ED8]" />}
          tone="blue"
        />
      </div>

      <ReadinessCard readiness={summary.readiness} summary={summary} />

      {/* Phase 8BA — pointer to the dedicated scorecard above.
          The full gate checklist lives on AutopilotReadinessScorecard;
          we deliberately don't duplicate it here so the two
          surfaces can't disagree. */}
      <p className="text-[11px] text-[#94A3B8] italic">
        Readiness gate: see the Autopilot Readiness Scorecard
        above for the full eligibility checklist.
      </p>

      <RuleSignalsCard
        ruleSignals={summary.rule_signals ?? []}
        reviewedPct={summary.reviewed_disagreements_pct ?? null}
      />

      <BucketSection buckets={buckets} />

      {recent_rows.length > 0 && <MismatchList rows={recent_rows} />}

      <p className="text-[11px] text-[#94A3B8] italic">
        Window: last {window_days} days. {summary.total_scored} draft
        {summary.total_scored === 1 ? '' : 's'} scored,{' '}
        {summary.unknown} pending operator outcome. This panel is
        observation only — operator approval is still required.
      </p>
    </div>
  )
}

function Tile({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string
  value: string
  hint: string
  icon: React.ReactNode
  tone: 'green' | 'amber' | 'red' | 'blue'
}) {
  const palette =
    tone === 'green'
      ? 'bg-[#ECFDF5] border-[#A7F3D0]'
      : tone === 'amber'
        ? 'bg-[#FFFBEB] border-[#FCD9A1]'
        : tone === 'red'
          ? 'bg-[#FEF2F2] border-[#FECACA]'
          : 'bg-[#EFF6FF] border-[#BFDBFE]'
  return (
    <div className={cn('rounded-xl border px-3 py-2.5', palette)}>
      <div className="flex items-center gap-1.5">
        {icon}
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
          {label}
        </div>
      </div>
      <div className="mt-0.5 text-[18px] font-semibold text-[#0F172A] leading-tight">
        {value}
      </div>
      <div className="mt-1 text-[10.5px] text-[#94A3B8]">{hint}</div>
    </div>
  )
}

function ReadinessCard({
  readiness,
  summary,
}: {
  readiness: Readiness
  summary: SimulationSummary
}) {
  const style = READINESS_STYLE[readiness]
  return (
    <div
      className={cn(
        'rounded-xl border px-3 py-2.5 flex items-start gap-2.5',
        style.bg,
        style.border
      )}
    >
      <div
        className={cn(
          'shrink-0 w-7 h-7 rounded-lg flex items-center justify-center',
          style.iconBg
        )}
      >
        <ShieldCheck className={cn('w-3.5 h-3.5', style.iconColor)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
          Autopilot readiness
        </div>
        <div className={cn('mt-0.5 text-[13px] font-semibold', style.text)}>
          {style.label}
        </div>
        <div className="mt-1 text-[11.5px] text-[#475569] leading-snug">
          {style.copy}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10.5px] text-[#64748B]">
          <span>
            Aligned <span className="font-semibold text-[#0F172A]">{summary.aligned}</span>
          </span>
          <span>·</span>
          <span>
            Operator more conservative{' '}
            <span className="font-semibold text-[#0F172A]">
              {summary.operator_more_conservative}
            </span>
          </span>
          <span>·</span>
          <span>
            Operator less conservative{' '}
            <span
              className={cn(
                'font-semibold',
                summary.operator_less_conservative > 0
                  ? 'text-[#B91C1C]'
                  : 'text-[#0F172A]'
              )}
            >
              {summary.operator_less_conservative}
            </span>
          </span>
        </div>
      </div>
    </div>
  )
}

const READINESS_STYLE: Record<
  Readiness,
  {
    label: string
    copy: string
    bg: string
    border: string
    iconBg: string
    iconColor: string
    text: string
  }
> = {
  promising: {
    label: 'Promising',
    copy: 'Guardrails are trending toward safe autonomy, but approval is still required.',
    bg: 'bg-[#ECFDF5]',
    border: 'border-[#A7F3D0]',
    iconBg: 'bg-[#D1FAE5]',
    iconColor: 'text-[#059669]',
    text: 'text-[#065F46]',
  },
  watch: {
    label: 'Watch',
    copy: 'More operator outcomes are needed before autonomy should be considered.',
    bg: 'bg-[#FFFBEB]',
    border: 'border-[#FCD9A1]',
    iconBg: 'bg-[#FEF3C7]',
    iconColor: 'text-[#B45309]',
    text: 'text-[#92400E]',
  },
  not_ready: {
    label: 'Not ready',
    copy: 'Keep approval mode on. The system needs more calibration data.',
    bg: 'bg-[#F8FAFC]',
    border: 'border-[#E2E8F0]',
    iconBg: 'bg-[#F1F5F9]',
    iconColor: 'text-[#475569]',
    text: 'text-[#0F172A]',
  },
}

function BucketSection({
  buckets,
}: {
  buckets: SimulationResponse['buckets']
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
      <BucketCard
        label="Eligible drafts"
        bucket={buckets.eligible}
        tone="green"
      />
      <BucketCard
        label="Review-required drafts"
        bucket={buckets.review_required}
        tone="amber"
      />
      <BucketCard
        label="Blocked drafts"
        bucket={buckets.blocked}
        tone="red"
        flagSentAsIs
      />
    </div>
  )
}

function BucketCard({
  label,
  bucket,
  tone,
  flagSentAsIs = false,
}: {
  label: string
  bucket: BucketCounts
  tone: 'green' | 'amber' | 'red'
  // Highlight `sent_as_is` in red when this is the Blocked bucket
  // — those are the dangerous false-positives (operator overrode
  // a guardrail block by sending as-is).
  flagSentAsIs?: boolean
}) {
  const palette =
    tone === 'green'
      ? 'border-[#A7F3D0]'
      : tone === 'amber'
        ? 'border-[#FCD9A1]'
        : 'border-[#FECACA]'
  return (
    <div className={cn('rounded-xl border bg-white px-3 py-2.5', palette)}>
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
        {label}
      </div>
      <div className="mt-0.5 text-[16px] font-semibold text-[#0F172A] leading-tight">
        {bucket.total}
      </div>
      <ul className="mt-2 space-y-0.5 text-[11px] text-[#475569]">
        <li
          className={cn(
            'flex items-center justify-between',
            flagSentAsIs && bucket.sent_as_is > 0 && 'text-[#B91C1C]'
          )}
        >
          <span>Sent as-is</span>
          <span className="font-semibold">{bucket.sent_as_is}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>Edited</span>
          <span className="font-semibold">{bucket.sent_after_edit}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>Regenerated</span>
          <span className="font-semibold">{bucket.regenerated}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>Rejected</span>
          <span className="font-semibold">{bucket.rejected}</span>
        </li>
        <li className="flex items-center justify-between text-[#94A3B8]">
          <span>Pending</span>
          <span className="font-semibold">{bucket.unknown}</span>
        </li>
      </ul>
    </div>
  )
}

function MismatchList({ rows }: { rows: RecentRow[] }) {
  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5">
      <div className="flex items-center justify-between">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
          Recent mismatches
        </div>
        <div className="text-[10.5px] text-[#94A3B8]">
          autopilot vs operator
        </div>
      </div>
      <ul className="mt-2 divide-y divide-[#F1F5F9]">
        {rows.map((r) => (
          <li key={r.ai_action_id} className="py-2 flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {r.lead_id ? (
                  <Link
                    href={`/dashboard/leads?lead=${r.lead_id}`}
                    className="text-[12.5px] font-semibold text-[#0F172A] hover:text-[#1D4ED8] truncate"
                  >
                    {r.lead_name ?? 'Unknown lead'}
                  </Link>
                ) : (
                  <span className="text-[12.5px] font-semibold text-[#0F172A] truncate">
                    {r.lead_name ?? 'Unknown lead'}
                  </span>
                )}
                <span
                  className={cn(
                    'text-[10px] font-semibold uppercase tracking-[0.08em] px-1.5 py-0.5 rounded',
                    r.operator_alignment === 'operator_less_conservative'
                      ? 'bg-[#FEF2F2] text-[#B91C1C] border border-[#FECACA]'
                      : 'bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]'
                  )}
                >
                  {r.operator_alignment === 'operator_less_conservative'
                    ? 'Operator less conservative'
                    : 'Operator more conservative'}
                </span>
              </div>
              <div className="mt-0.5 text-[10.5px] text-[#64748B] flex items-center gap-1.5 flex-wrap">
                <span>Autopilot · {AUTOPILOT_LABEL[r.autopilot_mode ?? 'review_required']}</span>
                <span>·</span>
                <span>
                  Operator ·{' '}
                  {r.operator_outcome
                    ? OUTCOME_LABEL[
                        r.operator_outcome as keyof typeof OUTCOME_LABEL
                      ] ?? r.operator_outcome
                    : 'pending'}
                </span>
                {r.final_confidence !== null && (
                  <>
                    <span>·</span>
                    <span>Confidence {r.final_confidence}</span>
                  </>
                )}
              </div>
            </div>
            <div className="shrink-0 text-[10.5px] text-[#94A3B8] font-mono">
              {formatDistanceToNow(new Date(r.created_at), {
                addSuffix: true,
              })}
            </div>
          </li>
        ))}
      </ul>
    </div>
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

function hintFromCount(n: number, total: number): string {
  if (total === 0) return '0% of scored'
  const pct = Math.round((n / total) * 100)
  return `${pct}% of scored`
}

/**
 * Phase 8AZ — per-rule signal card. Renders the top 5 guardrail
 * rules by reviewed count, with their false-positive rate. Empty
 * state nudges the operator toward the review queue below.
 *
 * `falsePositiveRate` is `confirmed_guardrail_too_strict /
 * reviewed` — i.e. of the labeled disagreements that fired this
 * rule, how often did the operator say the rule was wrong.
 * `null` when nothing reviewed yet.
 */
function RuleSignalsCard({
  ruleSignals,
  reviewedPct,
}: {
  ruleSignals: RuleSignal[]
  reviewedPct: number | null
}) {
  const topReviewed = [...ruleSignals]
    .filter((r) => r.reviewed > 0)
    .sort((a, b) => b.reviewed - a.reviewed)
    .slice(0, 5)
  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5">
      <div className="flex items-center justify-between">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
          Guardrail rule signals
        </div>
        {reviewedPct !== null && (
          <div className="text-[10.5px] text-[#94A3B8]">
            {Math.round(reviewedPct * 100)}% of disagreements reviewed
          </div>
        )}
      </div>
      {topReviewed.length === 0 ? (
        <div className="mt-2 text-[11.5px] text-[#64748B]">
          No reviewed rule-level signals yet. Label disagreements
          below to build this profile.
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-[#F1F5F9]">
          {topReviewed.map((r) => {
            const fpRate =
              r.falsePositiveRate === null
                ? '—'
                : `${Math.round(r.falsePositiveRate * 100)}% false positive`
            const fpColor =
              r.falsePositiveRate !== null && r.falsePositiveRate >= 0.5
                ? 'text-[#B91C1C]'
                : r.falsePositiveRate !== null && r.falsePositiveRate >= 0.25
                  ? 'text-[#B45309]'
                  : 'text-[#475569]'
            return (
              <li
                key={r.rule}
                className="py-1.5 flex items-center justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold text-[#0F172A] capitalize">
                    {r.rule} risk
                  </div>
                  <div className="text-[10.5px] text-[#64748B]">
                    {r.reviewed} reviewed · {r.confirmedTooStrict} too strict
                    · {r.confirmedCorrect} correct
                  </div>
                </div>
                <div className={cn('text-[11.5px] font-semibold', fpColor)}>
                  {fpRate}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
