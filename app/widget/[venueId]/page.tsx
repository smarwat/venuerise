'use client'

import { useMemo, useState, use } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight, Check, Loader2, Sparkles, AlertCircle } from 'lucide-react'

// Phase 8BH — keys the embedded widget reads off its own URL.
// The widget.js loader stamps UTM params + click ids onto the
// iframe URL so the embedded form can forward them with the
// intake POST. Anything not in this list is ignored.
const ATTRIBUTION_QUERY_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'msclkid',
  'ttclid',
  'landing_page',
  'referrer',
  'captured_at',
] as const

type Step = 'name' | 'email' | 'phone' | 'date' | 'guests' | 'budget' | 'message' | 'success'

const STEPS: Step[] = ['name', 'email', 'phone', 'date', 'guests', 'budget', 'message']

const STEP_CONFIG: Record<Step, { label: string; placeholder: string; type: string; optional?: boolean; helper?: string }> = {
  name:    { label: "What's your name?",      placeholder: 'Jordan Bennett',         type: 'text',     helper: 'So we can address you properly' },
  email:   { label: 'Your email address?',     placeholder: 'jordan@email.com',       type: 'email',    helper: "We'll send your tour confirmation here" },
  phone:   { label: 'Phone number?',           placeholder: '+1 (555) 000-0000',      type: 'tel',      optional: true, helper: 'For quick follow-ups (optional)' },
  date:    { label: 'When is your event?',     placeholder: '',                       type: 'date',     optional: true },
  guests:  { label: 'How many guests?',        placeholder: '150',                    type: 'number',   helper: 'Approximate is fine' },
  budget:  { label: 'Approximate budget?',     placeholder: '$25,000',                type: 'text',     optional: true, helper: 'Helps us tailor recommendations' },
  message: { label: 'Anything else to share?', placeholder: 'Tell us about your vision…', type: 'textarea', optional: true },
  success: { label: '', placeholder: '', type: '' },
}

