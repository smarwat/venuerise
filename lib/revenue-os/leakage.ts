import type { RevenueOsSettings } from './settings'

/**
 * Phase 8AQ — Revenue leakage scoring + Speed-to-Lead score.
 *
 * Pure module. No Supabase client, no React, no env reads. Callers
 * (the server-rendered RevenueLeakageBrief, the leads board filter,
 * the LeadDetailDrawer chip) fetch the inputs themselves and pass
 * them in. This keeps the scoring logic testable in isolation and
 * lets every surface that wants leakage answers reuse the same code
 * path.
 *
 * Inputs are deliberately narrow:
 *   - leads: just enough to score (id, stage, lead_score, timestamps)
 *   - outbound message activity: lead_id + earliest outbound timestamp
 *   - inbound message activity: lead_id + latest inbound timestamp
 *   - tours: lead_id + status + scheduled_at
 *
 * That keeps the helper independent of the messages table shape (only
 * lead_id + role + created_at matter) and lets the callers shape their
 * queries however they want.
 */

// ---------------------------------------------------------------------------
// Shared input types
// ---------------------------------------------------------------------------

export interface LeakageLead {
  id: string
  stage: string
  lead_score: number
  created_at: string
  updated_at: string
}

export interface LeakageOutboundActivity {
  lead_id: string
  /** Earliest outbound (role in ['ai','human']) message timestamp for
   *  the lead. Null if the lead has never received an outbound. */
  first_outbound_at: string | null
}

export interface LeakageInboundActivity {
  lead_id: string
  /** Latest inbound (role='lead') message timestamp. Null if the lead
   *  has never sent an inbound message after the form-fill itself. */
  last_inbound_at: string | null
}

export interface LeakageTour {
  id: string
  lead_id: string
  status: string
  scheduled_at: string | null
}

export type LeakageSignalKey =
  | 'slow_first_reply'
  | 'high_fit_idle'
  | 'no_tour_booked'
  | 'tour_pending_confirm'
  | 'cold_lead_recovery'

export interface LeakageSignal {
  key: LeakageSignalKey
  count: number
  severity: 'red' | 'amber' | 'blue' | 'slate'
  label: string
  helper: string
  /** Lead ids that triggered this signal. The leads-board filter
   *  consumes this to narrow the Kanban; the brief only uses .length. */
  leadIds: string[]
  /** Tour ids when the signal is tour-shaped (pending confirm). */
  tourIds?: string[]
}

// ---------------------------------------------------------------------------
// Speed-to-Lead per-lead score
// ---------------------------------------------------------------------------

export interface LeadSpeedToLeadScore {
  leadId: string
  firstOutboundAt: string | null
  minutesToFirstReply: number | null
  slaMinutes: number
  /**
   * - met:     reply landed within SLA
   * - missed:  reply landed AFTER SLA
   * - pending: no reply yet, still within SLA window
   * - overdue: no reply yet AND past SLA window — collapses to 'pending'
   *            in the union below, but `score` reflects the lower band
   * - unknown: lead is malformed (no created_at, etc.)
   */
  status: 'met' | 'missed' | 'pending' | 'unknown'
  /** 0–100. See computeLeadSpeedToLeadScores for the bands. */
  score: number
}

function diffMinutes(later: string, earlier: string): number | null {
  const a = new Date(later).getTime()
  const b = new Date(earlier).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.max(0, Math.round((a - b) / (1000 * 60)))
}

/**
 * Compute a per-lead speed-to-lead score.
 *
 * Bands (in order of priority):
 *   - 100  reply landed within SLA
 *   - 70   reply landed within 2x SLA
 *   - 40   reply landed > 2x SLA (missed badly)
 *   - 60   no reply yet, still within SLA window (pending, healthy)
 *   - 20   no reply yet, past SLA window (pending, overdue)
 *   - 0    malformed input (no created_at, etc.)
 */
