'use client'

import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Loader2,
  ShieldCheck,
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

/**
 * Phase 8BA — Autopilot Readiness Scorecard.
 *
 * Sits ABOVE AutopilotSimulationPanel on
 * /dashboard/settings/billing. Renders the venue's
 * gate-by-gate readiness verdict so an operator can see, at a
 * glance, whether the venue would even be ELIGIBLE to opt in
 * to a future autopilot phase.
 *
 * Critical safety posture (these lines are part of the
 * contract, not decoration):
 *   - "Autonomous sending is still disabled" appears on every
 *     state of this card, including `eligible`.
 *   - There is no toggle. There is no "Enable autopilot"
 *     button anywhere in this component. Don't add one.
 *   - The footer copy reinforces the read-only nature of the
 *     card on every render.
 *
 * Data source: GET /api/admin/ai/autopilot-readiness (default
 * 30-day window). Refetches on the realtime event the
 * simulation + audit panels listen to so the scorecard stays
 * in lockstep with new drafts + labels.
 */

type Verdict = 'not_eligible' | 'watch' | 'eligible'

interface ReadinessGate {
  key: string
  label: string
  passed: boolean
  currentValue: number | string | null
  threshold: number | string
  severity: 'blocking' | 'warning'
  nextStep: string | null
}

interface AutonomyReadiness {
  verdict: Verdict
  eligible: boolean
  reasons: string[]
  caveats: string[]
  gates: ReadinessGate[]
}

interface ReadinessResponse {
  venue_id: string
  window_days: number
  readiness: AutonomyReadiness
  inputs: {
    simulation_readiness: 'not_ready' | 'watch' | 'promising'
    total_scored: number
    reviewed_disagreements_pct: number | null
    max_rule_false_positive_rate: number | null
    operator_less_conservative_unreviewed: number
    window_days_with_data: number
  }
  generated_at: string
}

type CardState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: ReadinessResponse }

const REALTIME_EVENT = 'venuerise:ai-draft-audit-fired'

interface AutopilotReadinessScorecardProps {
  venueId: string
}