export default function WidgetPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = use(params)
  const [step, setStep] = useState<Step>('name')
  const [loading, setLoading] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [current, setCurrent] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Phase 8BH — capture attribution off this iframe's URL ONCE
  // on mount. Memoised so re-renders don't keep re-reading
  // window.location. Returns an empty object during SSR; the
  // intake API accepts that (lead lands as Website with no
  // UTM context).
  const attribution = useMemo<Record<string, string>>(() => {
    if (typeof window === 'undefined') return {}
    const out: Record<string, string> = {}
    try {
      const sp = new URLSearchParams(window.location.search)
      for (const key of ATTRIBUTION_QUERY_KEYS) {
        const v = sp.get(key)
        if (v && v.length > 0) out[key] = v.slice(0, 500)
      }
      if (!out.landing_page) {
        out.landing_page = `${window.location.origin}${window.location.pathname}`.slice(
          0,
          500
        )
      }
      if (!out.captured_at) out.captured_at = new Date().toISOString()
    } catch {
      // window.location may throw in sandboxed iframes — fine,
      // we just submit with no attribution.
    }
    return out
  }, [])

  const stepIndex = STEPS.indexOf(step)
  const progress = ((stepIndex + 1) / STEPS.length) * 100

  const advance = async () => {
    const config = STEP_CONFIG[step]
    if (!config.optional && !current.trim()) return
    setError(null)

    const newValues = { ...values, [step]: current }
    setValues(newValues)
    setCurrent('')

    if (stepIndex === STEPS.length - 1) {
      setLoading(true)
      try {
        const budgetRaw = newValues.budget?.replace(/[^0-9.]/g, '')
        const response = await fetch('/api/widget', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            venue_id: venueId,
            name: newValues.name,
            email: newValues.email,
            phone: newValues.phone || null,
            event_date: newValues.date || null,
            guest_count: newValues.guests ? parseInt(newValues.guests) : null,
            budget: budgetRaw ? parseFloat(budgetRaw) : null,
            message: newValues.message || null,
            // Phase 8BH — forward parsed attribution context
            // alongside the lead so the dashboard renders the
            // correct source badge + the AttributionPerformance
            // card groups under the right label.
            attribution:
              Object.keys(attribution).length > 0 ? attribution : null,
          }),
        })

        if (!response.ok) {
          const err = await response.json().catch(() => null)
          console.error('Widget submission failed:', err)
          setError(typeof err?.error === 'string' ? err.error : "Something went wrong. Please try again.")
          setLoading(false)
          return
        }
        setStep('success')
      } catch (err) {
        console.error('Widget network error:', err)
        setError('Network error. Please check your connection and try again.')
      } finally {
        setLoading(false)
      }
    } else {
      setStep(STEPS[stepIndex + 1])
    }
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && STEP_CONFIG[step].type !== 'textarea') advance()
  }

  const variants = {
    enter:  { x: 30, opacity: 0 },
    center: { x: 0, opacity: 1 },
    exit:   { x: -30, opacity: 0 },
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{ background: 'linear-gradient(180deg, #F4F6FB 0%, #FFFFFF 60%)' }}
    >
      {/* Ambient slate blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 -left-32 w-[400px] h-[400px] rounded-full bg-[#DBE4F0] opacity-55 blur-[100px]" />
        <div className="absolute -bottom-32 -right-32 w-[400px] h-[400px] rounded-full bg-[#CFDCED] opacity-50 blur-[100px]" />
      </div>

      <div className="relative w-full max-w-[420px]">
        {/* Glass card */}
        <div className="bg-white border border-[#E2E8F0] rounded-[28px] p-7 shadow-[0_30px_80px_rgba(15,23,42,0.18)]">
          {/* Header */}
          <div className="flex items-center gap-2 mb-5">
            <div className="w-9 h-9 rounded-xl bg-navy-blue flex items-center justify-center shadow-[0_4px_12px_rgba(15,23,42,0.20)]">
              <svg viewBox="0 0 300 270" xmlns="http://www.w3.org/2000/svg" fill="white" className="w-5 h-5">
                <polygon points="8,26 58,26 33,72" />
                <polygon points="78,20 122,20 170,210 146,242 94,54" />
                <path d="M158,20 L204,20 Q268,20 268,96 L237,242 L208,210 L234,96 Q228,56 194,50 L158,50 Z" />
              </svg>
            </div>
            <div>
              <p className="text-[14px] font-semibold text-[#0F172A] leading-tight">VenueRise</p>
              <p className="text-[10px] text-[#64748B]">Let&apos;s plan something beautiful</p>
            </div>
          </div>

          {step === 'success' ? (
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="text-center py-6"
            >
              <div className="w-14 h-14 rounded-2xl bg-[#ECFDF5] border border-[#A7F3D0] flex items-center justify-center mx-auto mb-4">
                <Check className="w-7 h-7 text-[#059669]" />
              </div>
              <h2 className="text-[17px] font-semibold text-[#0F172A] mb-2">We&apos;ll be in touch!</h2>
              <p className="text-[13px] text-[#475569] leading-relaxed">
                Expect a personal reply within 5 minutes. We&apos;re excited to learn more about your event.
              </p>
              <div className="mt-5 inline-flex items-center gap-1.5 text-[11px] text-[#1D4ED8]">
                <Sparkles className="w-3 h-3" />
                Powered by VenueRise AI
              </div>
            </motion.div>
          ) : (
            <>
              {/* Progress bar */}
              <div className="mb-5">
                <div className="h-1.5 bg-[#F1F5F9] rounded-full overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-[#0F172A]"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ duration: 0.4 }}
                  />
                </div>
                <p className="text-[10px] text-[#94A3B8] mt-1.5">Question {stepIndex + 1} of {STEPS.length}</p>
              </div>

              <AnimatePresence mode="wait">
                <motion.div
                  key={step}
                  variants={variants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.22 }}
                >
                  <h2 className="text-[18px] font-semibold text-[#0F172A] leading-snug mb-1">
                    {STEP_CONFIG[step].label}
                    {STEP_CONFIG[step].optional && <span className="text-xs font-normal text-[#94A3B8] ml-2">(optional)</span>}
                  </h2>
                  {STEP_CONFIG[step].helper && (
                    <p className="text-[12px] text-[#64748B] mb-4">{STEP_CONFIG[step].helper}</p>
                  )}

                  {STEP_CONFIG[step].type === 'textarea' ? (
                    <textarea
                      autoFocus
                      value={current}
                      onChange={(e) => setCurrent(e.target.value)}
                      placeholder={STEP_CONFIG[step].placeholder}
                      rows={4}
                      className="w-full bg-white border border-[#E2E8F0] rounded-2xl px-4 py-3 text-sm text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#1D4ED8] focus:ring-[3px] focus:ring-[#3B82F6]/15 resize-none transition-all"
                    />
                  ) : (
                    <input
                      autoFocus
                      type={STEP_CONFIG[step].type}
                      value={current}
                      onChange={(e) => setCurrent(e.target.value)}
                      onKeyDown={handleKey}
                      placeholder={STEP_CONFIG[step].placeholder}
                      className="w-full h-12 bg-white border border-[#E2E8F0] rounded-2xl px-4 text-sm text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#1D4ED8] focus:ring-[3px] focus:ring-[#3B82F6]/15 transition-all"
                    />
                  )}

                  {error && (
                    <div className="mt-3 flex items-start gap-2 bg-[#FEF2F2] border border-[#FECACA] rounded-xl px-3 py-2.5">
                      <AlertCircle className="w-4 h-4 text-[#DC2626] shrink-0 mt-px" />
                      <p className="text-[12px] text-[#B91C1C] leading-snug">{error}</p>
                    </div>
                  )}

                  <button
                    onClick={advance}
                    disabled={loading}
                    className="mt-5 w-full h-12 flex items-center justify-center gap-2 bg-[#0F172A] hover:bg-[#1E293B] text-white font-semibold rounded-2xl text-[14px] transition-all disabled:opacity-60 shadow-[0_8px_24px_rgba(15,23,42,0.25)]"
                  >
                    {loading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        {stepIndex === STEPS.length - 1 ? 'Submit' : 'Continue'}
                        <ChevronRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </motion.div>
              </AnimatePresence>
            </>
          )}
        </div>

        <p className="text-[10px] text-center text-[#94A3B8] mt-4 flex items-center justify-center gap-1">
          <Sparkles className="w-2.5 h-2.5 text-[#1D4ED8]" />
          Replies in under 5 minutes · Your info stays private
        </p>
      </div>
    </div>
  )
}
