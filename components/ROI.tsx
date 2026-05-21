'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import Link from 'next/link'
import { ArrowRight, Check, Sparkles } from 'lucide-react'

/**
 * GTM-0B — High-ticket pilot offer section.
 *
 * Replaces the old ROI "3× more tours" metrics that we can't back
 * without case-study evidence. New shape: a services-assisted pilot
 * with concrete deliverables, no public price, and a clear next
 * step ("Apply for a pilot"). Pricing lives behind a sales
 * conversation until the price-discovery work is done.
 *
 * Honesty: NO guaranteed revenue claims. The bullets describe what
 * we *do during setup*, not what the buyer *will earn*.
 */

const pilotIncludes = [
  'Revenue Recovery setup — connect lead sources and verify each channel',
  'Lead-source mapping — website, Instagram, The Knot, WeddingWire, Meta Ads, email',
  'Brand voice + knowledge base configuration — drafts that sound like you',
  'Tour availability + blackout setup — so draft slot suggestions match your real calendar',
  'Weekly leakage review — we walk the dashboard with your team and flag the highest-value next actions',
  'Operator training — your team learns to triage drafts, mark sends, and use the Revenue OS panels',
]

export default function ROI() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })

  return (
    <section id="pilot" className="relative py-24 lg:py-32 surface-alt overflow-hidden">
      <div className="absolute inset-0 grid-bg opacity-60" />
      <div className="noise-layer" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-[#1A6FFF]/[0.04] rounded-full blur-[140px] pointer-events-none" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <div className="section-label mx-auto w-fit">Pilot</div>
          <h2 className="font-display text-[40px] sm:text-[52px] font-bold text-[#0A0A1A] leading-[1.05] tracking-[-0.02em] mb-6">
            We install VenueRise{' '}
            <span className="text-gradient">with your team.</span>
          </h2>
          <p className="text-[#475569] text-[18px] leading-[1.6]">
            Connect lead sources, configure brand voice, add the
            knowledge base, set availability, and review revenue leaks
            together. The pilot is designed to make the first 30 days
            tangible — not to sell you a license and disappear.
          </p>
        </div>

        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 18 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
          className="grid lg:grid-cols-[1.4fr_1fr] gap-6 items-stretch"
        >
          {/* Pilot includes card */}
          <div className="rounded-3xl border border-[#E2E8F0] bg-white p-7 lg:p-9 shadow-[0_20px_60px_-25px_rgba(15,23,42,0.18)]">
            <div className="flex items-center gap-2 mb-5">
              <Sparkles className="w-4 h-4 text-[#1D4ED8]" />
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#94A3B8]">
                What the pilot includes
              </p>
            </div>
            <ul className="space-y-3.5">
              {pilotIncludes.map((b) => (
                <li key={b} className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-[#EFF6FF] text-[#1D4ED8] flex items-center justify-center shrink-0 mt-0.5">
                    <Check className="w-3 h-3" strokeWidth={3} />
                  </div>
                  <span className="text-[14.5px] text-[#0A0A1A] leading-[1.55]">
                    {b}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Apply card */}
          <div className="rounded-3xl border border-[#1A6FFF]/25 bg-gradient-to-br from-[#0F172A] via-[#1E293B] to-[#0F172A] text-white p-7 lg:p-9 flex flex-col">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/55 mb-4">
              Pilot packages
            </p>
            <p className="font-display text-[28px] lg:text-[32px] font-semibold leading-tight tracking-[-0.01em] mb-4">
              Pilot packages available for a limited cohort of venues.
            </p>
            <p className="text-[14px] text-white/72 leading-[1.6] mb-7">
              We&rsquo;re onboarding a small group of venues together so
              the team can walk every dashboard surface with you. Send
              us your venue and current setup — we&rsquo;ll reply within
              one business day.
            </p>
            <div className="mt-auto">
              <Link
                href="/demo"
                className="inline-flex items-center justify-center gap-2 w-full px-5 py-3 bg-white text-[#0F172A] text-[14px] font-semibold rounded-xl hover:bg-white/90 transition-colors"
              >
                Apply for a pilot
                <ArrowRight className="w-4 h-4" />
              </Link>
              <p className="text-[11px] text-white/55 mt-3 leading-relaxed">
                No public pricing yet. Conversation first — fit, scope,
                and what success looks like before we quote.
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
