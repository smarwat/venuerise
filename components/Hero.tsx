'use client'

import { motion, useMotionValue, useSpring, useTransform, useReducedMotion } from 'framer-motion'
import { ArrowRight, Bell, Zap, Calendar, RefreshCw, ShieldCheck, ChevronRight, Activity } from 'lucide-react'
import { useEffect } from 'react'
import CTAButton from './ui/CTAButton'

function InquiryCard() {
  return (
    <div className="card-glass p-4 w-[280px]">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-[#1A6FFF]/10 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Bell className="w-4 h-4 text-[#1A6FFF]" strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-bold text-[#1A6FFF] uppercase tracking-[0.14em]">
              New Inquiry
            </span>
            <span className="text-[10px] text-[#94A3B8] tabular-nums">just now</span>
          </div>
          <p className="text-sm font-semibold text-[#0A0A1A] mb-0.5">Sarah &amp; James Thompson</p>
          <p className="text-xs text-[#64748B] mb-1.5">June 2026 · 180 guests · Saturday</p>
          <p className="text-xs text-[#94A3B8] italic truncate">"We absolutely love your venue and…"</p>
        </div>
      </div>
    </div>
  )
}

function ResponseCard() {
  return (
    <div className="card-glass p-4 w-[260px]">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-full bg-emerald-50 flex items-center justify-center">
          <Zap className="w-3 h-3 text-emerald-600" />
        </div>
        <span className="text-xs font-semibold text-emerald-700">Response Sent</span>
        <span className="ml-auto status-dot" aria-hidden="true" />
      </div>
      <div className="flex items-baseline gap-1 mb-1">
        <span className="text-2xl font-bold text-[#0A0A1A] font-display tabular-nums">38</span>
        <span className="text-sm text-[#64748B]">seconds</span>
      </div>
      <p className="text-xs text-[#94A3B8] mb-3">Personalized reply delivered</p>
      <div className="h-1 bg-[#F1F5F9] rounded-full overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: '82%' }}
          transition={{ delay: 1.8, duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
          className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full"
        />
      </div>
    </div>
  )
}

function BookingCard() {
  return (
    <div className="card-glass p-4 w-[240px]">
      <div className="flex items-center gap-2 mb-2.5">
        <Calendar className="w-3.5 h-3.5 text-[#1A6FFF]" />
        <span className="text-xs font-semibold text-[#1A6FFF]">Tour Booked</span>
        <ChevronRight className="w-3 h-3 text-[#94A3B8] ml-auto" />
      </div>
      <p className="text-sm font-bold text-[#0A0A1A] mb-0.5">Saturday, March 22</p>
      <p className="text-xs text-[#94A3B8] mb-2.5">2:00 PM · Auto-confirmed</p>
      <div className="flex items-center gap-1.5">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        <span className="text-xs text-emerald-700 font-medium">Confirmed</span>
      </div>
    </div>
  )
}

function FollowUpBadge() {
  return (
    <div className="card-blue px-3.5 py-2.5">
      <div className="flex items-center gap-2.5">
        <RefreshCw className="w-3.5 h-3.5 text-[#1A6FFF]" />
        <div>
          <p className="text-xs font-semibold text-[#0A0A1A] leading-tight">Follow-up Active</p>
          <p className="text-[10px] text-[#94A3B8]">7-day sequence · 4 touches left</p>
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
    <div className="card-glass p-5 w-[300px]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#1A6FFF]" strokeWidth={2} />
          <p className="text-sm font-semibold text-[#0A0A1A]">Pipeline · Live</p>
        </div>
        <span className="status-dot" aria-hidden="true" />
      </div>
      <div className="space-y-3">
        {rows.map((r, i) => (
          <motion.div
            key={r.label}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 1.4 + i * 0.12, duration: 0.5 }}
            className="flex items-center justify-between"
          >
            <span className="text-xs text-[#64748B]">{r.label}</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-bold text-[#0A0A1A] tabular-nums">{r.value}</span>
              <span className="text-[10px] font-semibold text-emerald-600 tabular-nums">{r.delta}</span>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  )
}

export default function Hero() {
  const reduced = useReducedMotion()

  // Mouse parallax
  const mouseX = useMotionValue(0)
  const mouseY = useMotionValue(0)
  const px = useSpring(mouseX, { stiffness: 60, damping: 20 })
  const py = useSpring(mouseY, { stiffness: 60, damping: 20 })

  const parallax1X = useTransform(px, (v) => v * -10)
  const parallax1Y = useTransform(py, (v) => v * -10)
  const parallax2X = useTransform(px, (v) => v * 14)
  const parallax2Y = useTransform(py, (v) => v * 14)
  const parallax3X = useTransform(px, (v) => v * -18)
  const parallax3Y = useTransform(py, (v) => v * -22)
  const parallax4X = useTransform(px, (v) => v * 8)
  const parallax4Y = useTransform(py, (v) => v * 12)
  const parallax5X = useTransform(px, (v) => v * 22)
  const parallax5Y = useTransform(py, (v) => v * -16)

  useEffect(() => {
    if (reduced) return
    const handle = (e: MouseEvent) => {
      const x = (e.clientX / window.innerWidth) - 0.5
      const y = (e.clientY / window.innerHeight) - 0.5
      mouseX.set(x)
      mouseY.set(y)
    }
    window.addEventListener('mousemove', handle, { passive: true })
    return () => window.removeEventListener('mousemove', handle)
  }, [mouseX, mouseY, reduced])

  return (
    <section id="hero" className="relative min-h-screen flex items-center pt-16 overflow-hidden bg-white">
      {/* Background atmospheric layers */}
      <div className="absolute inset-0 pointer-events-none">
        <motion.div
          style={{ x: parallax1X, y: parallax1Y }}
          className="absolute top-[10%] right-[5%] w-[680px] h-[680px] bg-[#1A6FFF]/[0.07] rounded-full blur-[140px]"
        />
        <motion.div
          style={{ x: parallax2X, y: parallax2Y }}
          className="absolute top-[55%] left-[2%] w-[460px] h-[460px] bg-[#5591FF]/[0.06] rounded-full blur-[120px]"
        />
        <motion.div
          style={{ x: parallax1X, y: parallax2Y }}
          className="absolute bottom-[8%] right-[28%] w-[520px] h-[320px] bg-[#1A6FFF]/[0.04] rounded-full blur-[160px]"
        />
        <div className="absolute inset-0 grid-bg" />
        <div className="noise-layer" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 lg:py-28 grid lg:grid-cols-[1.05fr_1fr] gap-12 lg:gap-16 items-center">
        {/* Left: Copy */}
        <div>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="section-label w-fit"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#1A6FFF] animate-pulse" />
            Revenue Operations · Built for Wedding Venues
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
            className="font-display text-[56px] sm:text-[68px] lg:text-[80px] font-bold text-[#0A0A1A] leading-[1.02] tracking-[-0.02em] mb-7"
          >
            Your next booking
            <span className="block">may already be</span>
            <span className="block text-gradient">in your inbox.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.25 }}
            className="text-[19px] text-[#475569] leading-[1.55] mb-9 max-w-[540px]"
          >
            VenueRise responds to every inquiry in under 60 seconds, qualifies leads automatically,
            and recovers the ones your team would have lost — like a 24/7 sales coordinator for your pipeline.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.35 }}
            className="flex flex-col sm:flex-row gap-3 mb-6"
          >
            <CTAButton href="#audit" variant="primary" size="lg">
              Book a Free Venue Audit
              <ArrowRight className="w-4 h-4" />
            </CTAButton>
            <CTAButton href="#how-it-works" variant="secondary" size="lg">
              See How It Works
            </CTAButton>
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.55, duration: 0.5 }}
            className="text-[13px] text-[#94A3B8] mb-8 max-w-[480px] leading-relaxed flex items-start gap-2"
          >
            <ShieldCheck className="w-4 h-4 text-[#1A6FFF]/60 flex-shrink-0 mt-0.5" strokeWidth={1.75} />
            Built for venues that cannot afford to miss a single high-intent inquiry.
            No setup fees · Live in 14 days · Works with your existing CRM.
          </motion.p>
        </div>

        {/* Right: Floating composition */}
        <div className="relative hidden lg:block h-[540px]">
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-80 h-80 bg-[#1A6FFF]/[0.07] rounded-full blur-[80px]" />
          </div>

          {/* Pipeline (anchor, slightly back) */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ delay: 0.5, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            style={{ x: parallax1X, y: parallax1Y }}
            className="absolute top-[28%] left-1/2 -translate-x-1/2"
          >
            <PipelineCard />
          </motion.div>

          {/* Inquiry — top right */}
          <motion.div
            initial={{ opacity: 0, x: 20, y: -10 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            transition={{ delay: 0.85, duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
            style={{ x: parallax3X, y: parallax3Y }}
            className="absolute top-2 right-0"
          >
            <InquiryCard />
          </motion.div>

          {/* Response — middle left */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 1.15, duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
            style={{ x: parallax4X, y: parallax4Y }}
            className="absolute top-[48%] -left-2"
          >
            <ResponseCard />
          </motion.div>

          {/* Booking — bottom right */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.4, duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
            style={{ x: parallax5X, y: parallax5Y }}
            className="absolute bottom-4 right-8"
          >
            <BookingCard />
          </motion.div>

          {/* Follow-up — small badge */}
          <motion.div
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 1.7, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            style={{ x: parallax2X, y: parallax2Y }}
            className="absolute bottom-[22%] -left-4"
          >
            <FollowUpBadge />
          </motion.div>

          {/* Connection lines */}
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none opacity-[0.07]"
            viewBox="0 0 400 540"
            fill="none"
          >
            <path
              d="M300 80 Q 230 130, 200 250 T 240 460"
              stroke="#1A6FFF"
              strokeWidth="1.5"
              strokeDasharray="4 6"
            />
            <path
              d="M40 280 Q 150 320, 200 250"
              stroke="#1A6FFF"
              strokeWidth="1.5"
              strokeDasharray="4 6"
            />
          </svg>
        </div>
      </div>

      {/* Bottom soft fade */}
      <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-[#F4F7FF] to-transparent pointer-events-none" />
    </section>
  )
}
