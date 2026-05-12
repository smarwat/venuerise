'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import { Clock, Ghost, Users, CalendarOff, BarChart2 } from 'lucide-react'

const pains = [
  {
    icon: Clock,
    title: 'Inquiries answered too late',
    description:
      "Couples contact four to six venues at once. If you don't respond within an hour, you've already lost. Manual handling costs you bookings before you've even seen the email.",
    iconColor: 'text-orange-600',
    iconBg: 'bg-orange-50',
  },
  {
    icon: Ghost,
    title: 'Leads that quietly disappear',
    description:
      'One follow-up. Maybe two. Then silence. Without a structured multi-touch sequence, hot leads cool off and your Saturday dates stay open.',
    iconColor: 'text-violet-600',
    iconBg: 'bg-violet-50',
  },
  {
    icon: Users,
    title: 'Coordinators stretched thin',
    description:
      'Your team is managing tours, tastings, vendors, and live events. Asking them to also chase every cold lead burns out your best people.',
    iconColor: 'text-rose-600',
    iconBg: 'bg-rose-50',
  },
  {
    icon: CalendarOff,
    title: 'Empty dates you can never refill',
    description:
      'Every unbooked Saturday is revenue you cannot recover next quarter. Your calendar should not depend on perfect manual follow-up.',
    iconColor: 'text-red-600',
    iconBg: 'bg-red-50',
  },
  {
    icon: BarChart2,
    title: 'No visibility into the pipeline',
    description:
      "You cannot forecast revenue when every deal lives in someone's inbox. Owners deserve a real view of lead status and recovery.",
    iconColor: 'text-amber-600',
    iconBg: 'bg-amber-50',
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
    <section id="pain" className="relative py-24 lg:py-32 bg-white overflow-hidden">
      <div className="noise-layer" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl mb-16">
          <div className="section-label">The Problem</div>
          <h2 className="font-display text-[40px] sm:text-[52px] font-bold text-[#0A0A1A] leading-[1.05] tracking-[-0.02em] mb-6">
            Revenue is leaking{' '}
            <span className="text-gradient">at the inquiry stage.</span>
          </h2>
          <p className="text-[#475569] text-[18px] leading-[1.6] max-w-[560px]">
            Your venue is built to host unforgettable events. But the system that turns a first
            email into a signed contract is usually a coordinator, a shared inbox, and good intentions.
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
