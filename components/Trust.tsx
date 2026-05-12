'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import { MessageSquareQuote, Plug, ShieldCheck, Building2, Wrench } from 'lucide-react'

const trustPoints = [
  {
    icon: MessageSquareQuote,
    title: 'Human-approved brand voice',
    description:
      'Every response template is reviewed against your venue\'s voice and tone. Nothing goes out that does not sound like you.',
  },
  {
    icon: Plug,
    title: 'Works with what you already have',
    description:
      'Connects to your existing inbox, calendar, and CRM — Tave, HoneyBook, Aisle Planner, Google Workspace. No rip-and-replace.',
  },
  {
    icon: ShieldCheck,
    title: 'No robotic responses',
    description:
      'We never auto-send anything that feels generic. Sequences are reviewed, edited, and approved before launch.',
  },
  {
    icon: Building2,
    title: 'Built around venue sales workflows',
    description:
      'We understand tour scheduling, deposit timelines, vendor coordination, and the seasonal rhythm of venue revenue.',
  },
  {
    icon: Wrench,
    title: 'Setup handled entirely for you',
    description:
      'No DIY configuration. We build, test, and launch your system in two weeks. You just review the final voice and approve.',
  },
]

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.07 } },
}
const itemVariants = {
  hidden: { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } },
}

export default function Trust() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })

  return (
    <section className="relative py-24 lg:py-32 bg-white overflow-hidden">
      <div className="noise-layer" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />
      <div className="absolute top-1/3 right-0 w-[400px] h-[400px] bg-[#1A6FFF]/[0.04] rounded-full blur-[120px] pointer-events-none" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <div className="section-label mx-auto w-fit">Why Venues Trust Us</div>
          <h2 className="font-display text-[40px] sm:text-[52px] font-bold text-[#0A0A1A] leading-[1.05] tracking-[-0.02em] mb-6">
            Operationally serious.
            <span className="block text-gradient">On-brand by design.</span>
          </h2>
          <p className="text-[#475569] text-[18px] leading-[1.6]">
            We treat your inquiry pipeline the way a senior sales director would — with discipline, taste, and respect for your brand.
          </p>
        </div>

        <motion.div
          ref={ref}
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? 'visible' : 'hidden'}
          className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5"
        >
          {trustPoints.map((point, i) => {
            const Icon = point.icon
            return (
              <motion.div
                key={point.title}
                variants={itemVariants}
                whileHover={{ y: -4 }}
                transition={{ type: 'spring', stiffness: 280, damping: 22 }}
                className={`card-glass p-6 ${i >= 3 ? 'lg:col-span-1' : ''} ${i === 4 ? 'sm:col-span-2 lg:col-span-1' : ''}`}
              >
                <div className="w-11 h-11 rounded-xl bg-[#1A6FFF]/8 border border-[#1A6FFF]/15 flex items-center justify-center mb-5">
                  <Icon className="w-5 h-5 text-[#1A6FFF]" strokeWidth={1.85} />
                </div>
                <h3 className="font-display text-[19px] font-semibold text-[#0A0A1A] mb-2.5 leading-snug tracking-[-0.01em]">
                  {point.title}
                </h3>
                <p className="text-[14.5px] text-[#475569] leading-[1.6]">{point.description}</p>
              </motion.div>
            )
          })}
        </motion.div>
      </div>
    </section>
  )
}
