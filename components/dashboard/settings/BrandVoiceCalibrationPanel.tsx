'use client'

import { useEffect, useState } from 'react'
import {
  Gauge,
  Loader2,
  AlertTriangle,
  TrendingDown,
  Activity,
  BookOpen,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardSubtitle,
} from '@/components/dashboard/ui/Card'
import { cn } from '@/lib/utils'

/**
 * Phase 8AW — Brand Voice Calibration panel.
 *
 * Sits above the AIDraftAuditCard on /dashboard/settings/billing.
 * Renders the operator-facing trust signals for AI outreach:
 *
 *   - Low-confidence rate                (tile)
 *   - Average confidence                 (tile)
 *   - Regenerate rate                    (tile)
 *   - Edit-before-send rate              (tile)
 *   - Overconfidence signal              (callout card)
 *   - Needs more venue context signal    (callout card)
 *
 * Data source: the `page_summary` block on `GET /api/admin/ai/draft-
 * audit`. We refetch when the realtime layer fires
 * `venuerise:ai-draft-audit-fired` (same event AIDraftAuditCard
 * listens to) so the panel stays in lockstep with the row list.
 *
 * Copy is intentionally operator-friendly: "Brand Voice
 * Calibration", "Overconfidence signal", "Needs more venue
 * context" — no ML jargon. Empty state nudges first use:
 * "Generate a few AI drafts to start calibrating brand voice
 * confidence."
 *
 * Admin-only (the route enforces requireAdmin); we surface a
 * non-blocking notice if the call 401/403s.
 */

type Signal = 'low' | 'medium' | 'high'
type ContextSignal = 'healthy' | 'needs_more_context'

interface AutopilotBreakdown {
  eligible: number
  review_required: number
  blocked: number
  unknown: number
}

interface PageSummary {
  total: number
  withConfidence: number
  lowConfidence: number
  lowConfidenceRate: number
  avgFinalConfidence: number | null
  avgModelConfidence: number | null
  avgHeuristicConfidence: number | null
  avgAdjustmentDelta: number | null
  sentAsIs: number
  sentAfterEdit: number
  regenerated: number
  unknownOutcome: number
  lowConfidenceSentRate: number | null
  overconfidenceSignal: Signal
  knowledgeContextSignal: ContextSignal
}

type PanelState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      summary: PageSummary
      // Phase 8AX — autopilot breakdown over the same page slice.
      // Null when the server build pre-dates 8AX (defensive: keeps
      // the panel rendering instead of erroring on missing field).
      autopilot: AutopilotBreakdown | null
    }

const REALTIME_EVENT = 'venuerise:ai-draft-audit-fired'

interface BrandVoiceCalibrationPanelProps {
  venueId: string
}

