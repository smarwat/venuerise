import Link from 'next/link'
import { ArrowRight, Inbox, CalendarCheck, RotateCcw, Sparkles } from 'lucide-react'

/**
 * GTM-0D — "Today's priority" card.
 *
 * Compact, scannable, single-purpose: tell the operator the exact
 * order of work for the next hour. Each row is a numbered priority
 * with a count, a short business label, and a one-click CTA into
 * the right filtered surface.
 *
 * Driven by counts we already have from the leakage helper / page
 * fetch — no new DB cost. Rows with zero count are HIDDEN rather
 * than shown grayed-out; zero rows would dilute the "do these
 * things now" framing.
 */

export interface TodayPriorityRow {
  /** Operator-friendly label, e.g. "Reply to new inquiries". */
  label: string
  /** Count of items behind the CTA. */
  count: number
  /** Filtered surface deep-link. */
  href: string
  /** Display button text. */
  cta: string
  /** Icon family. */
  kind: 'inbox' | 'tour' | 'recover' | 'review'
}

interface Props {
  rows: TodayPriorityRow[]
  /** Optional eyebrow override; defaults to `Today's priority`. */
  eyebrow?: string
}

const KIND_ICON = {
  inbox: Inbox,
  tour: CalendarCheck,
  recover: RotateCcw,
  review: Sparkles,
}

const KIND_TONE: Record<TodayPriorityRow['kind'], { bg: string; text: string }> = {
  inbox:   { bg: 'bg-[#EFF6FF]', text: 'text-[#1D4ED8]' },
  tour:    { bg: 'bg-[#ECFDF5]', text: 'text-[#047857]' },
  recover: { bg: 'bg-[#FAF7F0]', text: 'text-[#92763C]' },
  review:  { bg: 'bg-[#F1F5F9]', text: 'text-[#0F172A]' },
}

export default function TodayPriorityCard({ rows, eyebrow }: Props) {
  const visible = rows.filter((r) => r.count > 0)
  if (visible.length === 0) {
    return (
      <section className="rounded-2xl border border-[#E6E8EF] bg-white shadow-card overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-[#F1F5F9]">
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#92763C] font-semibold mb-1">
            {eyebrow ?? "Today's priority"}
          </div>
          <h2 className="text-[15px] font-semibold text-[#0F172A] leading-tight">
            You&rsquo;re ahead of the inbox
          </h2>
          <p className="text-[11.5px] text-[#64748B] mt-1">
            No urgent revenue work right now. The agents will surface new opportunities here as they appear.
          </p>
        </div>
      </section>
    )
  }
  return (
    <section className="rounded-2xl border border-[#E6E8EF] bg-white shadow-card overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-[#F1F5F9]">
        <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#92763C] font-semibold mb-1">
          {eyebrow ?? "Today's priority"}
        </div>
        <h2 className="text-[15px] font-semibold text-[#0F172A] leading-tight">
          Do these {visible.length} things first
        </h2>
        <p className="text-[11.5px] text-[#64748B] mt-1">
          Each line is one click away from the exact leads or tours that need a response.
        </p>
      </div>
      <ol className="divide-y divide-[#F1F5F9]">
        {visible.map((row, i) => {
          const Icon = KIND_ICON[row.kind]
          const tone = KIND_TONE[row.kind]
          return (
            <li key={i} className="px-5 py-3 flex items-center gap-3">
              <span className="w-6 h-6 rounded-full bg-[#0F172A] text-white text-[11px] font-semibold flex items-center justify-center shrink-0 tabular-nums">
                {i + 1}
              </span>
              <span
                className={`w-8 h-8 rounded-[10px] ${tone.bg} ${tone.text} flex items-center justify-center shrink-0`}
              >
                <Icon className="w-4 h-4" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-[#0F172A] leading-snug">
                  {row.label}
                </div>
                <div className="text-[11.5px] text-[#64748B]">
                  <span className="font-semibold text-[#0F172A] tabular-nums">{row.count}</span>{' '}
                  {row.count === 1 ? 'item' : 'items'} waiting
                </div>
              </div>
              <Link
                href={row.href}
                className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 py-1.5 rounded-md text-[#1D4ED8] hover:bg-[#EFF6FF] shrink-0"
              >
                {row.cta}
                <ArrowRight className="w-3 h-3" />
              </Link>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
