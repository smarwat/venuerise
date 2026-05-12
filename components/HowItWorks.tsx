'use client'

import { motion, useInView, useScroll, useTransform } from 'framer-motion'
import { useRef } from 'react'
import { Search, Settings2, Rocket, TrendingUp } from 'lucide-react'

const steps = [
  {
    number: '01',
    icon: Search,
    title: 'We audit your inquiry flow',
    description:
      'We map every step of your current pipeline — response times, drop-off points, follow-up gaps. You walk away with full visibility, even if you never work with us.',
    detail: 'Free 30-min strategy session',
  },
  {
    number: '02',
    icon: Settings2,
    title: 'We build your venue system',
    description:
      'Custom response sequences, qualification logic, and follow-up cadence — tailored to your brand voice and sales process. Every message reviewed before launch.',
    detail: '7–14 day build timeline',
  },
  {
    number: '03',
    icon: Rocket,
    title: 'We launch and monitor live',
    description:
      'Your system goes live. Every inquiry gets an instant, on-brand reply. Every lead enters a structured sequence. Your team focuses on tours, not chasing.',
    detail: 'Live within two weeks',
  },
  {
    number: '04',
    icon: TrendingUp,
    title: 'We optimize for booked tours',
    description:
      'We analyze which sequences book the most tours and refine timing, copy, and triggers monthly. Your system gets sharper every cycle.',
    detail: 'Ongoing optimization included',
  },
]

export default function HowItWorks() {
  const containerRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(containerRef, { once: true, margin: '-80px' })

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start 70%', 'end 60%'],
  })
  const lineProgress = useTransform(scrollYProgress, [0, 1], ['0%', '100%'])

  return (
    <section id="how-it-works" className="relative py-24 lg:py-32 bg-white overflow-hidden">
      <div className="noise-layer" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-20">
          <div className="section-label mx-auto w-fit">The Process</div>
          <h2 className="font-display text-[40px] sm:text-[52px] font-bold text-[#0A0A1A] leading-[1.05] tracking-[-0.02em] mb-6">
            From audit to automation
            <span className="block text-gradient">in four steps.</span>
          </h2>
          <p className="text-[#475569] text-[18px] leading-[1.6]">
            We handle the complexity so your team can focus on what they do best — hosting unforgettable events.
          </p>
        </div>

        <div ref={containerRef} className="relative">
          {/* Connector line — desktop */}
          <div className="hidden lg:block absolute top-[26px] left-[calc(12.5%+26px)] right-[calc(12.5%+26px)] h-[2px] bg-black/[0.06] rounded-full overflow-hidden">
            <motion.div
              style={{ width: lineProgress }}
              className="h-full bg-gradient-to-r from-[#1A6FFF] to-[#5591FF] rounded-full"
            />
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-10 lg:gap-6">
            {steps.map((step, i) => {
              const Icon = step.icon
              return (
                <motion.div
                  key={step.number}
                  initial={{ opacity: 0, y: 24 }}
                  animate={isInView ? { opacity: 1, y: 0 } : {}}
                  transition={{ duration: 0.6, delay: i * 0.1, ease: [0.22, 1, 0.36, 1] }}
                  className="flex flex-col items-start lg:items-center text-left lg:text-center"
                >
                  <div className="relative mb-6">
                    <div className="w-[54px] h-[54px] rounded-full bg-white border-[2px] border-[#1A6FFF]/30 flex items-center justify-center relative z-10 shadow-[0_0_0_8px_rgba(26,111,255,0.05)]">
                      <Icon className="w-5 h-5 text-[#1A6FFF]" strokeWidth={1.85} />
                    </div>
                  </div>

                  <span className="text-[11px] font-bold text-[#1A6FFF]/65 uppercase tracking-[0.14em] mb-2">
                    Step {step.number}
                  </span>

                  <h3 className="font-display text-[20px] font-semibold text-[#0A0A1A] mb-3 leading-snug tracking-[-0.01em] max-w-[260px]">
                    {step.title}
                  </h3>

                  <p className="text-[14.5px] text-[#475569] leading-[1.6] mb-5 max-w-[280px]">
                    {step.description}
                  </p>

                  <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#1A6FFF] uppercase tracking-[0.12em] border border-[#1A6FFF]/20 rounded-full px-3 py-1.5 bg-[#1A6FFF]/[0.04]">
                    <span className="w-1 h-1 rounded-full bg-[#1A6FFF]" />
                    {step.detail}
                  </span>
                </motion.div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
