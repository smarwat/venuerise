'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Mail, Lock, Sparkles, AlertCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

type Mode = 'password' | 'magic'

export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [magicSent, setMagicSent] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const supabase = createClient()

    if (mode === 'password') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) { setError(error.message); setLoading(false); return }
      router.push('/dashboard')
      router.refresh()
    } else {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/dashboard` },
      })
      if (error) { setError(error.message); setLoading(false); return }
      setMagicSent(true)
      setLoading(false)
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{ background: 'linear-gradient(180deg, #F4F6FB 0%, #FFFFFF 100%)' }}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 left-1/4 w-[500px] h-[500px] rounded-full bg-[#DBE4F0] opacity-55 blur-[110px]" />
        <div className="absolute -bottom-40 right-1/4 w-[500px] h-[500px] rounded-full bg-[#CFDCED] opacity-50 blur-[120px]" />
      </div>

      <div className="relative w-full max-w-[420px]">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-7">
          <div className="w-10 h-10 rounded-2xl bg-navy-blue flex items-center justify-center shadow-[0_8px_24px_rgba(15,23,42,0.25)]">
            <svg viewBox="0 0 300 270" xmlns="http://www.w3.org/2000/svg" fill="white" className="w-5 h-5">
              <polygon points="8,26 58,26 33,72" />
              <polygon points="78,20 122,20 170,210 146,242 94,54" />
              <path d="M158,20 L204,20 Q268,20 268,96 L237,242 L208,210 L234,96 Q228,56 194,50 L158,50 Z" />
            </svg>
          </div>
          <span className="text-[#0F172A] font-bold text-[22px] tracking-[-0.02em]">VenueRise</span>
        </div>

        {/* Card */}
        <div className="bg-white border border-[#E2E8F0] rounded-[28px] p-8 shadow-[0_30px_80px_rgba(15,23,42,0.18)]">
          <h1 className="text-[19px] font-semibold text-[#0F172A] mb-1.5">Welcome back</h1>
          <p className="text-[13px] text-[#475569] mb-6">Sign in to your AI-powered operating system</p>

          {/* Mode toggle */}
          <div className="flex bg-[#F1F5F9] border border-[#E2E8F0] rounded-full p-1 mb-5">
            <button
              type="button"
              onClick={() => { setMode('password'); setError(null) }}
              className={`flex-1 py-1.5 rounded-full text-[12px] font-semibold transition-all ${
                mode === 'password' ? 'bg-white text-[#0F172A] shadow-[0_1px_3px_rgba(15,23,42,0.08)]' : 'text-[#475569] hover:text-[#0F172A]'
              }`}
            >
              Password
            </button>
            <button
              type="button"
              onClick={() => { setMode('magic'); setError(null); setMagicSent(false) }}
              className={`flex-1 py-1.5 rounded-full text-[12px] font-semibold transition-all ${
                mode === 'magic' ? 'bg-white text-[#1D4ED8] shadow-[0_1px_3px_rgba(15,23,42,0.08)]' : 'text-[#475569] hover:text-[#0F172A]'
              }`}
            >
              ✨ Magic Link
            </button>
          </div>

          {magicSent ? (
            <div className="text-center py-6">
              <div className="w-12 h-12 rounded-2xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center mx-auto mb-3">
                <Mail className="w-6 h-6 text-[#1D4ED8]" />
              </div>
              <h3 className="text-[14px] font-semibold text-[#0F172A] mb-1.5">Check your email</h3>
              <p className="text-[12px] text-[#475569]">
                We sent a magic link to <span className="text-[#0F172A] font-medium">{email}</span>
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3.5">
              {error && (
                <div className="flex items-start gap-2 bg-[#FEF2F2] border border-[#FECACA] rounded-xl px-3 py-2.5">
                  <AlertCircle className="w-4 h-4 text-[#DC2626] shrink-0 mt-px" />
                  <p className="text-[12px] text-[#B91C1C] leading-snug">{error}</p>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-1.5">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8]" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@yourvenue.com"
                    required
                    className="w-full h-11 bg-white border border-[#E2E8F0] rounded-xl pl-10 pr-3 text-sm text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#1D4ED8] focus:ring-[3px] focus:ring-[#3B82F6]/15 transition-all"
                  />
                </div>
              </div>

              {mode === 'password' && (
                <div>
                  <label className="block text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider mb-1.5">Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8]" />
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      className="w-full h-11 bg-white border border-[#E2E8F0] rounded-xl pl-10 pr-3 text-sm text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#1D4ED8] focus:ring-[3px] focus:ring-[#3B82F6]/15 transition-all"
                    />
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full h-11 bg-[#0F172A] hover:bg-[#1E293B] text-white font-semibold rounded-xl flex items-center justify-center gap-2 transition-all disabled:opacity-60 shadow-[0_8px_24px_rgba(15,23,42,0.25)] mt-1"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : mode === 'password' ? (
                  'Sign in'
                ) : (
                  <>
                    <Mail className="w-4 h-4" /> Send magic link
                  </>
                )}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-[11px] text-[#94A3B8] mt-5 flex items-center justify-center gap-1">
          <Sparkles className="w-3 h-3 text-[#1D4ED8]" />
          Secured by Supabase Auth
        </p>
      </div>
    </div>
  )
}
