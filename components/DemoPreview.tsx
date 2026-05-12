'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import { Mail, BrainCircuit, CalendarCheck, MessageSquare, Database } from 'lucide-react'

const steps = [
  {
    icon: Mail,
    label: 'Inquiry received',
    sub: 'Sarah & James · June 2026',
    color: 'text-sky-600',
    bg: 'bg-sky-50',
    border: 'border-sky-200',
  },
  {
    icon: BrainCircuit,
    label: 'Lead qualified',
    sub: 'Budget · Date · Guest count',
    color: 'text-violet-600',
    bg: 'bg-violet-50',
    border: 'border-violet-200',
  },
  {
    icon: CalendarCheck,
    label: 'Tour booked',
    sub: 'Sat March 22 · 2:00 PM',
    color: 'text-emerald-600',
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
  },
  {
    icon: MessageSquare,
    label: 'Follow-up sent',
    sub: '7-day nurture sequence',
    color: 'text-amber-600',
    bg: 'bg-amber-50',
    border: 'border-amber-200',
  },
  {
    icon: Database,
    label: 'CRM updated',
    sub: 'Pipeline · Stage · Notes',
    color: 'text-[#1A6FFF]',
    bg: 'bg-[#EEF4FF]',
    border: 'border-[#1A6FFF]/25',
  },
]

export default function DemoPreview() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })

  return (
    <section className="relative py-24 lg:py-32 bg-white overflow-hidden">
      <div className="noise-layer" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <div className="section-label mx-auto w-fit">See It In Action</div>
          <h2 className="font-display text-[40px] sm:text-[52px] font-bold text-[#0A0A1A] leading-[1.05] tracking-[-0.02em] mb-6">
            From inquiry to booked tour —
            <span className="block text-gradient">fully automated.</span>
          </h2>
          <p className="text-[#475569] text-[18px] leading-[1.6]">
            Watch how a single inquiry flows through the VenueRise system without a manual action from your team.
          </p>
        </div>

        <div ref={ref} className="relative">
          {/* Desktop: horizontal */}
          <div className="hidden lg:flex items-start justify-between gap-3 relative">
            <div className="absolute top-[26px] left-[8%] right-[8%] h-[2px] bg-black/[0.06] rounded-full" />
            <motion.div
              initial={{ scaleX: 0 }}
              animate={isInView ? { scaleX: 1 } : {}}
              transition={{ duration: 1.5, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
              style={{ transformOrigin: 'left' }}
              className="absolute top-[26px] left-[8%] right-[8%] h-[2px] bg-gradient-to-r from-sky-400 via-emerald-400 to-[#1A6FFF] rounded-full"
            />

            {steps.map((step, i) => {
              const Icon = step.icon
              return (
                <div key={step.label} className="flex flex-col items-center text-center flex-1">
                  <motion.div
                    initial={{ opacity: 0, scale: 0.65 }}
                    animate={isInView ? { opacity: 1, scale: 1 } : {}}
                    transition={{ duration: 0.5, delay: 0.4 + i * 0.14, ease: [0.22, 1, 0.36, 1] }}
                    className={`relative w-[54px] h-[54px] rounded-full ${step.bg} border ${step.border} flex items-center justify-center mb-5 z-10 shadow-md`}
                  >
                    <Icon className={`w-5 h-5 ${step.color}`} strokeWidth={1.85} />
                  </motion.div>

                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={isInView ? { opacity: 1, y: 0 } : {}}
                    transition={{ duration: 0.45, delay: 0.55 + i * 0.14 }}
                  >
                    <p className={`text-[14px] font-semibold ${step.color} mb-1`}>{step.label}</p>
                    <p className="text-[12px] text-[#94A3B8]">{step.sub}</p>
                  </motion.div>
                </div>
              )
            })}
          </div>

          {/* Mobile: vertical */}
          <div className="flex lg:hidden flex-col gap-0">
            {steps.map((step, i) => {
              const Icon = step.icon
              return (
                <div key={step.label}>
                  <motion.div
                    initial={{ opacity: 0, x: -14 }}
                    animate={isInView ? { opacity: 1, x: 0 } : {}}
                    transition={{ duration: 0.5, delay: i * 0.1 }}
                    className="flex items-center gap-4 py-4"
                  >
                    <div
                      className={`flex-shrink-0 w-12 h-12 rounded-full ${step.bg} border ${step.border} flex items-center justify-center shadow-sm`}
                    >
                      <Icon className={`w-5 h-5 ${step.color}`} strokeWidth={1.85} />
                    </div>
                    <div>
                      <p className={`text-[14px] font-semibold ${step.color}`}>{step.label}</p>
                      <p className="text-[12px] text-[#94A3B8]">{step.sub}</p>
                    </div>
                  </motion.div>
                  {i < steps.length - 1 && <div className="w-px h-6 bg-black/[0.07] ml-[23px]" />}
                </div>
              )
            })}
          </div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.6, delay: 1.1 }}
            className="mt-14 card-blue p-7 lg:p-8 text-center bg-white"
          >
            <p className="text-[15px] text-[#475569] leading-relaxed max-w-3xl mx-auto">
              All of this happens{' '}
              <span className="text-[#1A6FFF] font-semibold">automatically</span> — while your team
              focuses on tours, vendors, and creating the kind of weddings that get talked about for years.
            </p>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
