'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown } from 'lucide-react'

/**
 * GTM-0B — FAQ section.
 *
 * Functions as anti-positioning: the questions you'd get on a first
 * sales call ("Is this a CRM?", "Does it replace HoneyBook?",
 * "Does AI send for me?"). Honest answers — no overclaims.
 */

const faqs = [
  {
    q: 'Is this a CRM?',
    a: "No. VenueRise sits above your lead sources and helps recover revenue leaks. If you already have a CRM you love, we work next to it — the dashboard surfaces the gaps your CRM doesn't show.",
  },
  {
    q: 'Does it replace HoneyBook, Tripleseat, The Knot, or WeddingWire?',
    a: "No. It connects around them. The Knot and WeddingWire stay your listing platforms; HoneyBook and Tripleseat stay your event management. VenueRise is the layer that watches every inquiry across all of them and helps your team act faster.",
  },
  {
    q: 'Does AI send messages automatically?',
    a: "No. AI drafts; your team approves. Manual-required channels — Instagram, The Knot, WeddingWire, Meta Ads — stay operator-sent until you've verified a direct integration. We do not enable autonomous sending by default.",
  },
  {
    q: 'What channels can it support?',
    a: 'Website widget, Instagram DMs, Meta Lead Ads, The Knot, WeddingWire, and manual email workflows — depending on your setup. The pilot includes lead-source mapping so you only connect what you actually use.',
  },
  {
    q: 'How do you measure value?',
    a: "We track leads, tours, booked outcomes, source attribution, and estimated pipeline. We do not promise guaranteed revenue. The dashboard tells you which sources became real bookings and which leakage signals fired this week — and the weekly leakage review walks it with you.",
  },
  {
    q: 'How long does setup take?',
    a: 'Pilot setup is designed to be lightweight: venue profile, lead sources, knowledge base, availability, and team training. Most venues are operating the daily workflow within the first week.',
  },
  {
    q: 'Is this only for wedding venues?',
    a: 'Yes — the current product is built specifically around wedding and event venues. Tour booking, seasonal pacing, vendor questions, package pricing, and weekend Saturday dynamics are all baked into how Revenue OS reasons about leads.',
  },
]

function FaqItem({ q, a, isOpen, onToggle }: { q: string; a: string; isOpen: boolean; onToggle: () => void }) {
  return (
    <div className="border-b border-[#E2E8F0] last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="w-full text-left flex items-center justify-between gap-4 py-5 group"
      >
        <span className="font-display text-[18px] font-semibold text-[#0A0A1A] tracking-[-0.005em] group-hover:text-[#1D4ED8] transition-colors">
          {q}
        </span>
        <span
          className={`w-9 h-9 rounded-full bg-[#F1F5F9] text-[#475569] flex items-center justify-center transition-transform shrink-0 ${isOpen ? 'rotate-180 bg-[#EFF6FF] text-[#1D4ED8]' : ''}`}
        >
          <ChevronDown className="w-4 h-4" />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <p className="pb-5 pr-12 text-[14.5px] text-[#475569] leading-[1.7]">
              {a}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function FAQ() {
  // First question opens by default — gives the section a visible
  // answer above the fold for skim-readers.
  const [openIdx, setOpenIdx] = useState<number | null>(0)

  return (
    <section id="faq" className="relative py-24 lg:py-32 bg-white overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />

      <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-12">
          <div className="section-label">FAQ</div>
          <h2 className="font-display text-[40px] sm:text-[52px] font-bold text-[#0A0A1A] leading-[1.05] tracking-[-0.02em] mb-4">
            The questions{' '}
            <span className="text-gradient">venue owners ask first.</span>
          </h2>
          <p className="text-[#475569] text-[17px] leading-[1.6] max-w-[600px]">
            Straight answers, no hedging.
          </p>
        </div>

        <div className="rounded-3xl border border-[#E2E8F0] bg-white shadow-[0_8px_24px_-12px_rgba(15,23,42,0.10)] px-6 lg:px-8">
          {faqs.map((f, i) => (
            <FaqItem
              key={f.q}
              q={f.q}
              a={f.a}
              isOpen={openIdx === i}
              onToggle={() => setOpenIdx(openIdx === i ? null : i)}
            />
          ))}
        </div>
      </div>
    </section>
  )
}
