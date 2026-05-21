'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import { Clock, Calendar, Ghost, CheckSquare, BarChart2 } from 'lucide-react'

/**
 * GTM-0B — "Revenue leaks" section.
 *
 * Five operator-language cards that name the exact gaps Revenue OS
 * catches. Wording mirrors the dashboard surfaces (Slow first reply,
 * Qualified no tour, Cold recovery, Tour Confirmation, Source
 * leakage) so a buyer who lands on a demo immediately recognizes
 * the pattern.
 */

const pains = [
  {
    icon: Clock,
    title: 'Slow replies',
    description:
      'A strong inquiry sits unanswered while the couple books a tour at another venue. The clock matters and your team is in tastings.',
    iconColor: 'text-amber-600',
    iconBg: 'bg-amber-50',
  },
  {
    icon: CheckSquare,
    title: 'Qualified, no tour',
    description:
      'The couple is a fit — budget, date, guest count — but nobody pushes them to the next step. The conversation just stops.',
    iconColor: 'text-rose-600',
    iconBg: 'bg-rose-50',
  },
  {
    icon: Ghost,
    title: 'Cold follow-up',
    description:
      'A warm lead ghosts. Without a thoughtful recovery message at the right moment, they pick whoever circled back.',
    iconColor: 'text-violet-600',
    iconBg: 'bg-violet-50',
  },
  {
    icon: Calendar,
    title: 'Unconfirmed tours',
    description:
      'The tour is on the calendar, but nobody confirms, reminds, or recovers the no-show. Your weekend slots burn anyway.',
    iconColor: 'text-blue-600',
    iconBg: 'bg-blue-50',
  },
  {
    icon: BarChart2,
    title: 'Source blind spots',
    description:
      "You know how many leads came in. You don't know which sources became booked weddings. The Knot? Instagram? Google? You're guessing.",
    iconColor: 'text-emerald-600',
    iconBg: 'bg-emerald-50',
  },
]

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.07 } },
}

const itemVariants = {
  hidden: { opacity: 0, y: 22 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] } },
}

export default function PainPoints() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })

  return (
    <section id="leaks" className="relative py-24 lg:py-32 bg-white overflow-hidden">
      <div className="noise-layer" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl mb-16">
          <div className="section-label">Where revenue leaks</div>
          <h2 className="font-display text-[40px] sm:text-[52px] font-bold text-[#0A0A1A] leading-[1.05] tracking-[-0.02em] mb-6">
            Five gaps that quietly{' '}
            <span className="text-gradient">cost you weddings.</span>
          </h2>
          <p className="text-[#475569] text-[18px] leading-[1.6] max-w-[640px]">
            Your venue is built to host unforgettable events. But the
            system that turns a first email into a signed contract is
            usually a coordinator, a shared inbox, and good intentions.
            That&rsquo;s where the money slips.
          </p>
        </div>

        <motion.div
          ref={ref}
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? 'visible' : 'hidden'}
          className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5"
        >
          {pains.map((pain, i) => {
            const Icon = pain.icon
            return (
              <motion.div
                key={pain.title}
                variants={itemVariants}
                whileHover={{ y: -4 }}
                transition={{ type: 'spring', stiffness: 280, damping: 22 }}
                className={`card-glass p-6 ${i === 4 ? 'sm:col-span-2 lg:col-span-1' : ''}`}
              >
                <div className={`w-11 h-11 rounded-xl ${pain.iconBg} flex items-center justify-center mb-5`}>
                  <Icon className={`w-5 h-5 ${pain.iconColor}`} strokeWidth={2} />
                </div>
                <h3 className="font-display text-[19px] font-semibold text-[#0A0A1A] mb-2.5 leading-snug tracking-[-0.01em]">
                  {pain.title}
                </h3>
                <p className="text-[14.5px] text-[#475569] leading-[1.6]">
                  {pain.description}
                </p>
              </motion.div>
            )
          })}
        </motion.div>
      </div>
    </section>
  )
}
