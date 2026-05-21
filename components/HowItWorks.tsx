'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import { Inbox, Search, MessageSquare, BarChart3 } from 'lucide-react'

/**
 * GTM-0B — "How VenueRise works" — 4-step flow.
 *
 * Frame this as a layer that sits ON TOP of existing tools, not a
 * replacement. The CRM/PMS question gets answered later in the FAQ;
 * here we just describe the loop:
 *
 *   1. Unify  →  2. Detect  →  3. Draft  →  4. Track
 */

const steps = [
  {
    icon: Inbox,
    number: '01',
    title: 'Unify inquiries',
    description:
      'Website widget, Instagram DMs, Meta Lead Ads, The Knot, WeddingWire, and manual email get pulled into one inbox with source tracking.',
    bullets: [
      'Website embed + form widget',
      'Manual + integrated channel routing',
      'Per-source attribution stamped at intake',
    ],
  },
  {
    icon: Search,
    number: '02',
    title: 'Detect revenue leaks',
    description:
      'Revenue OS scans every lead against the gaps that quietly kill bookings: slow reply, high-fit idle, no tour booked, cold lead, reactivation candidate.',
    bullets: [
      'Slow first reply + cold lead recovery',
      'Qualified-no-tour and tour-pending-confirm',
      'Reactivation queue for lost-but-not-cold leads',
    ],
  },
  {
    icon: MessageSquare,
    number: '03',
    title: 'Draft the next best reply',
    description:
      'AI drafts brand-safe replies for tour invites, follow-ups, recovery, reactivation, and FAQs. Your team approves before anything goes out.',
    bullets: [
      'Brand voice + knowledge base guided drafts',
      'Multiple variants per draft',
      'Manual-required channels stay operator-sent',
    ],
  },
  {
    icon: BarChart3,
    number: '04',
    title: 'Track booked-tour outcomes',
    description:
      'Per-source pipeline, estimated booked value, and tour conversion rates show which channels and follow-ups actually move leads forward.',
    bullets: [
      'Attribution Performance + Booked Revenue by Source',
      'Tour Booking + Speed-to-Lead roll-ups',
      'Source-level leakage breakdown',
    ],
  },
]

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08 } },
}
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] } },
}

export default function HowItWorks() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })

  return (
    <section
      id="how-it-works"
      className="relative py-24 lg:py-32 bg-[#F4F7FF] overflow-hidden"
    >
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl mb-16">
          <div className="section-label">How VenueRise works</div>
          <h2 className="font-display text-[40px] sm:text-[52px] font-bold text-[#0A0A1A] leading-[1.05] tracking-[-0.02em] mb-6">
            A revenue loop that{' '}
            <span className="text-gradient">sits on top of your tools.</span>
          </h2>
          <p className="text-[#475569] text-[18px] leading-[1.6] max-w-[640px]">
            VenueRise doesn&rsquo;t replace your CRM, your event-management
            software, or your inbox. It connects around them so your team
            can see what&rsquo;s slipping and act on it.
          </p>
        </div>

        <motion.div
          ref={ref}
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? 'visible' : 'hidden'}
          className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5"
        >
          {steps.map((step) => {
            const Icon = step.icon
            return (
              <motion.div
                key={step.number}
                variants={itemVariants}
                whileHover={{ y: -4 }}
                transition={{ type: 'spring', stiffness: 280, damping: 22 }}
                className="card-glass p-6 flex flex-col"
              >
                <div className="flex items-center gap-2.5 mb-4">
                  <span className="text-[11px] font-bold text-[#1A6FFF] tabular-nums tracking-[0.16em]">
                    {step.number}
                  </span>
                  <div className="h-px flex-1 bg-[#E2E8F0]" />
                </div>
                <div className="w-10 h-10 rounded-xl bg-[#EFF6FF] text-[#1D4ED8] flex items-center justify-center mb-4">
                  <Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <h3 className="font-display text-[18px] font-semibold text-[#0A0A1A] mb-2.5 leading-snug tracking-[-0.01em]">
                  {step.title}
                </h3>
                <p className="text-[13.5px] text-[#475569] leading-[1.6] mb-3">
                  {step.description}
                </p>
                <ul className="mt-auto space-y-1.5">
                  {step.bullets.map((b) => (
                    <li
                      key={b}
                      className="text-[12px] text-[#64748B] flex items-start gap-1.5"
                    >
                      <span className="text-[#1A6FFF] mt-1 leading-none">·</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            )
          })}
        </motion.div>
      </div>
    </section>
  )
}
