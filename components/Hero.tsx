'use client'

import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  useReducedMotion,
} from 'framer-motion'
import {
  ArrowRight,
  Check,
  Activity,
  AlertTriangle,
  Calendar,
  MessageSquare,
  type LucideIcon,
} from 'lucide-react'
import { useEffect } from 'react'
import CTAButton from './ui/CTAButton'

/**
 * GTM-0B — Revenue OS hero.
 *
 * The previous hero pitched VenueRise as a "24/7 sales coordinator"
 * that "responds in under 60 seconds" — both autonomy overclaims we
 * can no longer back since the entire product posture is
 * operator-approved drafts only (no autonomous sending).
 *
 * This rewrite frames the wedge:
 *   "Stop losing weddings in the follow-up gap. AI Revenue OS that
 *    connects your fragmented inquiry channels and shows where
 *    revenue is leaking."
 *
 * The right-hand visual now stages three Revenue OS leak cards
 * (Slow first reply / Qualified no tour / Tour pending confirm)
 * pulled directly from the dashboard's actual surfaces so the
 * preview matches what the buyer sees on the live demo.
 */

const HERO_BG = '/hero-venue.jpg'

const trustSignals = [
  'AI drafts. Your team approves.',
  'No autonomous sending.',
  'Connects website, Instagram, The Knot, WeddingWire, Meta Ads.',
  // Aligned with the FAQ answer ("most venues are operating the daily
  // workflow within the first week") so the page doesn't promise a
  // vaguer "days" timeline than support copy can back.
  'Pilot setup in the first week, not quarters.',
]

