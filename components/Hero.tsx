'use client'

import { motion, useMotionValue, useSpring, useTransform, useReducedMotion } from 'framer-motion'
import { ArrowRight, Bell, Zap, Calendar, RefreshCw, ChevronRight, Activity, Check } from 'lucide-react'
import { useEffect } from 'react'
import CTAButton from './ui/CTAButton'

// Hero background image — served from public/hero-venue.jpg
const HERO_BG = '/hero-venue.jpg'

const trustSignals = [
  "Built for venues that can't afford to miss a single high-intent inquiry",
  'No setup fees',
  'Live in 14 days',
  'Works with your existing CRM.',
]

const partnerLogos = [
  { label: 'the knot', cls: 'font-display italic text-[22px] font-medium' },
  { label: 'WEDDING WIRE', cls: 'font-sans text-[13px] font-extrabold tracking-[0.18em] leading-[1.15]', stacked: true },
  { label: 'ZOLA', cls: 'font-sans text-[26px] font-extrabold tracking-[0.22em]' },
  { label: 'Google Reviews', google: true },
  { label: 'BIZBASH', cls: 'font-sans text-[19px] font-extrabold tracking-[0.16em]' },
  { label: 'WEDDING SPOT', cls: 'font-sans text-[13px] font-extrabold tracking-[0.18em] leading-[1.15]', stacked: true },
  { label: 'JOY', cls: 'font-sans text-[22px] font-extrabold tracking-[0.34em]' },
]

