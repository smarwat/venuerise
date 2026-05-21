import Link from 'next/link'
import { ArrowRight, RotateCcw } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/server'
import {
  computeReactivationSignals,
  isLostReason,
  LOST_REASON_LABEL,
  type LostReason,
  type ReactivationSignal,
} from '@/lib/revenue-os/reactivation'

/**
 * Phase 8BD — Reactivation Queue (Overview surface).
 *
 * Surfaces lost leads that may be worth a soft re-engagement.
 * Server-rendered, derived from `leads.metadata.lost_reason` (Phase
 * 8BD migration 026) + the last lead-role message per lead.
 *
 * Critical safety posture:
 *   - These are SUGGESTIONS. Nothing in this card sends a
 *     message, reactivates a lead, or queues an outbound. The
 *     operator clicks "Open lead", clicks the new Reactivation
 *     panel in the drawer, clicks Regenerate, and clicks
 *     Approve & send.
 *   - `autonomous_sending_still_disabled` (from 8AX) remains
 *     mounted.
 *   - Lost reasons are OPERATOR-SUPPLIED only. We never
 *     synthesize a reason; missing reasons surface as
 *     "possible candidate" after a long cooling window, not
 *     "strong".
 */

interface Props {
  venueId: string | null
}

interface QueueRow {
  signal: ReactivationSignal
  leadName: string | null
  leadScore: number | null
  lastContactAt: string | null
}

async function fetchReactivationQueue(venueId: string): Promise<{
  ok: true
  rows: QueueRow[]
} | { ok: false }> {
  const supabase = await createClient()

  // 1. Lost leads only. We pull a bounded slice ordered by
  //    `updated_at desc` so newer losses surface before months-old
  //    ones; the helper's score then re-ranks within candidacy.
  const { data: leadRows, error: leadsErr } = await supabase
    .from('leads')
    .select(
      'id, name, stage, lead_score, event_date, updated_at, metadata'
    )
    .eq('venue_id', venueId)
    .eq('stage', 'lost')
    .order('updated_at', { ascending: false })
    .limit(200)
  if (leadsErr) return { ok: false }
  const rawLeads = (leadRows ?? []) as Array<{
    id: string
    name: string
    stage: string
    lead_score: number
    event_date: string | null
    updated_at: string
    metadata: Record<string, unknown> | null
  }>
  if (rawLeads.length === 0) return { ok: true, rows: [] }

  // 2. Per-lead last lead-role message timestamp. One IN-batched
  //    read is cheaper than fanning out per lead. We pick the
  //    MAX(created_at) WHERE role='lead' per lead_id.
  const leadIds = rawLeads.map((l) => l.id)
  const { data: msgRows } = await supabase
    .from('messages')
    .select('lead_id, created_at')
    .eq('venue_id', venueId)
    .eq('role', 'lead')
    .in('lead_id', leadIds)
    .order('created_at', { ascending: false })
  const lastInboundByLead: Record<string, string | null> = {}
  for (const m of (msgRows ?? []) as Array<{
    lead_id: string
    created_at: string
  }>) {
    // Order is desc → first hit per lead wins. Skip if already set.
    if (!(m.lead_id in lastInboundByLead)) {
      lastInboundByLead[m.lead_id] = m.created_at
    }
  }
  // Fill in `null` for leads with no inbound — the helper's
  // cooling gate uses `null` to skip these (no signal to act on).
  for (const l of rawLeads) {
    if (!(l.id in lastInboundByLead)) lastInboundByLead[l.id] = null
  }

  // 3. Project metadata.lost_reason → LostReason | null. The
  //    helper does the rest.
  const helperLeads = rawLeads.map((l) => {
    const md = l.metadata
    const block =
      md && typeof md === 'object'
        ? (md as { lost_reason?: unknown }).lost_reason
        : undefined
    const reason =
      block &&
      typeof block === 'object' &&
      isLostReason((block as { reason?: unknown }).reason)
        ? ((block as { reason: LostReason }).reason)
        : null
    return {
      id: l.id,
      name: l.name,
      stage: l.stage,
      lead_score: l.lead_score,
      event_date: l.event_date,
      updated_at: l.updated_at,
      lost_reason: reason,
    }
  })

  const signals = computeReactivationSignals({
    leads: helperLeads,
    lastMessages: lastInboundByLead,
  })

  // 4. Stitch the row layout: top 10 signals, augmented with the
  //    operator-readable lead name + score + last-contact age.
  const leadById = new Map(rawLeads.map((l) => [l.id, l]))
  const rows: QueueRow[] = signals.slice(0, 10).map((sig) => {
    const lead = leadById.get(sig.leadId)
    return {
      signal: sig,
      leadName: lead?.name ?? null,
      leadScore: lead?.lead_score ?? null,
      lastContactAt: lastInboundByLead[sig.leadId] ?? null,
    }
  })

  return { ok: true, rows }
}

