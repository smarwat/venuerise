'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowRight, CheckCircle2, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

const volumes = [
  'Under 25 inquiries / month',
  '25–75 inquiries / month',
  '75–200 inquiries / month',
  '200+ inquiries / month',
]

type Status = 'idle' | 'submitting' | 'success' | 'error'

export default function AuditForm() {
  const [status, setStatus] = useState<Status>('idle')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()

    const form = e.currentTarget
    const data = new FormData(form)

    const newErrors: Record<string, string> = {}

    const name = String(data.get('name') || '').trim()
    const venue = String(data.get('venue') || '').trim()
    const email = String(data.get('email') || '').trim()
    const website = String(data.get('website') || '').trim()
    const volume = String(data.get('volume') || '').trim()

    if (!name) newErrors.name = 'Your name is required'
    if (!venue) newErrors.venue = 'Venue name is required'
    if (!email) newErrors.email = 'Work email is required'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = 'Enter a valid email'
    }

    setErrors(newErrors)

    if (Object.keys(newErrors).length > 0) {
      const first = form.querySelector<HTMLInputElement>(
        `[name="${Object.keys(newErrors)[0]}"]`
      )
      first?.focus()
      return
    }

    setStatus('submitting')

    const supabase = createClient()
    const { error } = await supabase.from('audit_leads').insert({
      name,
      venue_name: venue,
      email,
      website,
      monthly_inquiry_volume: volume,
      source: 'website',
    })

    if (error) {
      console.error(error)
      setStatus('error')
      return
    }

    setStatus('success')
    form.reset()
  }

  return (
    <div className="relative">
      <AnimatePresence mode="wait">
        {status === 'success' ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="card-glass p-10 lg:p-12 text-center"
            role="status"
            aria-live="polite"
          >
            <div className="w-14 h-14 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center mx-auto mb-5">
              <CheckCircle2 className="w-7 h-7 text-emerald-600" />
            </div>
            <h3 className="font-display text-[26px] font-semibold text-[#0A0A1A] mb-3 tracking-[-0.01em]">
              Application received.
            </h3>
            <p className="text-[#475569] text-[15px] max-w-sm mx-auto leading-relaxed">
              We&rsquo;ll review your venue and reach out within one business day to walk a Revenue OS demo with you.
            </p>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            onSubmit={handleSubmit}
            noValidate
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.45 }}
            className="card-glass p-7 lg:p-9 space-y-5"
            aria-label="Request a free venue audit"
          >
            <div>
              <h3 className="font-display text-[24px] font-semibold text-[#0A0A1A] mb-1.5 tracking-[-0.01em]">
                Apply for a pilot
              </h3>
              <p className="text-[14px] text-[#64748B] leading-relaxed">
                30-minute Revenue OS walkthrough with your team. No commitment — fit, scope, and what success looks like first.
              </p>
            </div>

            {status === 'error' && (
              <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
                Something went wrong. Please try again.
              </p>
            )}

            <div className="grid sm:grid-cols-2 gap-4">
              <Field
                label="Your name"
                name="name"
                placeholder="Jordan Bennett"
                autoComplete="name"
                required
                error={errors.name}
              />
              <Field
                label="Venue name"
                name="venue"
                placeholder="The Ivy Estate"
                autoComplete="organization"
                required
                error={errors.venue}
              />
            </div>

            <Field
              label="Work email"
              name="email"
              type="email"
              placeholder="you@yourvenue.com"
              autoComplete="email"
              required
              error={errors.email}
            />

            <Field
              label="Venue website"
              name="website"
              type="url"
              placeholder="https://yourvenue.com"
              autoComplete="url"
              optional
            />

            <SelectField
              label="Monthly inquiry volume"
              name="volume"
              options={volumes}
              required
            />

            <button
              type="submit"
              disabled={status === 'submitting'}
              className="btn-primary w-full justify-center mt-2 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {status === 'submitting' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Sending request…
                </>
              ) : (
                <>
                  Request Free Audit
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>

            <p className="text-[12px] text-[#94A3B8] text-center leading-relaxed">
              We respond within one business day. Your information stays private.
            </p>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  )
}

function Field({
  label,
  name,
  type = 'text',
  placeholder,
  autoComplete,
  required,
  optional,
  error,
}: {
  label: string
  name: string
  type?: string
  placeholder?: string
  autoComplete?: string
  required?: boolean
  optional?: boolean
  error?: string
}) {
  return (
    <div>
      <label htmlFor={name} className="flex items-center justify-between text-[13px] font-semibold text-[#0A0A1A] mb-1.5">
        {label}
        {optional && <span className="text-[11px] font-normal text-[#94A3B8]">Optional</span>}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={!!error}
        aria-describedby={error ? `${name}-error` : undefined}
        className={`input-field ${error ? 'border-red-400 focus:border-red-500 focus:shadow-[0_0_0_4px_rgba(239,68,68,0.12)]' : ''}`}
      />
      {error && (
        <p id={`${name}-error`} role="alert" className="text-[12px] text-red-600 mt-1.5">
          {error}
        </p>
      )}
    </div>
  )
}

function SelectField({
  label,
  name,
  options,
  required,
}: {
  label: string
  name: string
  options: string[]
  required?: boolean
}) {
  return (
    <div>
      <label htmlFor={name} className="block text-[13px] font-semibold text-[#0A0A1A] mb-1.5">
        {label}
      </label>
      <div className="relative">
        <select
          id={name}
          name={name}
          required={required}
          defaultValue=""
          className="input-field appearance-none pr-10 cursor-pointer"
        >
          <option value="" disabled>
            Select a range…
          </option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8] pointer-events-none"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  )
}