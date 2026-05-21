'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  MessageSquare,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from 'lucide-react'

/**
 * GTM-0B — Demo dashboard preview section.
 *
 * Static marketing mock of the Revenue OS dashboard. Numbers are
 * illustrative — they match the GTM-0A demo seed so a buyer who
 * lands in a real demo sees the same shape.
 *
 * Hard rule: this section MUST NOT call the database. It's a
 * public marketing surface; no fetch, no auth, no Supabase.
 */

const leakBuckets = [
  {
    icon: MessageSquare,
    label: 'Slow replies',
    count: 5,
    helper: 'Inquiries waiting > 1 hour',
    tone: 'amber',
  },
  {
    icon: AlertTriangle,
    label: 'Qualified, no tour',
    count: 3,
    helper: 'High-fit leads needing a tour invite',
    tone: 'rose',
  },
  {
    icon: RefreshCw,
    label: 'Recovery candidates',
    count: 4,
    helper: 'Warm leads that went quiet',
    tone: 'violet',
  },
  {
    icon: Calendar,
    label: 'Tours to confirm',
    count: 2,
    helper: 'Scheduled, still unconfirmed',
    tone: 'blue',
  },
] as const

const sourceRows = [
  { label: 'Google Ads',  booked: '$42k', leads: 6 },
  { label: 'The Knot',    booked: '$27k', leads: 4 },
  { label: 'Referral',    booked: '$21k', leads: 3 },
  { label: 'Instagram',   booked: '—',    leads: 5 },
  { label: 'WeddingWire', booked: '—',    leads: 3 },
] as const

const TONE_CLASSES: Record<'amber' | 'rose' | 'violet' | 'blue', string> = {
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  rose: 'bg-rose-50 text-rose-700 border-rose-200',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
  blue: 'bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE]',
}

export default function DemoPreview() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })

  return (
    <section id="demo-preview" className="relative py-24 lg:py-32 bg-white overflow-hidden">
      <div className="noise-layer" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-[1fr_1.2fr] gap-12 items-start">
          {/* Left — narrative */}
          <div>
            <div className="section-label">A real demo</div>
            <h2 className="font-display text-[40px] sm:text-[52px] font-bold text-[#0A0A1A] leading-[1.05] tracking-[-0.02em] mb-6">
              See exactly where{' '}
              <span className="text-gradient">your revenue is leaking.</span>
            </h2>
            <p className="text-[#475569] text-[18px] leading-[1.6] mb-6 max-w-[520px]">
              In a demo, we load a realistic wedding venue pipeline and
              show exactly which leads are slipping, what they&rsquo;re
              worth, and what your team should do next.
            </p>
            <p className="text-[14px] text-[#64748B] leading-[1.6] mb-8 max-w-[520px]">
              The numbers below mirror the demo dataset we walk through
              live. Yours look different — your sources, your stages,
              your dollars — but the gaps are usually the same.
            </p>
            <Link
              href="/demo"
              className="inline-flex items-center gap-2 px-5 py-3 bg-[#1A6FFF] text-white text-[14px] font-semibold rounded-xl hover:bg-[#1058D6] transition-all duration-200 hover:shadow-[0_6px_24px_rgba(26,111,255,0.45)]"
            >
              Book a walkthrough
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          {/* Right — mock dashboard panel */}
          <motion.div
            ref={ref}
            initial={{ opacity: 0, y: 20 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="relative rounded-3xl border border-[#E2E8F0] bg-[#F8FAFC] shadow-[0_30px_80px_-20px_rgba(15,23,42,0.18)] overflow-hidden"
          >
            <div className="px-5 py-3 border-b border-[#E2E8F0] bg-white flex items-center gap-2 text-[11px] text-[#94A3B8]">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="ml-2 font-medium text-[#475569]">
                /dashboard · Revenue OS demo
              </span>
              <span className="ml-auto uppercase tracking-wider text-[10px] font-bold text-[#94A3B8]">
                Static preview
              </span>
            </div>
            <div className="p-6 space-y-5">
              {/* Pipeline at risk hero number */}
              <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="w-4 h-4 text-[#B45309]" />
                  <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#94A3B8]">
                    Pipeline at risk
                  </p>
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="text-[36px] font-bold text-[#0A0A1A] tracking-[-0.02em] tabular-nums leading-none">
                    $124k
                  </span>
                  <span className="text-[13px] text-[#475569]">
                    est. at-risk pipeline this month
                  </span>
                </div>
              </div>

              {/* Leak buckets */}
              <div className="grid grid-cols-2 gap-3">
                {leakBuckets.map(({ icon: Icon, label, count, helper, tone }) => (
                  <div
                    key={label}
                    className="rounded-xl border border-[#E2E8F0] bg-white p-3.5"
                  >
                    <div className="flex items-start gap-2.5">
                      <div
                        className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${TONE_CLASSES[tone]}`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-[#94A3B8]">
                          {label}
                        </p>
                        <p className="text-[19px] font-bold text-[#0A0A1A] tabular-nums leading-none mt-1">
                          {count}
                        </p>
                        <p className="text-[11px] text-[#475569] mt-1 leading-snug">
                          {helper}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Booked revenue by source */}
              <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-emerald-600" />
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#94A3B8]">
                      Booked revenue by source
                    </p>
                  </div>
                  <span className="text-[11px] text-[#94A3B8] tabular-nums">
                    Top 5
                  </span>
                </div>
                <div className="space-y-1.5">
                  {sourceRows.map((r) => (
                    <div
                      key={r.label}
                      className="flex items-center justify-between text-[13px]"
                    >
                      <span className="text-[#0A0A1A]">{r.label}</span>
                      <div className="flex items-baseline gap-3">
                        <span className="text-[11.5px] text-[#94A3B8] tabular-nums">
                          {r.leads} leads
                        </span>
                        <span
                          className={`font-semibold tabular-nums ${
                            r.booked === '—'
                              ? 'text-[#CBD5E1]'
                              : 'text-[#047857]'
                          }`}
                        >
                          {r.booked}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-3 pt-3 border-t border-[#F1F5F9] text-[11px] text-[#94A3B8] italic leading-relaxed">
                  Not ROAS. Estimated from operator-entered budgets. Ad
                  spend is not connected.
                </p>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
