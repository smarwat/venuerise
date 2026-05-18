import Navbar from '@/components/Navbar'
import Hero from '@/components/Hero'
import SocialProof from '@/components/SocialProof'
import PainPoints from '@/components/PainPoints'
import Solution from '@/components/Solution'
import HowItWorks from '@/components/HowItWorks'
import ROI from '@/components/ROI'
import DemoPreview from '@/components/DemoPreview'
import Differentiation from '@/components/Differentiation'
import Trust from '@/components/Trust'
import FinalCTA from '@/components/FinalCTA'
import Footer from '@/components/Footer'

export default function Home() {
  return (
    <main className="relative overflow-hidden">
      <Navbar />
      <Hero />
      <SocialProof />
      <PainPoints />
      <Solution />
      <HowItWorks />
      <ROI />
      <DemoPreview />
      <Differentiation />
      <Trust />
      <FinalCTA />
      <Footer />
    </main>
  )
}