export default function AutopilotReadinessScorecard({
  venueId,
}: AutopilotReadinessScorecardProps) {
  const [state, setState] = useState<CardState>({ kind: 'loading' })
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
    params.set('days', '30')
    ;(async () => {
      try {
        const res = await fetch(
          `/api/admin/ai/autopilot-readiness?${params.toString()}`,
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
        const body = (await res.json()) as ReadinessResponse
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
            Autopilot readiness
          </div>
          <CardTitle>
            {state.kind === 'ready'
              ? TITLE_BY_VERDICT[state.data.readiness.verdict]
              : 'Autopilot readiness scorecard'}
          </CardTitle>
          <CardSubtitle>
            Autonomous sending is still disabled. This scorecard
            only measures whether a future opt-in could be
            considered.
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
            Loading readiness scorecard…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2.5 text-[12px] text-[#B91C1C] flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p>Couldn&apos;t load readiness scorecard: {state.message}</p>
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

        {state.kind === 'ready' && <ScorecardBody data={state.data} />}
      </CardContent>
    </Card>
  )
}

function ScorecardBody({ data }: { data: ReadinessResponse }) {
  const { readiness, inputs, window_days } = data
  // Empty state: zero scored drafts means the simulation
  // window doesn't yet have any rows the helper could
  // legitimately read. We render the verdict + gate list
  // anyway (every gate will be failing) but lead with a copy
  // line that nudges the operator toward the right action.
  const isEmpty = inputs.total_scored === 0

  return (
    <div className="space-y-3">
      <VerdictBanner verdict={readiness.verdict} />

      {isEmpty && (
        <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-4 text-[12.5px] text-[#64748B] text-center">
          No scored drafts yet. Regenerate and review drafts first.
        </div>
      )}

      {readiness.reasons.length > 0 && (
        <ul className="space-y-1.5">
          {readiness.reasons.map((r, i) => (
            <li
              key={i}
              className="text-[12px] text-[#475569] flex items-start gap-2"
            >
              <span className="mt-0.5 text-[#94A3B8]">·</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-xl border border-[#E2E8F0] bg-white">
        <div className="px-3 py-2 border-b border-[#F1F5F9] flex items-center justify-between">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
            Readiness gates
          </div>
          <div className="text-[10.5px] text-[#94A3B8]">
            Window: last {window_days} days
          </div>
        </div>
        <ul className="divide-y divide-[#F1F5F9]">
          {readiness.gates.map((g) => (
            <GateRow key={g.key} gate={g} />
          ))}
        </ul>
      </div>

      {readiness.caveats.length > 0 && (
        <div className="rounded-xl border border-[#A7F3D0] bg-[#ECFDF5] px-3 py-2.5">
          <div className="flex items-start gap-2">
            <ShieldCheck className="w-3.5 h-3.5 text-[#059669] mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0 space-y-1">
              {readiness.caveats.map((c, i) => (
                <p key={i} className="text-[11.5px] text-[#065F46] leading-snug">
                  {c}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}

      <p className="text-[11px] text-[#94A3B8] italic">
        No messages are sent automatically. This scorecard cannot
        enable autopilot.
      </p>
    </div>
  )
}

function VerdictBanner({ verdict }: { verdict: Verdict }) {
  const style = VERDICT_STYLE[verdict]
  return (
    <div
      className={cn(
        'rounded-xl border px-3 py-3 flex items-start gap-3',
        style.bg,
        style.border
      )}
    >
      <div
        className={cn(
          'shrink-0 w-9 h-9 rounded-lg flex items-center justify-center',
          style.iconBg
        )}
      >
        {verdict === 'eligible' ? (
          <CheckCircle2 className={cn('w-5 h-5', style.iconColor)} />
        ) : verdict === 'watch' ? (
          <AlertTriangle className={cn('w-5 h-5', style.iconColor)} />
        ) : (
          <XCircle className={cn('w-5 h-5', style.iconColor)} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            'text-[10.5px] font-semibold uppercase tracking-[0.14em]',
            style.label
          )}
        >
          {LABEL_BY_VERDICT[verdict]}
        </div>
        <div className={cn('text-[14px] font-semibold mt-0.5', style.text)}>
          {TITLE_BY_VERDICT[verdict]}
        </div>
        <p className={cn('text-[11.5px] mt-1 leading-snug', style.text)}>
          {EXPLAIN_BY_VERDICT[verdict]}
        </p>
      </div>
    </div>
  )
}

function GateRow({ gate }: { gate: ReadinessGate }) {
  return (
    <li className="px-3 py-2.5 flex items-start gap-3">
      <div className="shrink-0 mt-0.5">
        {gate.passed ? (
          <CheckCircle2 className="w-4 h-4 text-[#059669]" />
        ) : gate.severity === 'blocking' ? (
          <XCircle className="w-4 h-4 text-[#B91C1C]" />
        ) : (
          <AlertTriangle className="w-4 h-4 text-[#B45309]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={cn(
              'text-[12.5px] font-semibold',
              gate.passed ? 'text-[#0F172A]' : 'text-[#0F172A]'
            )}
          >
            {gate.label}
          </span>
          {!gate.passed && (
            <span
              className={cn(
                'text-[9.5px] font-semibold uppercase tracking-[0.08em] px-1.5 py-0.5 rounded border',
                gate.severity === 'blocking'
                  ? 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]'
                  : 'bg-[#FFFBEB] text-[#B45309] border-[#FCD9A1]'
              )}
            >
              {gate.severity === 'blocking' ? 'Blocking' : 'Warning'}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-[#64748B] flex items-center gap-1.5 flex-wrap">
          <span>
            Current ·{' '}
            <span className="font-mono text-[#0F172A]">
              {gate.currentValue === null
                ? '—'
                : typeof gate.currentValue === 'number' &&
                    gate.key === 'min_reviewed_disagreements_pct'
                  ? `${gate.currentValue}%`
                  : String(gate.currentValue)}
            </span>
          </span>
          <span>·</span>
          <span>
            Threshold ·{' '}
            <span className="font-mono text-[#0F172A]">
              {String(gate.threshold)}
            </span>
          </span>
        </div>
        {gate.nextStep && (
          <div className="mt-1 text-[11.5px] text-[#475569]">
            <span className="text-[#94A3B8]">Next step: </span>
            {gate.nextStep}
          </div>
        )}
      </div>
    </li>
  )
}

const VERDICT_STYLE: Record<
  Verdict,
  {
    bg: string
    border: string
    iconBg: string
    iconColor: string
    text: string
    label: string
  }
> = {
  not_eligible: {
    bg: 'bg-[#FEF2F2]',
    border: 'border-[#FECACA]',
    iconBg: 'bg-[#FEE2E2]',
    iconColor: 'text-[#B91C1C]',
    text: 'text-[#7F1D1D]',
    label: 'text-[#B91C1C]',
  },
  watch: {
    bg: 'bg-[#FFFBEB]',
    border: 'border-[#FCD9A1]',
    iconBg: 'bg-[#FEF3C7]',
    iconColor: 'text-[#B45309]',
    text: 'text-[#92400E]',
    label: 'text-[#B45309]',
  },
  eligible: {
    bg: 'bg-[#ECFDF5]',
    border: 'border-[#A7F3D0]',
    iconBg: 'bg-[#D1FAE5]',
    iconColor: 'text-[#059669]',
    text: 'text-[#065F46]',
    label: 'text-[#059669]',
  },
}

const TITLE_BY_VERDICT: Record<Verdict, string> = {
  not_eligible: 'Autopilot is not eligible for this venue',
  watch: 'Autopilot needs more evidence',
  eligible: 'This venue meets the readiness gates',
}

const LABEL_BY_VERDICT: Record<Verdict, string> = {
  not_eligible: 'Not eligible',
  watch: 'Watch',
  eligible: 'Eligible (read-only)',
}

const EXPLAIN_BY_VERDICT: Record<Verdict, string> = {
  not_eligible:
    'One or more blocking gates are failing. Work through the next steps below to build the safety evidence base.',
  watch:
    'Every blocking gate passes; one or more warning gates need attention. Autopilot is not eligible until they clear.',
  eligible:
    'All readiness gates pass. This venue has enough safety evidence that a future opt-in autonomy phase could be considered — but autonomy is still disabled and requires its own dedicated rollout.',
}
