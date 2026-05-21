'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import {
  BookOpen,
  CheckCircle2,
  Eye,
  HandMetal,
  ShieldCheck,
} from 'lucide-react'

/**
 * GTM-0B — Operator-control / safety section.
 *
 * Wedding-venue buyers worry about three things when "AI" enters the
 * conversation:
 *   1. AI sounding robotic in front of brides.
 *   2. AI sending something dumb to a real lead.
 *   3. Losing the human relationship that closes weddings.
 *
 * This section answers all three head-on. It is also the section that
 * keeps VenueRise's honesty contract on the public page:
 *
 *   - Manual-required channels (Instagram, The Knot, WeddingWire, Meta)
 *     stay operator-sent.
 *   - No autonomous sending by default.
 *   - Brand voice + knowledge base guide every draft.
 */

const guarantees = [
  {
    icon: HandMetal,
    title: 'Your team is always in the loop',
    description:
      'AI drafts. Your team reads, edits, and clicks send. The dashboard makes it obvious which reply is suggested and why.',
  },
  {
    icon: ShieldCheck,
    title: 'No autonomous sending',
    description:
      'VenueRise does not push messages on its own. Manual-required channels — Instagram, The Knot, WeddingWire, Meta Ads — stay operator-sent until you verify a direct integration.',
  },
  {
    icon: BookOpen,
    title: 'Brand voice + knowledge base guide drafts',
    description:
      'Your tone, your policies, your packages. Drafts reflect what you actually offer, not a generic SaaS template. Keep it on-brand, keep it accurate.',
  },
  {
    icon: Eye,
    title: 'Full audit trail of every action',
    description:
      'Every draft generated, every reply sent, every status change is logged. Owners see what the team did and what AI suggested. No black boxes.',
  },
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
          <div className="section-label">Operator control</div>
          <h2 className="font-display text-[40px] sm:text-[52px] font-bold text-[#0A0A1A] leading-[1.05] tracking-[-0.02em] mb-6">
            AI helps your team move faster.{' '}
            <span className="text-gradient">It does not replace their judgment.</span>
          </h2>
          <p className="text-[#475569] text-[18px] leading-[1.6] max-w-[640px]">
            Wedding venue sales is a high-trust, high-stakes
            conversation. We built VenueRise so AI can do the heavy
            lifting on drafts and detection — and your team stays in
            charge of every word that goes to a couple.
          </p>
        </div>

        <div ref={ref} className="grid sm:grid-cols-2 gap-4">
          {guarantees.map((g, i) => {
            const Icon = g.icon
            return (
              <motion.div
                key={g.title}
                initial={{ opacity: 0, y: 18 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{
                  duration: 0.55,
                  delay: i * 0.08,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="card-glass p-6"
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#EFF6FF] text-[#1D4ED8] flex items-center justify-center shrink-0 mt-0.5">
                    <Icon className="w-5 h-5" strokeWidth={2} />
                  </div>
                  <div>
                    <h3 className="font-display text-[18px] font-semibold text-[#0A0A1A] mb-1.5 tracking-[-0.005em]">
                      {g.title}
                    </h3>
                    <p className="text-[14px] text-[#475569] leading-[1.6]">
                      {g.description}
                    </p>
                  </div>
                </div>
              </motion.div>
            )
          })}
        </div>

        <div className="mt-10 inline-flex items-center gap-2 px-4 py-2.5 rounded-full border border-[#1A6FFF]/20 bg-white text-[12.5px] text-[#475569]">
          <CheckCircle2 className="w-3.5 h-3.5 text-[#1D4ED8]" />
          <span>
            <strong className="text-[#0A0A1A]">Honest scope:</strong>{' '}
            we don&rsquo;t claim SOC 2, GDPR, or PCI today. Trust
            posture lives in the security questionnaire we share with
            procurement-heavy buyers.
          </span>
        </div>
      </div>
    </section>
  )
}
