'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import { CheckCircle } from 'lucide-react'
import AuditForm from './AuditForm'

const includes = [
  'Full inquiry flow audit',
  'Custom automation blueprint',
  'Lost-revenue gap analysis',
  'Zero commitment required',
]

export default function FinalCTA() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })

  return (
    <section id="audit" className="relative py-24 lg:py-32 overflow-hidden">
      {/* Gradient blue background */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#1A6FFF] via-[#1058D6] to-[#0A46BF]" />
      <div
        className="absolute inset-0 opacity-25"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(ellipse 70% 60% at 50% 50%, #000 30%, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 50%, #000 30%, transparent 80%)',
        }}
      />
      <div className="absolute top-0 right-[10%] w-[500px] h-[500px] bg-[#5599FF]/[0.18] rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-0 left-[10%] w-[450px] h-[450px] bg-white/[0.08] rounded-full blur-[120px] pointer-events-none" />
      <div className="noise-layer" style={{ opacity: 0.04 }} />

      <div
        ref={ref}
        className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid lg:grid-cols-[1.05fr_1fr] gap-12 lg:gap-16 items-center"
      >
        {/* Left: Copy */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/25 bg-white/10 text-white/95 text-[11px] font-bold uppercase tracking-[0.14em] mb-7">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
            Free Venue Audit
          </div>

          <h2 className="font-display text-[44px] sm:text-[56px] lg:text-[64px] font-bold text-white leading-[1.04] tracking-[-0.02em] mb-6">
            Stop losing
            <span className="block">high-intent</span>
            <span className="block text-white/85">wedding leads.</span>
          </h2>

          <p className="text-[19px] text-white/70 leading-[1.55] mb-9 max-w-[520px]">
            Every week without a structured inquiry system is another round of hot leads going cold.
            Get a free audit of your current pipeline and see exactly where revenue is slipping through.
          </p>

          <div className="flex flex-col gap-2.5 max-w-[420px]">
            {includes.map((item, i) => (
              <motion.div
                key={item}
                initial={{ opacity: 0, x: -10 }}
                animate={isInView ? { opacity: 1, x: 0 } : {}}
                transition={{ duration: 0.4, delay: 0.3 + i * 0.07 }}
                className="flex items-center gap-2.5 text-[14px] text-white/85"
              >
                <CheckCircle className="w-4 h-4 text-white/80 flex-shrink-0" />
                {item}
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Right: Form */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.7, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
        >
          <AuditForm />
        </motion.div>
      </div>
    </section>
  )
}