function InquiryCard() {
  return (
    <div className="bg-white rounded-2xl p-4 w-[300px] shadow-[0_20px_60px_-15px_rgba(0,0,0,0.55)] ring-1 ring-black/[0.04]">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-[#1A6FFF]/10 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Bell className="w-4 h-4 text-[#1A6FFF]" strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-bold text-[#1A6FFF] uppercase tracking-[0.14em]">New Inquiry</span>
            <span className="text-[10px] text-[#94A3B8] tabular-nums">just now</span>
          </div>
          <p className="text-[14px] font-semibold text-[#0A0A1A] mb-0.5">Sarah &amp; James Thompson</p>
          <p className="text-[12px] text-[#64748B] mb-1.5">June 2026 · 180 guests · Saturday</p>
          <p className="text-[12px] text-[#94A3B8] italic truncate">"We absolutely love your venue..."</p>
        </div>
      </div>
    </div>
  )
}

function PipelineCard() {
  const rows = [
    { label: 'Inquiries this week', value: '47', delta: '+12' },
    { label: 'Tours booked', value: '12', delta: '+5' },
    { label: 'Lead recovery rate', value: '34%', delta: '+8%' },
  ]
  return (
    <div className="bg-white rounded-2xl p-5 w-[340px] shadow-[0_24px_70px_-15px_rgba(0,0,0,0.6)] ring-1 ring-black/[0.04]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#1A6FFF]" strokeWidth={2} />
          <p className="text-[13px] font-bold text-[#0A0A1A] uppercase tracking-[0.1em]">Pipeline · Live</p>
        </div>
        <span className="status-dot" aria-hidden="true" />
      </div>
      <div className="space-y-3.5">
        {rows.map((r, i) => (
          <motion.div
            key={r.label}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 1.2 + i * 0.1, duration: 0.5 }}
            className="flex items-center justify-between"
          >
            <span className="text-[13px] text-[#475569]">{r.label}</span>
            <div className="flex items-baseline gap-2">
              <span className="text-[15px] font-bold text-[#0A0A1A] tabular-nums">{r.value}</span>
              <span className="text-[11px] font-semibold text-emerald-600 tabular-nums">{r.delta}</span>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  )
}

function BookingCard() {
  return (
    <div className="bg-white rounded-2xl p-4 w-[280px] shadow-[0_20px_60px_-15px_rgba(0,0,0,0.55)] ring-1 ring-black/[0.04]">
      <div className="flex items-center gap-2 mb-2.5">
        <Calendar className="w-3.5 h-3.5 text-[#1A6FFF]" />
        <span className="text-[11px] font-bold text-[#1A6FFF] uppercase tracking-[0.12em]">Tour Booked</span>
        <ChevronRight className="w-3.5 h-3.5 text-[#94A3B8] ml-auto" />
      </div>
      <p className="text-[16px] font-bold text-[#0A0A1A] mb-0.5 font-display tracking-[-0.01em]">Saturday, March 22</p>
      <p className="text-[12px] text-[#94A3B8] mb-3">2:00 PM · Auto-confirmed</p>
      <div className="flex items-center gap-1.5">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        <span className="text-[12px] text-emerald-700 font-medium">Confirmed</span>
      </div>
    </div>
  )
}

function ResponseFollowUpCard() {
  return (
    <div className="bg-white rounded-2xl w-[300px] shadow-[0_24px_70px_-15px_rgba(0,0,0,0.6)] ring-1 ring-black/[0.04] overflow-hidden">
      {/* Response Sent block */}
      <div className="p-4 pb-3.5">
        <div className="flex items-center gap-2 mb-2.5">
          <div className="w-6 h-6 rounded-full bg-emerald-50 flex items-center justify-center">
            <Zap className="w-3 h-3 text-emerald-600" strokeWidth={2.5} />
          </div>
          <span className="text-[11px] font-bold text-emerald-700 uppercase tracking-[0.12em]">
            Response Sent
          </span>
          <span className="ml-auto status-dot" aria-hidden="true" />
        </div>
        <div className="flex items-baseline gap-1.5 mb-0.5">
          <span className="text-[28px] font-bold text-[#0A0A1A] font-display tabular-nums leading-none">38</span>
          <span className="text-[14px] text-[#64748B]">seconds</span>
        </div>
        <p className="text-[12px] text-[#94A3B8]">Personalized reply delivered</p>
      </div>

      {/* Soft divider */}
      <div className="h-px bg-[#F1F5F9] mx-4" />

      {/* Follow-up Active block */}
      <div className="px-4 py-3.5 flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-[#1A6FFF]/10 flex items-center justify-center flex-shrink-0">
          <RefreshCw className="w-3.5 h-3.5 text-[#1A6FFF]" strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-[#0A0A1A] leading-tight">Follow-up Active</p>
          <p className="text-[11px] text-[#94A3B8] mt-0.5">7-day sequence · 4 touches left</p>
        </div>
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

function GoogleReviewsMark() {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[16px] font-medium tracking-tight leading-tight">Google</span>
      <div className="flex items-center gap-[1.5px]">
        {[0, 1, 2, 3, 4].map((i) => (
          <svg key={i} width="11" height="11" viewBox="0 0 24 24" fill="#F5C518">
            <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
          </svg>
        ))}
      </div>
      <span className="text-[9px] tracking-[0.18em] uppercase font-semibold opacity-80">Reviews</span>
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
      {/* Cinematic background image with subtle parallax */}
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

      {/* Atmospheric overlays — left dim for text contrast + vignette */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-r from-[#070B1A]/92 via-[#070B1A]/55 to-[#070B1A]/15" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#070B1A]/30 via-transparent to-[#070B1A]/75" />
        <div className="absolute top-[15%] right-[20%] w-[520px] h-[520px] bg-[#FFB36B]/[0.07] rounded-full blur-[140px]" />
        <div className="absolute top-[35%] right-[10%] w-[420px] h-[420px] bg-[#1A6FFF]/[0.10] rounded-full blur-[120px]" />
        <div className="absolute inset-0 shadow-[inset_0_0_180px_60px_rgba(7,11,26,0.65)]" />
      </div>

      {/* Main content */}
      <div className="relative z-10 w-full max-w-[1320px] mx-auto px-4 sm:px-6 lg:px-10 pt-20 pb-44 lg:pt-24 lg:pb-44">
        <div className="grid lg:grid-cols-[1.1fr_1fr] gap-10 lg:gap-12 items-start">
          {/* Left: Copy */}
          <div className="pt-2">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55 }}
              className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-[#4D90FF]/35 bg-[#1A6FFF]/[0.10] backdrop-blur-md text-[#9BBEFF] text-[11px] font-bold uppercase tracking-[0.18em] mb-7"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#4D90FF] animate-pulse" />
              Revenue Operations · Built for Wedding Venues
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.75, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
              className="font-display text-[56px] sm:text-[72px] lg:text-[88px] xl:text-[100px] font-bold text-white leading-[0.98] tracking-[-0.028em] mb-7 drop-shadow-[0_6px_30px_rgba(0,0,0,0.55)]"
            >
              <span className="block">Your next</span>
              <span className="block">booking may</span>
              <span className="block">
                already be <em className="italic font-semibold text-[#4D90FF]">in</em>
              </span>
              <span className="block text-[#4D90FF] not-italic">your inbox.</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.65, delay: 0.25 }}
              className="text-[17px] lg:text-[18px] text-white/78 leading-[1.6] mb-8 max-w-[520px] drop-shadow-[0_2px_12px_rgba(0,0,0,0.5)]"
            >
              VenueRise responds to every inquiry in under 60 seconds, qualifies leads automatically,
              and recovers the ones your team would have lost — like a 24/7 sales coordinator for your pipeline.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.35 }}
              className="flex flex-col sm:flex-row gap-3 mb-10"
            >
              <CTAButton href="#audit" variant="primary" size="lg">
                Book a Free Venue Audit
                <ArrowRight className="w-4 h-4" />
              </CTAButton>
              <CTAButton href="#how-it-works" variant="invert" size="lg">
                See How It Works
              </CTAButton>
            </motion.div>

            {/* Trust signal pills — horizontal row of 4 */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.55, duration: 0.6 }}
              className="grid grid-cols-2 lg:grid-cols-4 gap-x-5 gap-y-3.5 max-w-[700px]"
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

          {/* Right: Floating cards composition */}
          <div className="relative hidden lg:block h-[620px] -mr-4">
            {/* Right-column stack: Inquiry → Pipeline → Tour Booked */}

            {/* Inquiry — top */}
            <motion.div
              initial={{ opacity: 0, x: 20, y: -8 }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              transition={{ delay: 0.7, duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
              style={{ x: c1X, y: c1Y }}
              className="absolute top-0 right-0"
            >
              <InquiryCard />
            </motion.div>

            {/* Pipeline — middle, slightly offset left */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.95, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              style={{ x: c2X, y: c2Y }}
              className="absolute top-[180px] right-[12px]"
            >
              <PipelineCard />
            </motion.div>

            {/* Tour Booked — bottom right */}
            <motion.div
              initial={{ opacity: 0, x: 20, y: 8 }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              transition={{ delay: 1.4, duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
              style={{ x: c4X, y: c4Y }}
              className="absolute top-[420px] right-[28px]"
            >
              <BookingCard />
            </motion.div>

            {/* Combined Response + Follow-up — floats in center, overlapping into hero copy area */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1.15, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              style={{ x: c3X, y: c3Y }}
              className="absolute top-[320px] -left-32"
            >
              <ResponseFollowUpCard />
            </motion.div>
          </div>
        </div>
      </div>

      {/* Trust logos strip — bottom of hero */}
      <div className="absolute bottom-0 left-0 right-0 z-10 pb-8 pt-12 bg-gradient-to-t from-[#070B1A]/90 via-[#070B1A]/55 to-transparent">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-10">
          <p className="text-center text-[10.5px] tracking-[0.28em] font-bold text-white/55 uppercase mb-6">
            Trusted by top venues nationwide
          </p>
          <div className="flex items-center justify-between gap-4 flex-wrap text-white/72">
            {partnerLogos.map((logo) => (
              <div
                key={logo.label}
                className="flex items-center justify-center min-w-0 flex-shrink-0 hover:text-white transition-colors duration-300"
              >
                {logo.google ? (
                  <GoogleReviewsMark />
                ) : (
                  <span className={`${logo.cls} whitespace-pre-line text-center`}>
                    {logo.stacked ? logo.label.split(' ').join('\n') : logo.label}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom transition to next section */}
      <div className="absolute bottom-0 left-0 right-0 h-[2px] z-20 bg-gradient-to-b from-transparent to-[#F4F7FF] pointer-events-none" />
    </section>
  )
}