export default function BrandVoiceCalibrationPanel({
  venueId,
}: BrandVoiceCalibrationPanelProps) {
  const [state, setState] = useState<PanelState>({ kind: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)

  // Refetch on realtime fire so the panel matches what the operator
  // sees in the row list below. Same listener AIDraftAuditCard uses.
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
    params.set('status', 'all')
    params.set('limit', '100')
    ;(async () => {
      try {
        const res = await fetch(
          `/api/admin/ai/draft-audit?${params.toString()}`,
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
        const body = (await res.json()) as {
          page_summary?: PageSummary
          autopilot_breakdown?: AutopilotBreakdown
        }
        if (!body.page_summary) {
          setState({
            kind: 'error',
            message: 'No calibration data returned.',
          })
          return
        }
        setState({
          kind: 'ready',
          summary: body.page_summary,
          autopilot: body.autopilot_breakdown ?? null,
        })
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
          <CardTitle>Brand Voice Calibration</CardTitle>
          <CardSubtitle>
            How trustworthy AI drafts have been for this venue
            recently. Refreshed automatically as new drafts run.
          </CardSubtitle>
        </div>
        <div className="shrink-0 w-9 h-9 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center">
          <Gauge className="w-4 h-4 text-[#1D4ED8]" />
        </div>
      </CardHeader>
      <CardContent>
        {state.kind === 'loading' && (
          <div className="flex items-center gap-2 text-[12.5px] text-[#475569] py-3">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading calibration…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2.5 text-[12px] text-[#B91C1C] flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p>
                Couldn&apos;t load Brand Voice calibration: {state.message}
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

        {state.kind === 'ready' && (
          <Summary summary={state.summary} autopilot={state.autopilot} />
        )}
      </CardContent>
    </Card>
  )
}

function Summary({
  summary,
  autopilot,
}: {
  summary: PageSummary
  autopilot: AutopilotBreakdown | null
}) {
  // Empty state: route returned no rows in scope. We still have a
  // valid PageSummary, but every tile would render "—" so swap to a
  // nudge that points the operator at the regenerate flow.
  if (summary.total === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-5 text-[12.5px] text-[#64748B] text-center">
        Generate a few AI drafts to start calibrating brand voice
        confidence. Use Regenerate in the lead detail drawer.
      </div>
    )
  }

  // Outcome decisions = the rows we actually observed an operator
  // act on (sent / regenerated). `unknownOutcome` is excluded from
  // the denominators because it represents "haven't seen yet."
  const decided = summary.sentAsIs + summary.sentAfterEdit + summary.regenerated
  const regenerateRate = decided === 0 ? null : summary.regenerated / decided
  const editRate = decided === 0 ? null : summary.sentAfterEdit / decided

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Tile
          label="Low-confidence rate"
          value={formatPct(summary.lowConfidenceRate)}
          hint={`${summary.lowConfidence} of ${summary.withConfidence} scored`}
        />
        <Tile
          label="Avg confidence"
          value={
            summary.avgFinalConfidence === null
              ? '—'
              : `${summary.avgFinalConfidence}`
          }
          hint={
            summary.avgModelConfidence !== null &&
            summary.avgHeuristicConfidence !== null
              ? `Model ${summary.avgModelConfidence} · Heuristic ${summary.avgHeuristicConfidence}`
              : 'Final score, 0–100'
          }
        />
        <Tile
          label="Regenerate rate"
          value={regenerateRate === null ? '—' : formatPct(regenerateRate)}
          hint={
            decided === 0
              ? 'No decisions yet'
              : `${summary.regenerated} of ${decided} decided`
          }
        />
        <Tile
          label="Edit-before-send"
          value={editRate === null ? '—' : formatPct(editRate)}
          hint={
            decided === 0
              ? 'No sends yet'
              : `${summary.sentAfterEdit} of ${decided} decided`
          }
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <OverconfidenceCard
          signal={summary.overconfidenceSignal}
          avgDelta={summary.avgAdjustmentDelta}
          regeneratedShare={regenerateRate}
        />
        <ContextCard signal={summary.knowledgeContextSignal} />
      </div>

      {autopilot && <AutopilotReadinessCard autopilot={autopilot} />}
    </div>
  )
}

/**
 * Phase 8AX — autopilot readiness breakdown. Lives below the
 * overconfidence + context cards so the operator sees the
 * trustworthiness layer first, then the "what would have
 * happened" layer. The copy is deliberate: "does not enable
 * autonomous sending" so nobody misreads the bars as a flip-the-
 * switch promise.
 */
function AutopilotReadinessCard({
  autopilot,
}: {
  autopilot: AutopilotBreakdown
}) {
  const scored =
    autopilot.eligible + autopilot.review_required + autopilot.blocked
  const total = scored + autopilot.unknown
  if (total === 0) {
    return (
      <div className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
          Autopilot readiness
        </div>
        <div className="mt-1 text-[12px] text-[#64748B]">
          No drafts in scope. This does not enable autonomous
          sending — it shows how often drafts would qualify under
          current guardrails.
        </div>
      </div>
    )
  }
  // Percentage denominators are intentionally `scored` (not
  // `total`): autopilot rates communicate readiness AMONG drafts
  // we could classify. The `unknown` bucket renders as a separate
  // muted line so the operator knows how much of the page is
  // pre-8AX data they shouldn't read into.
  const eligiblePct =
    scored === 0 ? 0 : Math.round((autopilot.eligible / scored) * 100)
  const reviewPct =
    scored === 0 ? 0 : Math.round((autopilot.review_required / scored) * 100)
  const blockedPct =
    scored === 0 ? 0 : Math.round((autopilot.blocked / scored) * 100)
  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
            Autopilot readiness
          </div>
          <div className="mt-0.5 text-[11.5px] text-[#475569] leading-snug">
            This does not enable autonomous sending. It shows how
            often drafts would qualify under current guardrails.
          </div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2.5">
        <BreakdownPill
          label="Eligible"
          count={autopilot.eligible}
          pct={eligiblePct}
          tone="green"
        />
        <BreakdownPill
          label="Review required"
          count={autopilot.review_required}
          pct={reviewPct}
          tone="amber"
        />
        <BreakdownPill
          label="Blocked"
          count={autopilot.blocked}
          pct={blockedPct}
          tone="red"
        />
      </div>
      {autopilot.unknown > 0 && (
        <div className="mt-2 text-[10.5px] text-[#94A3B8]">
          {autopilot.unknown} pre-8AX row{autopilot.unknown === 1 ? '' : 's'}{' '}
          excluded — older data without an autopilot decision.
        </div>
      )}
    </div>
  )
}

function BreakdownPill({
  label,
  count,
  pct,
  tone,
}: {
  label: string
  count: number
  pct: number
  tone: 'green' | 'amber' | 'red'
}) {
  const palette =
    tone === 'green'
      ? {
          bg: 'bg-[#ECFDF5]',
          border: 'border-[#A7F3D0]',
          text: 'text-[#059669]',
        }
      : tone === 'amber'
        ? {
            bg: 'bg-[#FFFBEB]',
            border: 'border-[#FCD9A1]',
            text: 'text-[#B45309]',
          }
        : {
            bg: 'bg-[#FEF2F2]',
            border: 'border-[#FECACA]',
            text: 'text-[#B91C1C]',
          }
  return (
    <div className={cn('rounded-lg border px-2.5 py-2', palette.bg, palette.border)}>
      <div className={cn('text-[10.5px] font-semibold uppercase tracking-[0.08em]', palette.text)}>
        {label}
      </div>
      <div className="mt-0.5 text-[16px] font-semibold text-[#0F172A] leading-tight">
        {pct}%
      </div>
      <div className="text-[10.5px] text-[#64748B] mt-0.5">
        {count} draft{count === 1 ? '' : 's'}
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
        {label}
      </div>
      <div className="mt-0.5 text-[18px] font-semibold text-[#0F172A] leading-tight">
        {value}
      </div>
      <div className="mt-1 text-[10.5px] text-[#94A3B8]">{hint}</div>
    </div>
  )
}

function OverconfidenceCard({
  signal,
  avgDelta,
  regeneratedShare,
}: {
  signal: Signal
  avgDelta: number | null
  regeneratedShare: number | null
}) {
  const style = OVERCONFIDENCE_STYLE[signal]
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
        <TrendingDown className={cn('w-3.5 h-3.5', style.iconColor)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
          Overconfidence signal
        </div>
        <div className={cn('mt-0.5 text-[13px] font-semibold', style.text)}>
          {style.label}
        </div>
        <div className="mt-1 text-[11.5px] text-[#475569] leading-snug">
          {style.copy}
          {avgDelta !== null && (
            <span className="text-[#64748B]">
              {' '}
              Avg adjustment {avgDelta > 0 ? '+' : ''}
              {avgDelta}.
            </span>
          )}
          {regeneratedShare !== null && regeneratedShare > 0 && (
            <span className="text-[#64748B]">
              {' '}
              Regenerate share {formatPct(regeneratedShare)}.
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function ContextCard({ signal }: { signal: ContextSignal }) {
  const healthy = signal === 'healthy'
  return (
    <div
      className={cn(
        'rounded-xl border px-3 py-2.5 flex items-start gap-2.5',
        healthy
          ? 'bg-white border-[#E2E8F0]'
          : 'bg-[#FFFBEB] border-[#FCD9A1]'
      )}
    >
      <div
        className={cn(
          'shrink-0 w-7 h-7 rounded-lg flex items-center justify-center',
          healthy ? 'bg-[#F1F5F9]' : 'bg-[#FEF3C7]'
        )}
      >
        {healthy ? (
          <Activity className="w-3.5 h-3.5 text-[#475569]" />
        ) : (
          <BookOpen className="w-3.5 h-3.5 text-[#B45309]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
          Venue context
        </div>
        <div
          className={cn(
            'mt-0.5 text-[13px] font-semibold',
            healthy ? 'text-[#0F172A]' : 'text-[#92400E]'
          )}
        >
          {healthy ? 'Healthy' : 'Needs more venue context'}
        </div>
        <div className="mt-1 text-[11.5px] text-[#475569] leading-snug">
          {healthy
            ? "Drafts aren't repeatedly asking for venue facts. Brand voice has enough to work with."
            : 'Recent drafts kept asking for pricing, availability, or policies. Adding these to your venue settings will lift confidence.'}
        </div>
      </div>
    </div>
  )
}

const OVERCONFIDENCE_STYLE: Record<
  Signal,
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
  low: {
    label: 'Low',
    copy: 'Model self-rating matches what the heuristic sees. Approve & send with normal review.',
    bg: 'bg-white',
    border: 'border-[#E2E8F0]',
    iconBg: 'bg-[#ECFDF5]',
    iconColor: 'text-[#059669]',
    text: 'text-[#0F172A]',
  },
  medium: {
    label: 'Watch',
    copy: 'Model is rating itself a little higher than the text reads. Skim drafts before sending.',
    bg: 'bg-[#FFFBEB]',
    border: 'border-[#FCD9A1]',
    iconBg: 'bg-[#FEF3C7]',
    iconColor: 'text-[#B45309]',
    text: 'text-[#92400E]',
  },
  high: {
    label: 'High',
    copy: 'Model is consistently inflating confidence or operators are regenerating frequently. Treat AI drafts as drafts only.',
    bg: 'bg-[#FEF2F2]',
    border: 'border-[#FECACA]',
    iconBg: 'bg-[#FEE2E2]',
    iconColor: 'text-[#B91C1C]',
    text: 'text-[#7F1D1D]',
  },
}

function formatPct(rate: number): string {
  if (!Number.isFinite(rate)) return '—'
  const pct = Math.round(rate * 100)
  return `${pct}%`
}
