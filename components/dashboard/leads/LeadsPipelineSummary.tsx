import Link from 'next/link'
import { ArrowRight, Inbox, Flame, CalendarPlus, CalendarCheck, RotateCcw } from 'lucide-react'

/**
 * GTM-0E — Leads page revenue pipeline summary.
 *
 * Sits above the KanbanBoard. Reframes the page from
 *
 *   "104 of 104 leads shown"
 *
 * to
 *
 *   "104 leads tracked · 71 need action · $2.49M open pipeline"
 *
 * plus a "Needs attention today" action bar with 5 clickable buckets
 * that deep-link into the existing leakage-filter URLs the
 * KanbanBoard already understands.
 *
 * Pure presentational. No new DB queries — all counts are derived
 * from the leads array the page already fetched. Counts that can't
 * be safely inferred from the lead row alone (cold-lead inbound
 * inactivity, tour pending confirmation, reactivation candidacy)
 * fall back to honest stage-based heuristics so we never invent
 * numbers we don't have.
 */

type LeadLite = {
  id: string
  stage: string
  lead_score: number
  budget: number | null
  created_at: string
  updated_at?: string
}

type TourLite = {
  status: string | null
  scheduled_at: string | null
}

interface Props {
  leads: ReadonlyArray<LeadLite>
  /** Optional — when provided, used for the "Tours to confirm" bucket.
   *  Falls back to lead-stage approximation when omitted. */
  tours?: ReadonlyArray<TourLite>
  /** Operator-configurable first-reply SLA in minutes; defaults to 5. */
  slaMinutes?: number
}

const OPEN_STAGES = new Set([
  'new_inquiry',
  'qualified',
  'tour_scheduled',
  'tour_completed',
  'negotiation',
])

