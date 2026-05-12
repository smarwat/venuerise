'use client'

import { motion } from 'framer-motion'

const venueTypes = [
  'Vineyard Estates',
  'Historic Mansions',
  'Garden Venues',
  'Modern Ballrooms',
  'Rooftop Terraces',
  'Luxury Barns',
  'Waterfront Estates',
  'Private Clubs',
  'Château Venues',
  'Boutique Hotels',
]

const stats = [
  { value: '< 60s', label: 'Response Time' },
  { value: '24/7', label: 'Always-On Coverage' },
  { value: '3×', label: 'More Tours Booked' },
  { value: '80%', label: 'Less Manual Follow-Up' },
]

export default function SocialProof() {
  const doubled = [...venueTypes, ...venueTypes]

  return (
    <section className="relative py-16 border-y border-black/[0.06] overflow-hidden surface-alt">
      <div className="noise-layer" />

      <div className="relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mb-10">
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-50px' }}
            transition={{ duration: 0.6 }}
            className="text-center text-[#475569] text-[15px] font-medium tracking-tight max-w-2xl mx-auto"
          >
            Most venues don't need more leads.{' '}
            <span className="text-[#0A0A1A] font-semibold">They need fewer lost ones.</span>
          </motion.p>
        </div>

        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 mb-12">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-black/[0.06] rounded-2xl overflow-hidden">
            {stats.map((stat, i) => (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.07, ease: [0.22, 1, 0.36, 1] }}
                className="bg-[#F4F7FF] px-6 py-6 text-center"
              >
                <p className="font-display text-[28px] font-bold text-gradient mb-1 tabular-nums">{stat.value}</p>
                <p className="text-[11px] text-[#64748B] font-semibold tracking-wider uppercase">{stat.label}</p>
              </motion.div>
            ))}
          </div>
        </div>

        <div className="relative overflow-hidden">
          <div className="absolute left-0 top-0 bottom-0 w-24 bg-gradient-to-r from-[#F4F7FF] to-transparent z-10 pointer-events-none" />
          <div className="absolute right-0 top-0 bottom-0 w-24 bg-gradient-to-l from-[#F4F7FF] to-transparent z-10 pointer-events-none" />
          <div className="flex animate-marquee whitespace-nowrap">
            {doubled.map((type, i) => (
              <span key={i} className="inline-flex items-center gap-3 mx-6 text-[#64748B] text-sm font-medium tracking-wide">
                <span className="w-1 h-1 rounded-full bg-[#1A6FFF]/40 flex-shrink-0" />
                {type}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