export function computeLeadSpeedToLeadScores(
  leads: ReadonlyArray<Pick<LeakageLead, 'id' | 'created_at'>>,
  outbound: ReadonlyArray<LeakageOutboundActivity>,
  settings: Pick<RevenueOsSettings, 'firstReplySlaMinutes'>,
  now: Date = new Date()
): LeadSpeedToLeadScore[] {
  const outboundByLead = new Map<string, string | null>()
  for (const o of outbound) outboundByLead.set(o.lead_id, o.first_outbound_at)
  const slaMinutes = settings.firstReplySlaMinutes
  const nowMs = now.getTime()
  return leads.map((lead) => {
    const createdMs = new Date(lead.created_at).getTime()
    if (!Number.isFinite(createdMs)) {
      return {
        leadId: lead.id,
        firstOutboundAt: null,
        minutesToFirstReply: null,
        slaMinutes,
        status: 'unknown',
        score: 0,
      }
    }
    const firstOutboundAt = outboundByLead.get(lead.id) ?? null
    if (firstOutboundAt) {
      const minutes = diffMinutes(firstOutboundAt, lead.created_at)
      if (minutes === null) {
        return {
          leadId: lead.id,
          firstOutboundAt,
          minutesToFirstReply: null,
          slaMinutes,
          status: 'unknown',
          score: 0,
        }
      }
      if (minutes <= slaMinutes) {
        return {
          leadId: lead.id,
          firstOutboundAt,
          minutesToFirstReply: minutes,
          slaMinutes,
          status: 'met',
          score: 100,
        }
      }
      if (minutes <= slaMinutes * 2) {
        return {
          leadId: lead.id,
          firstOutboundAt,
          minutesToFirstReply: minutes,
          slaMinutes,
          status: 'missed',
          score: 70,
        }
      }
      return {
        leadId: lead.id,
        firstOutboundAt,
        minutesToFirstReply: minutes,
        slaMinutes,
        status: 'missed',
        score: 40,
      }
    }
    // No reply yet — pending. Healthy if still inside the SLA window,
    // overdue if past it.
    const ageMinutes = Math.max(0, Math.round((nowMs - createdMs) / 60000))
    if (ageMinutes <= slaMinutes) {
      return {
        leadId: lead.id,
        firstOutboundAt: null,
        minutesToFirstReply: null,
        slaMinutes,
        status: 'pending',
        score: 60,
      }
    }
    return {
      leadId: lead.id,
      firstOutboundAt: null,
      minutesToFirstReply: null,
      slaMinutes,
      status: 'pending',
      score: 20,
    }
  })
}

// ---------------------------------------------------------------------------
// Aggregate leakage signals
// ---------------------------------------------------------------------------

const STAGES_IN_FLIGHT = new Set([
  'new_inquiry',
  'qualified',
  'tour_scheduled',
  'tour_completed',
  'negotiation',
])
const STAGES_QUALIFIED_FOR_TOUR = new Set(['qualified', 'negotiation'])

function hoursAgo(now: Date, h: number): Date {
  return new Date(now.getTime() - h * 60 * 60 * 1000)
}
function minutesAgo(now: Date, m: number): Date {
  return new Date(now.getTime() - m * 60 * 1000)
}
function daysAgo(now: Date, d: number): Date {
  return new Date(now.getTime() - d * 24 * 60 * 60 * 1000)
}

interface ComputeLeakageInput {
  leads: ReadonlyArray<LeakageLead>
  outbound: ReadonlyArray<LeakageOutboundActivity>
  inbound: ReadonlyArray<LeakageInboundActivity>
  tours: ReadonlyArray<LeakageTour>
  settings: RevenueOsSettings
  now?: Date
}

/**
 * Compute the five leakage signals that power the RevenueLeakageBrief
 * + the leads-board `?leakage=` filter. Pure function — pass it the
 * inputs and it returns deterministic output.
 *
 * `leadIds` is always populated so callers can drill into the lead
 * board with a known shortlist (Phase 8AQ leads-filter path).
 */