function money(n: number): string {
  if (n <= 0) return '—'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`
  return `$${n.toLocaleString()}`
}

export default function LeadsPipelineSummary({
  leads,
  tours = [],
  slaMinutes = 5,
}: Props) {
  // ── Headline numbers ──────────────────────────────────────────────────
  const tracked = leads.length
  const openPipeline = leads
    .filter((l) => OPEN_STAGES.has(l.stage))
    .reduce((sum, l) => sum + (l.budget ?? 0), 0)

  // ── Action buckets (derived from existing lead/tour data) ─────────────
  // Reply overdue: new_inquiry older than SLA. The board's per-card
  // chip uses the same threshold (see KanbanCard.newInquiryChip).
  const nowMs = Date.now()
  const slaMs = slaMinutes * 60_000
  const replyOverdue = leads.filter(
    (l) =>
      l.stage === 'new_inquiry' &&
      nowMs - new Date(l.created_at).getTime() > slaMs
  ).length

  // Hot leads idle: score >= 80 and not in a forward-moving stage.
  // Honest approximation — the precise definition (no activity in N
  // hours) needs message history, which isn't loaded here.
  const hotIdle = leads.filter(
    (l) =>
      l.lead_score >= 80 &&
      ['new_inquiry', 'qualified'].includes(l.stage)
  ).length

  // No tour booked: qualified leads not yet on a tour.
  const noTourBooked = leads.filter((l) => l.stage === 'qualified').length

  // Tours to confirm: tour_scheduled stage. If a `tours` array is
  // passed we further narrow to non-cancelled future tours.
  const toursToConfirm = (() => {
    if (tours.length > 0) {
      return tours.filter((t) => {
        if (!t.status || t.status === 'cancelled') return false
        if (!t.scheduled_at) return false
        return new Date(t.scheduled_at).getTime() > nowMs
      }).length
    }
    return leads.filter((l) => l.stage === 'tour_scheduled').length
  })()

  // Recoverable lost: lost leads. The precise reactivation candidacy
  // check needs lost_reason metadata + recovery cool-down math —
  // approximate here with raw lost count. The leads-board filter
  // (`?leakage=reactivation`) does the precise check on click.
  const recoverableLost = leads.filter((l) => l.stage === 'lost').length

  const needsAction =
    replyOverdue + hotIdle + noTourBooked + toursToConfirm + recoverableLost

  const buckets: Array<{
    key: string
    label: string
    helper: string
    count: number
    href: string
    Icon: typeof Inbox
    tone: { bg: string; text: string; ring: string }
  }> = [
    {
      key: 'slow_first_reply',
      label: 'Reply overdue',
      helper: 'New inquiries past the response SLA.',
      count: replyOverdue,
      href: '/dashboard/leads?leakage=slow_first_reply',
      Icon: Inbox,
      tone: {
        bg: 'bg-[#FFFBEB]',
        text: 'text-[#B45309]',
        ring: 'border-[#FDE68A]',
      },
    },
    {
      key: 'high_fit_idle',
      label: 'Hot leads idle',
      helper: 'High-score inquiries without a next step.',
      count: hotIdle,
      href: '/dashboard/leads?leakage=high_fit_idle',
      Icon: Flame,
      tone: {
        bg: 'bg-[#FAF7F0]',
        text: 'text-[#92763C]',
        ring: 'border-[#E8DCC4]',
      },
    },
    {
      key: 'no_tour_booked',
      label: 'No tour booked',
      helper: 'Qualified leads not yet touring.',
      count: noTourBooked,
      href: '/dashboard/leads?leakage=tour_booking',
      Icon: CalendarPlus,
      tone: {
        bg: 'bg-[#F1F5F9]',
        text: 'text-[#0F172A]',
        ring: 'border-[#E2E8F0]',
      },
    },
    {
      key: 'tour_pending_confirm',
      label: 'Tours to confirm',
      helper: 'Scheduled visits awaiting a clear yes.',
      count: toursToConfirm,
      href: '/dashboard/leads?leakage=tour_booking',
      Icon: CalendarCheck,
      tone: {
        bg: 'bg-[#EFF6FF]',
        text: 'text-[#1D4ED8]',
        ring: 'border-[#BFDBFE]',
      },
    },
    {
      key: 'reactivation',
      label: 'Recoverable lost',
      helper: 'Lost leads worth a soft check-in.',
      count: recoverableLost,
      href: '/dashboard/leads?leakage=reactivation',
      Icon: RotateCcw,
      tone: {
        bg: 'bg-[#F1F5F9]',
        text: 'text-[#475569]',
        ring: 'border-[#E2E8F0]',
      },
    },
  ]

  return (
    <section className="rounded-2xl border border-[#E6E8EF] bg-white shadow-card overflow-hidden mb-4">
      {/* Headline stats row */}
      <div className="relative px-5 py-4 lg:px-6 lg:py-5 bg-gradient-to-br from-white via-white to-[#FAF7F0]">
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-[#C5A572] via-[#92763C] to-[#C5A572]" />
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-[0.16em] text-[#92763C] font-semibold mb-1">
              Pipeline overview
            </div>
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-[22px] font-semibold text-[#0F172A] tabular-nums tracking-[-0.02em]">
                {tracked}
              </span>
              <span className="text-[12.5px] text-[#475569]">
                leads tracked
              </span>
              {needsAction > 0 && (
                <>
                  <span className="text-[#CBD5E1]">·</span>
                  <span className="text-[14px] font-semibold text-[#92763C] tabular-nums">
                    {needsAction}
                  </span>
                  <span className="text-[12.5px] text-[#475569]">need action</span>
                </>
              )}
              {openPipeline > 0 && (
                <>
                  <span className="text-[#CBD5E1]">·</span>
                  <span className="text-[14px] font-semibold text-[#0F172A] tabular-nums">
                    {money(openPipeline)}
                  </span>
                  <span className="text-[12.5px] text-[#475569]">open pipeline</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Needs attention buckets */}
      {needsAction > 0 && (
        <>
          <div className="px-5 lg:px-6 pt-3 pb-1.5 border-t border-[#F1F5F9]">
            <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#64748B] font-semibold">
              Needs attention today
            </div>
          </div>
          <div className="px-3 lg:px-4 pb-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
            {buckets.map((b) => {
              const isZero = b.count === 0
              const className = `flex items-start gap-2.5 px-3 py-2.5 rounded-xl border transition-colors min-w-0 ${
                isZero
                  ? 'border-[#E2E8F0] bg-[#F8FAFC] cursor-default'
                  : `${b.tone.ring} bg-white hover:bg-[#FAFBFD] hover:shadow-[0_2px_8px_rgba(15,23,42,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6]/30`
              }`
              const content = (
                <>
                  <span
                    className={`w-7 h-7 rounded-lg ${
                      isZero
                        ? 'bg-white border border-[#E2E8F0] text-[#94A3B8]'
                        : `${b.tone.bg} ${b.tone.text}`
                    } flex items-center justify-center shrink-0`}
                  >
                    <b.Icon className="w-3.5 h-3.5" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12.5px] font-semibold text-[#0F172A] truncate">
                        {b.label}
                      </span>
                      <span
                        className={`text-[15px] font-semibold tabular-nums shrink-0 ${
                          isZero ? 'text-[#94A3B8]' : b.tone.text
                        }`}
                      >
                        {b.count}
                      </span>
                    </div>
                    <div className="text-[10.5px] text-[#64748B] mt-0.5 leading-snug truncate">
                      {b.helper}
                    </div>
                  </div>
                  {!isZero && (
                    <ArrowRight className="w-3 h-3 text-[#94A3B8] shrink-0 mt-2" />
                  )}
                </>
              )
              return isZero ? (
                <div key={b.key} className={className}>
                  {content}
                </div>
              ) : (
                <Link key={b.key} href={b.href} className={className}>
                  {content}
                </Link>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}
