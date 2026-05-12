'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import { CheckCircle2, X, Mic2, Eye, TrendingUp, Building2, Workflow } from 'lucide-react'

const differentiators = [
  {
    icon: Building2,
    title: 'Built for venue revenue operations',
    description:
      'Inquiry cycles, tour scheduling, deposit timing, seasonal pacing. We speak venue sales, not generic SaaS.',
  },
  {
    icon: Workflow,
    title: 'Handles qualification and booking flow',
    description:
      'Not just replies — full sequence ownership from first message to confirmed tour to recovered cold lead.',
  },
  {
    icon: Mic2,
    title: 'Designed to protect your brand voice',
    description:
      'Every template hand-tuned to your venue. No corporate phrasing, no robotic sign-offs, no off-brand language.',
  },
  {
    icon: Eye,
    title: 'Visibility into lost-lead recovery',
    description:
      "Owners can see exactly which inquiries the system saved that would have otherwise gone quiet. The numbers are unambiguous.",
  },
  {
    icon: TrendingUp,
    title: 'An operating system, not a widget',
    description:
      'VenueRise sits across your inquiry stack as infrastructure. It does not bolt on, it operates.',
  },
]

const notThis = [
  'A generic AI chatbot on your site',
  'A one-size-fits-all CRM',
  'A widget that answers FAQs',
  'A standalone email autoresponder',
  'An impersonal canned reply tool',
]
const butThis = [
  'A complete revenue operations system',
  'Built around venue sales workflows',
  'Responds, qualifies, books, and nurtures',
  'Coordinated multi-channel follow-up',
  'On-brand and personalized every time',
]

export default function Differentiation() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })

  return (
    <section id="why" className="relative py-24 lg:py-32 surface-alt overflow-hidden">
      <div className="noise-layer" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />
      <div className="absolute bottom-0 left-1/4 w-[500px] h-[400px] bg-[#1A6FFF]/[0.04] rounded-full blur-[120px] pointer-events-none" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl mb-16">
          <div className="section-label">The Difference</div>
          <h2 className="font-display text-[40px] sm:text-[52px] font-bold text-[#0A0A1A] leading-[1.05] tracking-[-0.02em] mb-6">
            Not another chatbot.
            <span className="block text-gradient">An operating system.</span>
          </h2>
          <p className="text-[#475569] text-[18px] leading-[1.6]">
            There is no shortage of AI tools. VenueRise is the only one designed end-to-end around how wedding venue sales actually work.
          </p>
        </div>

        <div ref={ref} className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-start">
          {/* Left: Comparison table */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={isInView ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="card-glass overflow-hidden bg-white">
              <div className="grid grid-cols-2 border-b border-black/[0.06] bg-[#F8FAFF]">
                <div className="px-5 py-4 flex items-center gap-2 border-r border-black/[0.06]">
                  <X className="w-4 h-4 text-red-400" />
                  <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-[0.14em]">
                    Generic tools
                  </span>
                </div>
                <div className="px-5 py-4 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-[#1A6FFF]" />
                  <span className="text-[11px] font-bold text-[#1A6FFF] uppercase tracking-[0.14em]">
                    VenueRise
                  </span>
                </div>
              </div>

              {notThis.map((not, i) => (
                <div
                  key={not}
                  className={`grid grid-cols-2 ${i < notThis.length - 1 ? 'border-b border-black/[0.04]' : ''}`}
                >
                  <div className="px-5 py-4 flex items-start gap-3 border-r border-black/[0.04]">
                    <X className="w-3.5 h-3.5 text-red-400/70 flex-shrink-0 mt-0.5" />
                    <span className="text-[14px] text-[#64748B]">{not}</span>
                  </div>
                  <div className="px-5 py-4 flex items-start gap-3">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500/85 flex-shrink-0 mt-0.5" />
                    <span className="text-[14px] text-[#0A0A1A] font-medium">{butThis[i]}</span>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Right: Differentiator cards */}
          <div className="space-y-3.5">
            {differentiators.map((item, i) => {
              const Icon = item.icon
              return (
                <motion.div
                  key={item.title}
                  initial={{ opacity: 0, x: 20 }}
                  animate={isInView ? { opacity: 1, x: 0 } : {}}
                  transition={{ duration: 0.55, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] }}
                  whileHover={{ x: 4 }}
                  className="group flex gap-4 p-5 card-blue bg-white"
                >
                  <div className="w-10 h-10 rounded-xl bg-[#1A6FFF]/8 border border-[#1A6FFF]/15 flex items-center justify-center flex-shrink-0 mt-0.5 group-hover:bg-[#1A6FFF]/12 transition-colors">
                    <Icon className="w-4.5 h-4.5 text-[#1A6FFF]" strokeWidth={1.85} />
                  </div>
                  <div>
                    <h3 className="font-display text-[16px] font-semibold text-[#0A0A1A] mb-1.5 tracking-[-0.005em]">
                      {item.title}
                    </h3>
                    <p className="text-[14px] text-[#475569] leading-[1.55]">
                      {item.description}
                    </p>
                  </div>
                </motion.div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
