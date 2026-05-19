import { Sparkles, ArrowRight, CalendarCheck, Send, Reply, Check } from 'lucide-react'

/**
 * Phase 8AG — Overnight AI Brief hero card.
 *
 * Pure presentational. The parent (Overview page) computes the
 * numbers from real data when available; this component just renders
 * what it's given. Safe fallbacks let the card show useful copy
 * even on a brand-new venue with no leads / no activity.
 *
 * Visual identity matches the reference design: left column is the
 * greeting + 4 big stats + "What I handled" list, right column is
 * the "Needs you" review queue.
 */

export interface AIBriefStats {
  repliesSent: number
  toursBooked: number
  packetsSent: number
  hoursSaved: number
}

export interface AIBriefHandledItem {
  id: string
  text: string
  time: string
  icon: 'reply' | 'cal' | 'send' | 'sparkle'
}

export interface AIBriefReviewItem {
  id: string
  text: string
  /** Optional initials shown on the avatar. */
  initials?: string
  /** Optional sub-line ("Draft ready · Sophia Martinez"). */
  meta?: string
  /** Optional target link the right-arrow chip should send to. */
  href?: string
}

export interface AIBriefCardProps {
  /** Headline first sentence — defaults to "Good morning". */
  greeting?: string
  /** Headline second sentence (muted). */
  subhead?: string
  /** Stamp shown beside the eyebrow ("Mon, May 18 · 8:14 AM"). */
  asOf?: string
  stats?: AIBriefStats
  handled?: AIBriefHandledItem[]
  reviews?: AIBriefReviewItem[]
}

const FALLBACK_STATS: AIBriefStats = {
  repliesSent: 0,
  toursBooked: 0,
  packetsSent: 0,
  hoursSaved: 0,
}

const HANDLED_ICONS = {
  reply: Reply,
  cal: CalendarCheck,
  send: Send,
  sparkle: Sparkles,
} as const

function defaultAsOf(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

export default function AIBriefCard({
  greeting = 'Good morning.',
  subhead = "Here's what your AI handled overnight.",
  asOf,
  stats = FALLBACK_STATS,
  handled = [],
  reviews = [],
}: AIBriefCardProps) {
  const stamp = asOf ?? defaultAsOf()
  const statTiles = [
    { n: stats.repliesSent, l: 'replies sent' },
    { n: stats.toursBooked, l: 'tour booked' },
    { n: stats.packetsSent, l: 'packets sent' },
    { n: `${stats.hoursSaved}h`, l: 'time returned' },
  ]

  return (
    <div className="bg-white border border-[#E6E8EF] rounded-[22px] shadow-card overflow-hidden">
      <div className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr]">
        {/* LEFT — greeting + numbers + handled list */}
        <div className="p-7 lg:p-8 relative">
          <div className="flex items-center gap-3 mb-3.5">
            <span className="px-2.5 py-1 rounded-md bg-[#F8FAFC] border border-[#E6E8EF] text-[10.5px] uppercase tracking-[0.14em] text-[#64748B] font-semibold">
              Overnight · AI brief
            </span>
            <span className="font-mono text-[11px] text-[#64748B]">{stamp}</span>
          </div>

          <h1 className="text-[26px] sm:text-[28px] font-semibold leading-[1.2] tracking-[-0.025em] text-[#0F172A] max-w-[36ch]">
            {greeting}{' '}
            <span className="text-[#64748B] font-semibold">{subhead}</span>
          </h1>

          {/* 4-up stat row — matches reference editorial divider lines */}
          <div className="grid grid-cols-4 border-y border-[#EEF1F6] mt-4 py-3.5">
            {statTiles.map((s, i) => (
              <div
                key={i}
                className={
                  i === 0
                    ? ''
                    : 'border-l border-[#EEF1F6] pl-4'
                }
              >
                <div className="text-[28px] sm:text-[32px] font-semibold leading-none text-[#0F172A] tabular-nums">
                  {s.n}
                </div>
                <div className="text-[11px] text-[#64748B] tracking-[0.04em] mt-1.5">
                  {s.l}
                </div>
              </div>
            ))}
          </div>

          {/* What I handled */}
          <div className="mt-5">
            <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#64748B] font-semibold mb-2.5">
              What I handled
            </div>
            {handled.length === 0 ? (
              <p className="text-[12.5px] text-[#94A3B8]">
                No overnight activity yet — your AI runs while you sleep.
              </p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {handled.map((h) => {
                  const Icon = HANDLED_ICONS[h.icon] ?? Sparkles
                  return (
                    <li key={h.id} className="flex items-start gap-2.5 text-[13px]">
                      <div className="w-[22px] h-[22px] rounded-[7px] bg-[#EFF4FF] text-[#2563EB] flex items-center justify-center shrink-0 mt-px">
                        <Icon className="w-3 h-3" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[#0F172A]">{h.text}</div>
                        <div className="font-mono text-[11px] text-[#94A3B8] mt-0.5">{h.time}</div>
                      </div>
                      <Check className="w-3.5 h-3.5 text-[#0F8A5B] mt-1" />
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        {/* RIGHT — needs you */}
        <div className="p-7 lg:p-8 border-t lg:border-t-0 lg:border-l border-[#E6E8EF] bg-gradient-to-b from-[#F8FAFC] to-white">
          <div className="flex items-start justify-between gap-3 mb-3.5">
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.14em] text-[#64748B] font-semibold">
                Needs you
              </div>
              <div className="text-[18px] sm:text-[20px] font-semibold tracking-[-0.022em] text-[#0F172A] mt-1.5">
                {reviews.length === 0
                  ? 'You’re all caught up.'
                  : `${reviews.length} draft${reviews.length === 1 ? '' : 's'} ready for review`}
              </div>
            </div>
            <div className="w-9 h-9 rounded-[10px] bg-[#0F172A] text-white flex items-center justify-center shrink-0">
              <Sparkles className="w-3.5 h-3.5" />
            </div>
          </div>

          {reviews.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#E6E8EF] bg-white p-4 text-[12.5px] text-[#64748B]">
              When your AI drafts a reply that needs your eyes, it shows up here.
            </div>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {reviews.map((n) => (
                <li key={n.id}>
                  <a
                    href={n.href ?? '#'}
                    className="group flex items-start gap-3 p-3 rounded-xl border border-[#E6E8EF] bg-white hover:border-[#D5DAE3] hover:-translate-y-px transition-all"
                  >
                    <div className="w-[34px] h-[34px] rounded-[10px] bg-[#0F172A] text-white flex items-center justify-center shrink-0 text-[11.5px] font-semibold">
                      {n.initials ?? '—'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] text-[#0F172A]">{n.text}</div>
                      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[#64748B]">
                        <span className="flex items-center gap-1">
                          <Sparkles className="w-2.5 h-2.5" /> Draft ready
                        </span>
                        {n.meta ? (
                          <>
                            <span className="text-[#CBD5E1]">·</span>
                            <span>{n.meta}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-[#64748B] mt-2 group-hover:text-[#0F172A] transition-colors" />
                  </a>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            className="mt-4 w-full inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-[10px] border border-[#E6E8EF] text-[12.5px] text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Open AI Workspace
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  )
}