export default async function ReactivationQueueCard({ venueId }: Props) {
  let outcome: Awaited<ReturnType<typeof fetchReactivationQueue>> = {
    ok: false,
  }
  if (venueId) {
    try {
      outcome = await fetchReactivationQueue(venueId)
    } catch {
      // Defensive: card collapses to the empty branch on any
      // probe failure so the Overview keeps rendering.
      outcome = { ok: false }
    }
  }

  const rows = outcome.ok ? outcome.rows : []
  const isEmpty = outcome.ok && rows.length === 0

  return (
    <section className="rounded-2xl border border-[#E6E8EF] bg-white shadow-card overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-[#F1F5F9]">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold mb-1">
            Reactivation Agent
          </div>
          <h2 className="text-[15px] font-semibold text-[#0F172A] leading-tight">
            Leads worth re-engaging
          </h2>
          <p className="text-[11.5px] text-[#64748B] mt-1">
            Lost leads where the cool-down + recorded reason suggest a
            soft check-in could re-open the conversation.
          </p>
        </div>
        <Link
          href="/dashboard/leads?leakage=reactivation"
          className="inline-flex items-center gap-1 text-[11.5px] px-2.5 py-1 rounded-md text-[#1D4ED8] hover:bg-[#EFF6FF] shrink-0"
        >
          Open reactivation queue
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      {!outcome.ok && (
        <div className="px-5 py-6 text-[12.5px] text-[#94A3B8] text-center">
          Couldn&apos;t load reactivation candidates right now.
        </div>
      )}

      {isEmpty && (
        <div className="px-5 py-6 text-[12.5px] text-[#64748B] text-center">
          No reactivation candidates right now.
        </div>
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-[#F1F5F9]">
          {rows.map((row) => (
            <li
              key={row.signal.leadId}
              className="px-5 py-3 flex items-start gap-3"
            >
              <div className="shrink-0 mt-0.5 w-8 h-8 rounded-[10px] bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] flex items-center justify-center">
                <RotateCcw className="w-3.5 h-3.5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-semibold text-[#0F172A] truncate">
                    {row.leadName ?? 'Unknown lead'}
                  </span>
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-[0.08em] px-1.5 py-0.5 rounded border ${
                      row.signal.candidacy === 'strong_candidate'
                        ? 'bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE]'
                        : 'bg-[#FFFBEB] text-[#B45309] border-[#FCD9A1]'
                    }`}
                  >
                    {row.signal.candidacy === 'strong_candidate'
                      ? 'Strong candidate'
                      : 'Possible'}
                  </span>
                  {row.signal.reason && (
                    <span className="text-[10.5px] text-[#64748B]">
                      {LOST_REASON_LABEL[row.signal.reason]}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11.5px] text-[#475569] leading-snug">
                  {row.signal.rationale}
                </p>
                <div className="mt-1 flex items-center gap-2 flex-wrap text-[10.5px] text-[#94A3B8]">
                  {row.lastContactAt && (
                    <span>
                      Last contact{' '}
                      {formatDistanceToNow(new Date(row.lastContactAt), {
                        addSuffix: true,
                      })}
                    </span>
                  )}
                  {row.leadScore !== null && (
                    <>
                      <span>·</span>
                      <span>Lead score {row.leadScore}</span>
                    </>
                  )}
                  <span>·</span>
                  <span>Reactivation score {row.signal.score}</span>
                </div>
              </div>
              <Link
                href={`/dashboard/leads?lead=${row.signal.leadId}`}
                className="shrink-0 inline-flex items-center gap-1 text-[11.5px] px-2.5 py-1.5 rounded-md border border-[#E2E8F0] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC]"
              >
                Open lead
                <ArrowRight className="w-3 h-3" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="px-5 py-3 border-t border-[#F1F5F9] text-[10.5px] text-[#94A3B8] italic">
        Reactivation suggestions never send automatically. Operators
        stay in control.
      </div>
    </section>
  )
}