export function computeRevenueLeakage(
  input: ComputeLeakageInput
): LeakageSignal[] {
  const now = input.now ?? new Date()
  const { settings } = input

  const outboundByLead = new Map<string, string | null>()
  for (const o of input.outbound) outboundByLead.set(o.lead_id, o.first_outbound_at)

  const inboundByLead = new Map<string, string | null>()
  for (const i of input.inbound) inboundByLead.set(i.lead_id, i.last_inbound_at)

  const toursByLead = new Map<string, LeakageTour[]>()
  for (const t of input.tours) {
    const arr = toursByLead.get(t.lead_id) ?? []
    arr.push(t)
    toursByLead.set(t.lead_id, arr)
  }

  // ---- slow_first_reply --------------------------------------------------
  const slowFirstReplyCutoff = minutesAgo(now, settings.firstReplySlaMinutes)
  const slowFirstReplyLeadIds: string[] = []
  for (const lead of input.leads) {
    if (lead.stage !== 'new_inquiry') continue
    const created = new Date(lead.created_at)
    if (created.getTime() > slowFirstReplyCutoff.getTime()) continue
    if (outboundByLead.get(lead.id)) continue
    slowFirstReplyLeadIds.push(lead.id)
  }

  // ---- high_fit_idle -----------------------------------------------------
  const highFitCutoff = hoursAgo(now, settings.staleHighFitHours)
  const highFitIdleLeadIds: string[] = []
  for (const lead of input.leads) {
    if (lead.lead_score < settings.highFitThreshold) continue
    if (!STAGES_IN_FLIGHT.has(lead.stage)) continue
    const updated = new Date(lead.updated_at)
    if (updated.getTime() >= highFitCutoff.getTime()) continue
    highFitIdleLeadIds.push(lead.id)
  }

  // ---- no_tour_booked ----------------------------------------------------
  const noTourBookedLeadIds: string[] = []
  for (const lead of input.leads) {
    if (!STAGES_QUALIFIED_FOR_TOUR.has(lead.stage)) continue
    const leadTours = toursByLead.get(lead.id) ?? []
    if (leadTours.length === 0) noTourBookedLeadIds.push(lead.id)
  }

  // ---- tour_pending_confirm ---------------------------------------------
  const tourPendingConfirmLeadIds = new Set<string>()
  const tourPendingConfirmTourIds: string[] = []
  for (const t of input.tours) {
    if (t.status !== 'scheduled') continue
    if (!t.scheduled_at) continue
    const when = new Date(t.scheduled_at).getTime()
    if (!Number.isFinite(when)) continue
    if (when < now.getTime()) continue
    tourPendingConfirmTourIds.push(t.id)
    tourPendingConfirmLeadIds.add(t.lead_id)
  }

  // ---- cold_lead_recovery ------------------------------------------------
  //
  // Phase 8AR — baseline fix.
  //
  // Some intake paths create a `leads` row WITHOUT a corresponding
  // inbound `messages.role='lead'` row (e.g. a widget intake that
  // serializes the form into `lead.notes` instead of seeding an
  // inbound message). Under the original Phase 8AP/8AQ rule those
  // leads always looked cold the moment they aged past `coldLeadDays`,
  // which over-counted leakage and trained operators to ignore the
  // signal.
  //
  // New rule:
  //   - If the lead has at least one inbound message, use its latest
  //     `created_at` as the baseline.
  //   - Otherwise, use `lead.created_at` as the baseline — that's the
  //     safest proxy for "last heard from the lead" when no inbound
  //     message exists.
  //   - A lead is cold only when the baseline is older than
  //     `coldLeadDays`.
  //
  // Net effect: a fresh widget-form lead with no inbound row no
  // longer pops into the cold bucket immediately on the second day.
  const coldCutoff = daysAgo(now, settings.coldLeadDays)
  const coldLeadIds: string[] = []
  for (const lead of input.leads) {
    if (!STAGES_IN_FLIGHT.has(lead.stage)) continue
    if (lead.stage === 'new_inquiry') continue
    const lastInbound = inboundByLead.get(lead.id) ?? null
    // Baseline: prefer the latest inbound; fall back to lead.created_at
    // when the inbound history is empty (Phase 8AR fix).
    const baseline = lastInbound ?? lead.created_at
    const baselineMs = new Date(baseline).getTime()
    if (!Number.isFinite(baselineMs)) continue
    if (baselineMs >= coldCutoff.getTime()) continue
    coldLeadIds.push(lead.id)
  }

  return [
    {
      key: 'slow_first_reply',
      count: slowFirstReplyLeadIds.length,
      severity: 'red',
      label: 'Inquiries waiting for a first reply',
      helper: `Older than ${settings.firstReplySlaMinutes} minutes with no outbound message yet`,
      leadIds: slowFirstReplyLeadIds,
    },
    {
      key: 'high_fit_idle',
      count: highFitIdleLeadIds.length,
      severity: 'amber',
      label: 'High-fit leads without a next step',
      helper: `Score ≥ ${settings.highFitThreshold}, no activity in ${settings.staleHighFitHours}h`,
      leadIds: highFitIdleLeadIds,
    },
    {
      key: 'no_tour_booked',
      count: noTourBookedLeadIds.length,
      severity: 'amber',
      label: 'Qualified leads with no tour booked',
      helper: 'Move them to a slot before they cool',
      leadIds: noTourBookedLeadIds,
    },
    {
      key: 'tour_pending_confirm',
      count: tourPendingConfirmTourIds.length,
      severity: 'blue',
      label: 'Tours pending confirmation',
      helper: 'Scheduled but not confirmed yet',
      leadIds: Array.from(tourPendingConfirmLeadIds),
      tourIds: tourPendingConfirmTourIds,
    },
    {
      key: 'cold_lead_recovery',
      count: coldLeadIds.length,
      severity: 'slate',
      label: 'Cold leads to recover',
      helper: `No inbound message in ${settings.coldLeadDays}+ days`,
      leadIds: coldLeadIds,
    },
  ]
}

/**
 * Human label for the leads-board filter pill / page-level header.
 * Centralized so the Kanban + the brief stay in sync if we rename a
 * signal later.
 */
export function leakageSignalDisplayName(key: LeakageSignalKey): string {
  switch (key) {
    case 'slow_first_reply':
      return 'Slow first reply'
    case 'high_fit_idle':
      return 'High-fit idle'
    case 'no_tour_booked':
      return 'No tour booked'
    case 'tour_pending_confirm':
      return 'Tour pending confirmation'
    case 'cold_lead_recovery':
      return 'Cold leads to recover'
  }
}
