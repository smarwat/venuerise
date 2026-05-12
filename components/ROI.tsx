'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import { Clock, Zap, Calendar, Users } from 'lucide-react'
import CTAButton from './ui/CTAButton'
import { ArrowRight } from 'lucide-react'

const metrics = [
  {
    icon: Clock,
    value: '24/7',
    label: 'Always-on response',
    description: 'Inquiries answered around the clock — weekends, holidays, and after hours.',
  },
  {
    icon: Zap,
    value: '< 60s',
    label: 'Average response time',
    description: 'Couples receive a warm, personalized reply in under a minute.',
  },
  {
    icon: Calendar,
    value: '3×',
    label: 'More tours booked',
    description: 'Venues with structured follow-up book significantly more tours from the same inquiry volume.',
  },
  {
    icon: Users,
    value: '80%',
    label: 'Less manual follow-up',
    description: 'Your coordinators focus on tours and events — not chasing leads through inboxes.',
  },
]

function MetricCard({
  icon: Icon,
  value,
  label,
  description,
  index,
}: (typeof metrics)[0] & { index: number }) {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-50px' })

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 20 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.55, delay: index * 0.08, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -4 }}
      className="group relative"
    >
      <div className="card-blue p-6 h-full overflow-hidden hover:border-[#1A6FFF]/35 transition-colors duration-300 bg-white">
        <div className="absolute inset-0 bg-gradient-to-br from-[#1A6FFF]/[0.04] to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none rounded-2xl" />

        <div className="w-10 h-10 rounded-xl bg-[#1A6FFF]/8 border border-[#1A6FFF]/15 flex items-center justify-center mb-5">
          <Icon className="w-4.5 h-4.5 text-[#1A6FFF]" strokeWidth={1.85} />
        </div>

        <p className="font-display text-[40px] font-bold text-gradient mb-1 tabular-nums tracking-tight leading-none">
          {value}
        </p>
        <p className="text-[14px] font-semibold text-[#0A0A1A] mb-2 mt-3">{label}</p>
        <p className="text-[14px] text-[#475569] leading-[1.55]">{description}</p>
      </div>
    </motion.div>
  )
}

export default function ROI() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })

  return (
    <section id="roi" className="relative py-24 lg:py-32 surface-alt overflow-hidden">
      <div className="absolute inset-0 grid-bg opacity-60" />
      <div className="noise-layer" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-[#1A6FFF]/[0.04] rounded-full blur-[140px] pointer-events-none" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <div className="section-label mx-auto w-fit">The Numbers</div>
          <h2 className="font-display text-[40px] sm:text-[52px] font-bold text-[#0A0A1A] leading-[1.05] tracking-[-0.02em] mb-6">
            One recovered booking
            <span className="block text-gradient">pays for the system.</span>
          </h2>
          <p className="text-[#475569] text-[18px] leading-[1.6]">
            The average wedding booking is worth $8,000–$25,000. VenueRise pays for itself the moment it recovers a single lead your team would have lost.
          </p>
        </div>

        <div ref={ref} className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-14">
          {metrics.map((metric, i) => (
            <MetricCard key={metric.label} {...metric} index={i} />
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6, delay: 0.5 }}
          className="relative overflow-hidden rounded-2xl border border-[#1A6FFF]/18 bg-gradient-to-r from-[#1A6FFF]/[0.06] via-[#1A6FFF]/[0.03] to-white p-8 lg:p-10"
        >
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-72 h-px bg-gradient-to-r from-transparent via-[#1A6FFF]/50 to-transparent" />
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
            <div className="flex-1">
              <p className="font-display text-[24px] sm:text-[28px] font-semibold text-[#0A0A1A] mb-2 tracking-[-0.01em] leading-tight">
                A single recovered booking pays for 12 months of VenueRise.
              </p>
              <p className="text-[#475569] text-[15px] max-w-2xl leading-relaxed">
                Most venues leave 20–40% of inquiries unbooked due to slow response and inconsistent follow-up. We close that gap.
              </p>
            </div>
            <CTAButton href="#audit" variant="primary">
              See Your Numbers
              <ArrowRight className="w-4 h-4" />
            </CTAButton>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
