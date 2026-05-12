'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import { Zap, Filter, MessageCircle, Calendar, RotateCcw, LayoutDashboard, type LucideIcon } from 'lucide-react'

const solutions = [
  {
    icon: Zap,
    title: 'Instant inquiry response',
    description:
      'Every inquiry receives a warm, personalized reply in under 60 seconds — including Saturdays at midnight.',
    highlight: true,
  },
  {
    icon: Filter,
    title: 'Lead qualification, automated',
    description:
      'Guest count, event date, budget range, vendor needs — captured and structured before your team spends a minute on a call.',
  },
  {
    icon: MessageCircle,
    title: 'Multi-touch follow-up sequences',
    description:
      'SMS and email touchpoints that sound human and on-brand — designed around how couples actually plan.',
  },
  {
    icon: Calendar,
    title: 'Self-scheduled tours',
    description:
      'Couples pick a tour slot from your real-time calendar. Automatic reminders cut no-show rates in half.',
  },
  {
    icon: RotateCcw,
    title: 'Dead-lead recovery',
    description:
      'Inquiries that went quiet 30, 60, or 90 days ago get re-engaged through campaigns timed to peak planning seasons.',
  },
  {
    icon: LayoutDashboard,
    title: 'Owner-level pipeline visibility',
    description:
      'See every lead, every stage, every touchpoint in one dashboard. Forecast revenue with real numbers.',
  },
]

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.07 } },
}
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } },
}

export default function Solution() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })

  return (
    <section id="solutions" className="relative py-24 lg:py-32 surface-alt overflow-hidden">
      <div className="noise-layer" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[500px] bg-[#1A6FFF]/[0.04] rounded-full blur-[140px] pointer-events-none" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <div className="section-label mx-auto w-fit">The System</div>
          <h2 className="font-display text-[40px] sm:text-[52px] font-bold text-[#0A0A1A] leading-[1.05] tracking-[-0.02em] mb-6">
            Respond instantly.
            <span className="block text-gradient">Follow up relentlessly.</span>
            <span className="block">Book more tours.</span>
          </h2>
          <p className="text-[#475569] text-[18px] leading-[1.6]">
            Six capabilities operating as one revenue system. No bolt-on widgets, no rip-and-replace.
          </p>
        </div>

        <motion.div
          ref={ref}
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? 'visible' : 'hidden'}
          className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5"
        >
          {solutions.map((item) => {
            const Icon = item.icon
            return (
              <motion.div
                key={item.title}
                variants={itemVariants}
                whileHover={{ y: -5 }}
                transition={{ type: 'spring', stiffness: 280, damping: 22 }}
                className="group relative"
              >
                {item.highlight ? (
                  <div className="border-animated p-[1.5px] rounded-2xl h-full">
                    <div className="bg-white rounded-[15px] h-full p-6">
                      <SolutionInner Icon={Icon} title={item.title} description={item.description} />
                    </div>
                  </div>
                ) : (
                  <div className="card-blue p-6 h-full hover:border-[#1A6FFF]/35 transition-colors duration-300">
                    <SolutionInner Icon={Icon} title={item.title} description={item.description} />
                  </div>
                )}
              </motion.div>
            )
          })}
        </motion.div>
      </div>
    </section>
  )
}

function SolutionInner({
  Icon,
  title,
  description,
}: {
  Icon: LucideIcon
  title: string
  description: string
}) {
  return (
    <>
      <div className="relative w-11 h-11 rounded-xl bg-[#1A6FFF]/8 border border-[#1A6FFF]/15 flex items-center justify-center mb-5 group-hover:bg-[#1A6FFF]/12 group-hover:border-[#1A6FFF]/30 transition-all duration-300">
        <Icon className="w-5 h-5 text-[#1A6FFF]" strokeWidth={1.85} />
      </div>
      <h3 className="font-display text-[19px] font-semibold text-[#0A0A1A] mb-2.5 leading-snug tracking-[-0.01em]">
        {title}
      </h3>
      <p className="text-[14.5px] text-[#475569] leading-[1.6]">{description}</p>
    </>
  )
}