function LeakCard({
  label,
  count,
  value,
  tone,
  icon: Icon,
  helper,
}: {
  label: string
  count: string
  value?: string
  tone: 'amber' | 'rose' | 'blue'
  icon: LucideIcon
  helper: string
}) {
  const toneClass = {
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
    blue: 'bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE]',
  }[tone]
  return (
    <div className="bg-white rounded-2xl p-4 w-[300px] shadow-[0_24px_70px_-15px_rgba(0,0,0,0.6)] ring-1 ring-black/[0.04]">
      <div className="flex items-start gap-3">
        <div
          className={`w-9 h-9 rounded-xl ${toneClass} border flex items-center justify-center shrink-0 mt-0.5`}
        >
          <Icon className="w-4 h-4" strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[#94A3B8]">
            {label}
          </p>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-[22px] font-bold text-[#0A0A1A] tabular-nums leading-none">
              {count}
            </span>
            {value && (
              <span className="text-[12px] text-[#475569] tabular-nums">
                {value}
              </span>
            )}
          </div>
          <p className="text-[11.5px] text-[#475569] mt-1 leading-relaxed">
            {helper}
          </p>
        </div>
      </div>
    </div>
  )
}

function RevenueAtRiskCard() {
  return (
    <div className="bg-white rounded-2xl p-5 w-[340px] shadow-[0_28px_80px_-20px_rgba(0,0,0,0.65)] ring-1 ring-black/[0.04]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#1D4ED8]" strokeWidth={2} />
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#0A0A1A]">
            Pipeline at risk
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-[#94A3B8] font-semibold">
          Demo
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-[34px] font-bold text-[#0A0A1A] tracking-[-0.02em] tabular-nums leading-none">
          $124k
        </span>
        <span className="text-[12px] text-[#475569]">est. at-risk pipeline</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[11.5px]">
        <div className="flex justify-between">
          <span className="text-[#475569]">Slow replies</span>
          <span className="font-semibold text-[#0A0A1A] tabular-nums">5</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#475569]">No tour</span>
          <span className="font-semibold text-[#0A0A1A] tabular-nums">3</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#475569]">Recovery</span>
          <span className="font-semibold text-[#0A0A1A] tabular-nums">4</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#475569]">Confirm tour</span>
          <span className="font-semibold text-[#0A0A1A] tabular-nums">2</span>
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-[#F1F5F9] flex items-center justify-between text-[11px]">
        <span className="text-[#475569]">Top source</span>
        <span className="font-semibold text-[#047857]">
          Google Ads · $42k booked
        </span>
      </div>
    </div>
  )
}

function TrustCheck() {
  return (
    <div className="w-[18px] h-[18px] rounded-full bg-[#1A6FFF] flex items-center justify-center flex-shrink-0 mt-0.5 shadow-[0_2px_8px_rgba(26,111,255,0.45)]">
      <Check className="w-3 h-3 text-white" strokeWidth={3.5} />
    </div>
  )
}

export default function Hero() {
  const reduced = useReducedMotion()
  const mouseX = useMotionValue(0)
  const mouseY = useMotionValue(0)
  const px = useSpring(mouseX, { stiffness: 60, damping: 22 })
  const py = useSpring(mouseY, { stiffness: 60, damping: 22 })
  const bgX = useTransform(px, (v) => v * -14)
  const bgY = useTransform(py, (v) => v * -8)
  const c1X = useTransform(px, (v) => v * -10)
  const c1Y = useTransform(py, (v) => v * -10)
  const c2X = useTransform(px, (v) => v * 14)
  const c2Y = useTransform(py, (v) => v * 14)
  const c3X = useTransform(px, (v) => v * -18)
  const c3Y = useTransform(py, (v) => v * -22)
  const c4X = useTransform(px, (v) => v * 18)
  const c4Y = useTransform(py, (v) => v * -10)

  useEffect(() => {
    if (reduced) return
    const handle = (e: MouseEvent) => {
      mouseX.set(e.clientX / window.innerWidth - 0.5)
      mouseY.set(e.clientY / window.innerHeight - 0.5)
    }
    window.addEventListener('mousemove', handle, { passive: true })
    return () => window.removeEventListener('mousemove', handle)
  }, [mouseX, mouseY, reduced])

  return (
    <section
      id="hero"
      className="relative min-h-[920px] lg:min-h-screen flex items-stretch pt-16 overflow-hidden bg-[#0A0F1F]"
    >
      <motion.div
        style={{ x: bgX, y: bgY }}
        className="absolute -inset-6 z-0 will-change-transform"
        aria-hidden="true"
      >
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${HERO_BG})` }}
        />
      </motion.div>

      <div className="absolute inset-0 z-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-r from-[#070B1A]/92 via-[#070B1A]/55 to-[#070B1A]/15" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#070B1A]/30 via-transparent to-[#070B1A]/75" />
        <div className="absolute top-[15%] right-[20%] w-[520px] h-[520px] bg-[#FFB36B]/[0.07] rounded-full blur-[140px]" />
        <div className="absolute top-[35%] right-[10%] w-[420px] h-[420px] bg-[#1A6FFF]/[0.10] rounded-full blur-[120px]" />
        <div className="absolute inset-0 shadow-[inset_0_0_180px_60px_rgba(7,11,26,0.65)]" />
      </div>

      <div className="relative z-10 w-full max-w-[1320px] mx-auto px-4 sm:px-6 lg:px-10 pt-20 pb-24 lg:pt-24 lg:pb-32">
        <div className="grid lg:grid-cols-[1.1fr_1fr] gap-10 lg:gap-12 items-start">
          <div className="pt-2">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55 }}
              className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-[#4D90FF]/35 bg-[#1A6FFF]/[0.10] backdrop-blur-md text-[#9BBEFF] text-[11px] font-bold uppercase tracking-[0.18em] mb-7"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#4D90FF] animate-pulse" />
              AI Revenue OS · Built for wedding venues
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.75, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
              className="font-display text-[52px] sm:text-[68px] lg:text-[84px] xl:text-[92px] font-bold text-white leading-[1.0] tracking-[-0.028em] mb-7 drop-shadow-[0_6px_30px_rgba(0,0,0,0.55)]"
            >
              <span className="block">Stop losing</span>
              <span className="block">weddings in the</span>
              <span className="block text-[#4D90FF] not-italic">follow-up gap.</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.65, delay: 0.25 }}
              className="text-[17px] lg:text-[18px] text-white/82 leading-[1.6] mb-8 max-w-[560px] drop-shadow-[0_2px_12px_rgba(0,0,0,0.5)]"
            >
              VenueRise is an AI Revenue OS for wedding venues. It
              connects your website, Instagram, The Knot, WeddingWire,
              Meta Ads, and inbox inquiries into one revenue dashboard,
              then shows which leads need action &mdash; and what
              they&rsquo;re worth &mdash; before they go cold.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.35 }}
              className="flex flex-col sm:flex-row gap-3 mb-10"
            >
              <CTAButton href="/demo" variant="primary" size="lg">
                Book a demo
                <ArrowRight className="w-4 h-4" />
              </CTAButton>
              <CTAButton href="#how-it-works" variant="invert" size="lg">
                See how it works
              </CTAButton>
            </motion.div>

            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5, duration: 0.55 }}
              className="text-[12px] text-white/65 mb-6 max-w-[560px]"
            >
              AI drafts. Your team approves. No autonomous sending.
            </motion.p>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.55, duration: 0.6 }}
              className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3.5 max-w-[640px]"
            >
              {trustSignals.map((signal) => (
                <div
                  key={signal}
                  className="flex items-start gap-2.5 text-white/82 text-[12.5px] leading-[1.45]"
                >
                  <TrustCheck />
                  <span>{signal}</span>
                </div>
              ))}
            </motion.div>
          </div>

          {/* Right: leak cards composition */}
          <div className="relative hidden lg:block h-[620px] -mr-4">
            <motion.div
              initial={{ opacity: 0, x: 20, y: -8 }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              transition={{ delay: 0.7, duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
              style={{ x: c1X, y: c1Y }}
              className="absolute top-0 right-0"
            >
              <LeakCard
                label="Slow first reply"
                count="5"
                icon={MessageSquare}
                tone="amber"
                helper="Inquiries waiting > 1 hour for first response."
              />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.95, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              style={{ x: c2X, y: c2Y }}
              className="absolute top-[180px] right-[12px]"
            >
              <RevenueAtRiskCard />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 20, y: 8 }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              transition={{ delay: 1.4, duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
              style={{ x: c4X, y: c4Y }}
              className="absolute top-[440px] right-[28px]"
            >
              <LeakCard
                label="Tour pending confirm"
                count="2"
                icon={Calendar}
                tone="blue"
                helper="Scheduled tours that haven't been confirmed yet."
              />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1.15, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              style={{ x: c3X, y: c3Y }}
              className="absolute top-[340px] -left-32"
            >
              <LeakCard
                label="Qualified, no tour"
                count="3"
                icon={AlertTriangle}
                tone="rose"
                helper="High-fit leads still waiting for a tour invite."
              />
            </motion.div>
          </div>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-[2px] z-20 bg-gradient-to-b from-transparent to-[#F4F7FF] pointer-events-none" />
    </section>
  )
}
