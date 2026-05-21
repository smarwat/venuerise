import type { Metadata } from 'next'
import Navbar from '@/components/Navbar'
import Hero from '@/components/Hero'
import PainPoints from '@/components/PainPoints'
import HowItWorks from '@/components/HowItWorks'
import DemoPreview from '@/components/DemoPreview'
import Differentiation from '@/components/Differentiation'
import ROI from '@/components/ROI'
import FAQ from '@/components/FAQ'
import FinalCTA from '@/components/FinalCTA'
import Footer from '@/components/Footer'

/**
 * GTM-0B — Public homepage.
 *
 * Section order is the sales narrative:
 *   1. Hero               — wedge + primary CTA
 *   2. PainPoints         — the 5 revenue leaks
 *   3. HowItWorks         — 4-step loop (unify → detect → draft → track)
 *   4. DemoPreview        — static mock of the Revenue OS dashboard
 *   5. Differentiation    — operator control + honesty
 *   6. ROI                — services-assisted pilot offer
 *   7. FAQ                — anti-positioning ("Is this a CRM?", etc.)
 *   8. FinalCTA           — apply-for-a-pilot form
 *
 * Removed from the previous page (overclaims / off-message):
 *   - SocialProof "Trusted by top venues nationwide" + venue-type
 *     marquee (we don't have those logo rights yet)
 *   - Trust generic "ShieldCheck" section (folded into
 *     Differentiation as the operator-control + honesty surface)
 *   - Solution generic 6-feature grid (HowItWorks now carries the
 *     loop story; PainPoints carries the gap story)
 */

export const metadata: Metadata = {
  title: 'VenueRise — AI Revenue OS for Wedding Venues',
  description:
    'Catch slow replies, cold leads, unbooked tours, and source blind spots across your wedding venue inquiries. AI drafts. Your team approves. No autonomous sending.',
}

export default function Home() {
  return (
    <main className="relative overflow-hidden">
      <Navbar />
      <Hero />
      <PainPoints />
      <HowItWorks />
      <DemoPreview />
      <Differentiation />
      <ROI />
      <FAQ />
      <FinalCTA />
      <Footer />
    </main>
  )
}
