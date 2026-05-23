import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, Mail, Sparkles } from 'lucide-react'
import Navbar from '@/components/Navbar'
import Footer from '@/components/Footer'
import AuditForm from '@/components/AuditForm'

/**
 * GTM-0B — Public demo / pilot application page.
 *
 * Lightweight booking surface. Reuses the existing AuditForm (which
 * writes to the `audit_leads` table on submit) so we don't need to
 * stand up a new backend handler. The form copy already says
 * "Apply for a pilot" (rewritten in GTM-0B), so this page is a
 * focused landing zone for the homepage CTAs.
 *
 * No backend changes here — pure marketing route.
 */

export const metadata: Metadata = {
  title: 'Book a demo — VenueRise',
  description:
    'Walk a Revenue OS dashboard with your team. 30 minutes. We map your real lead sources and talk pilot scope.',
}

const SALES_EMAIL = 'hello@venuerise.com'

export default function DemoPage() {
  return (
    <main className="relative overflow-hidden bg-white">
      <Navbar />

      <section className="relative pt-32 pb-20 lg:pt-40 lg:pb-28 bg-[#F4F7FF] overflow-hidden">
        <div className="absolute top-20 right-[15%] w-[400px] h-[400px] bg-[#1A6FFF]/[0.06] rounded-full blur-[120px] pointer-events-none" />
        <div className="absolute bottom-0 left-[10%] w-[360px] h-[360px] bg-[#5599FF]/[0.05] rounded-full blur-[100px] pointer-events-none" />

        <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-[13px] text-[#475569] hover:text-[#0A0A1A] mb-8"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to home
          </Link>

          <div className="grid lg:grid-cols-[1fr_1.1fr] gap-10 lg:gap-14 items-start">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#1A6FFF]/30 bg-[#EFF6FF] text-[#1D4ED8] text-[11px] font-bold uppercase tracking-[0.16em] mb-6">
                <Sparkles className="w-3 h-3" />
                Apply for a pilot
              </div>

              <h1 className="font-display text-[44px] sm:text-[54px] lg:text-[64px] font-bold text-[#0A0A1A] leading-[1.04] tracking-[-0.02em] mb-6">
                See where your wedding venue&rsquo;s{' '}
                <span className="text-gradient">revenue is leaking.</span>
              </h1>

              <p className="text-[17px] text-[#475569] leading-[1.6] mb-8 max-w-[520px]">
                30 minutes. We&rsquo;ll walk the Revenue OS dashboard
                with your team, map your real lead sources, and talk
                pilot scope. No commitment. Conversation first.
              </p>

              <ul className="space-y-3 mb-8 max-w-[480px]">
                {[
                  'AI drafts. Your team approves. No autonomous sending.',
                  'Manual-required channels (Instagram, The Knot, WeddingWire) stay operator-sent.',
                  'Brand voice + knowledge base configured for your venue during pilot.',
                  'Walk a live, seeded Revenue OS dashboard so you see exactly what your team would see.',
                ].map((b) => (
                  <li
                    key={b}
                    className="flex items-start gap-3 text-[14px] text-[#0A0A1A] leading-[1.55]"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-[#1A6FFF] mt-2 shrink-0" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>

              <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#94A3B8] mb-2">
                  Prefer email?
                </p>
                <a
                  href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent('VenueRise pilot inquiry')}`}
                  className="inline-flex items-center gap-2 text-[14px] font-semibold text-[#1D4ED8] hover:text-[#1058D6]"
                >
                  <Mail className="w-3.5 h-3.5" />
                  {SALES_EMAIL}
                </a>
                <p className="mt-2 text-[12px] text-[#475569] leading-relaxed">
                  Tell us your venue, your current lead sources, and
                  roughly how many inquiries you get a month. We&rsquo;ll
                  reply within one business day.
                </p>
              </div>
            </div>

            <div>
              <AuditForm />
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  )
}
