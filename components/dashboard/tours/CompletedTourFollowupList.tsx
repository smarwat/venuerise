import Link from 'next/link'
import { ArrowRight, HeartHandshake, Users } from 'lucide-react'
import { format } from 'date-fns'

/**
 * GTM-0F — Completed tours needing follow-up.
 *
 * The most important missing business workflow on the previous
 * Tours page. Surfaces couples who toured the venue but haven't
 * booked yet — every row is one click from the lead drawer where
 * the operator can send the proposal or revival message while
 * the visit is still fresh in the couple's memory.
 *
 * Selection logic:
 *   - tour.status === 'completed'
 *   - linked lead.stage NOT IN { 'booked', 'lost' }
 *   - sorted by most recent completed tour first
 *   - top 5
 *
 * Pure presentational. Data comes from the page's tours fetch
 * (extended with `leads(name, stage, lead_score, budget)`).
 */

type TourLite = {
  id: string
  scheduled_at: string | null
  status: string | null
  lead_id?: string | null
  leads?: {
    name?: string | null
    stage?: string | null
    lead_score?: number | null
    budget?: number | null
  } | null
}

interface Props {
  tours: ReadonlyArray<TourLite>
  /** Max rows to render. Default 5. */
  limit?: number
}

const STAGE_LABEL: Record<string, string> = {
  new_inquiry: 'New inquiry',
  qualified: 'Qualified',
  tour_scheduled: 'Tour scheduled',
  tour_completed: 'Tour completed',
  negotiation: 'In negotiation',
  booked: 'Booked',
  lost: 'Lost',
}

function nextAction(stage: string | null | undefined): string {
  switch (stage) {
    case 'tour_completed':
      return 'Send proposal'
    case 'negotiation':
      return 'Revive around fit'
    case 'qualified':
      return 'Follow up while interest is warm'
    case 'tour_scheduled':
      return 'Ask for feedback'
    default:
      return 'Follow up while interest is warm'
  }
}

function moneyShort(n: number): string {
  if (n <= 0) return '—'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`
  return `$${n.toLocaleString()}`
}

export default function CompletedTourFollowupList({ tours, limit = 5 }: Props) {
  const rows = tours
    .filter((t) => {
      if (t.status !== 'completed') return false
      const stage = t.leads?.stage
      if (stage === 'booked') return false
      if (stage === 'lost') return false
      return true
    })
    .sort((a, b) => {
      const ab = a.scheduled_at ? new Date(a.scheduled_at).getTime() : 0
      const bb = b.scheduled_at ? new Date(b.scheduled_at).getTime() : 0
      return bb - ab
    })
    .slice(0, limit)

  return (
    <section className="rounded-2xl border border-[#E6E8EF] bg-white shadow-card overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-[#F1F5F9]">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#92763C] font-semibold mb-1">
            Highest-value follow-ups
          </div>
          <h2 className="text-[15px] font-semibold text-[#0F172A] leading-tight">
            Completed tours needing follow-up
          </h2>
          <p className="text-[11.5px] text-[#64748B] mt-1">
            Couples who toured but have not booked yet. Follow up while the venue is still fresh.
          </p>
        </div>
        <Link
          href="/dashboard/leads?leakage=follow_up_recovery"
          className="inline-flex items-center gap-1 text-[11.5px] px-2.5 py-1 rounded-md text-[#1D4ED8] hover:bg-[#EFF6FF] shrink-0"
        >
          Open queue
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      <div className="px-5 py-4">
        {rows.length === 0 ? (
          <div className="rounded-xl border border-[#D1FAE5] bg-[#ECFDF5] px-3.5 py-3 flex items-center gap-2.5 text-[12.5px] text-[#047857]">
            <span className="w-7 h-7 rounded-lg bg-white/70 border border-[#A7F3D0] text-[#047857] flex items-center justify-center shrink-0">
              <HeartHandshake className="w-3.5 h-3.5" />
            </span>
            <span>
              No completed tours waiting on follow-up — couples are moving through the funnel.
            </span>
          </div>
        ) : (
          <ul className="divide-y divide-[#F1F5F9]">
            {rows.map((t) => {
              const name = t.leads?.name ?? 'Unknown couple'
              const stage = t.leads?.stage ?? null
              const stageLabel = stage ? (STAGE_LABEL[stage] ?? stage) : '—'
              const action = nextAction(stage)
              const score = t.leads?.lead_score ?? null
              const budget = t.leads?.budget ?? 0
              const tourDate = t.scheduled_at
                ? format(new Date(t.scheduled_at), 'MMM d, yyyy')
                : '—'
              return (
                <li
                  key={t.id}
                  className="py-3 flex items-start gap-3"
                >
                  <span className="w-9 h-9 rounded-[10px] bg-[#FAF7F0] border border-[#E8DCC4] text-[#92763C] flex items-center justify-center shrink-0">
                    <HeartHandshake className="w-4 h-4" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-semibold text-[#0F172A] truncate">
                        {name}
                      </span>
                      {score != null && (
                        <span className="text-[10.5px] uppercase tracking-[0.12em] text-[#94A3B8] font-semibold">
                          Score {score}
                        </span>
                      )}
                      <span className="text-[10px] uppercase tracking-[0.1em] text-[#475569] bg-[#F1F5F9] border border-[#E2E8F0] rounded-md px-1.5 py-px font-semibold">
                        {stageLabel}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-[#475569] leading-snug">
                      Toured {tourDate} ·{' '}
                      <span className="text-[#92763C] font-semibold">
                        Next · {action}
                      </span>
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {budget > 0 && (
                      <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-[#92763C] bg-[#FAF7F0] border border-[#E8DCC4] rounded-md px-1.5 py-0.5">
                        <Users className="w-3 h-3 opacity-70" />
                        Est. value {moneyShort(budget)}
                      </span>
                    )}
                    {t.lead_id && (
                      <Link
                        href={`/dashboard/leads?lead=${encodeURIComponent(t.lead_id)}`}
                        className="inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md text-[#1D4ED8] hover:bg-[#EFF6FF]"
                      >
                        Open lead
                        <ArrowRight className="w-3 h-3" />
                      </Link>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="px-5 py-2.5 border-t border-[#F1F5F9] bg-[#F8FAFC] text-[11px] text-[#64748B]">
        Completed tours are the highest-intent stage in the funnel. Every follow-up sent within 48 hours dramatically improves booking rates.
      </div>
    </section>
  )
}
