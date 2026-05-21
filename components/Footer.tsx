import { ArrowUpRight } from 'lucide-react'

const links = [
  { label: 'Home', href: '#hero' },
  { label: 'Revenue leaks', href: '#leaks' },
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Operator control', href: '#why' },
  { label: 'Pilot', href: '#pilot' },
  { label: 'FAQ', href: '#faq' },
  { label: 'Book a demo', href: '/demo' },
]

function VenueLogo() {
  return (
    <svg width="28" height="28" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polygon points="4,6 22,6 13,20" fill="#1A6FFF" />
      <polygon points="22,6 40,6 26,74 8,74" fill="#1A6FFF" />
      <path d="M44 6 L62 6 Q72 6 74 16 L58 74 L40 74 Z" fill="#1A6FFF" />
    </svg>
  )
}

export default function Footer() {
  return (
    <footer className="relative border-t border-black/[0.06] bg-[#F4F7FF]">
      <div className="noise-layer" style={{ opacity: 0.02 }} />
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid lg:grid-cols-[1.5fr_1fr_1fr] gap-10 lg:gap-16 mb-12">
          {/* Brand */}
          <div>
            <div className="flex items-center gap-2.5 mb-4">
              <VenueLogo />
              <span className="font-display font-bold text-[19px] text-[#0A0A1A] tracking-[-0.01em]">
                VenueRise
              </span>
            </div>
            <p className="text-[14.5px] text-[#475569] max-w-sm leading-[1.6] mb-5">
              AI Revenue OS for wedding venues. Connects your fragmented inquiry channels and helps your team turn more inquiries into booked tours.
            </p>
            <a
              href="mailto:hello@venuerise.com"
              className="inline-flex items-center gap-2 text-[14px] text-[#1A6FFF] hover:text-[#1058D6] transition-colors font-semibold group"
            >
              hello@venuerise.com
              <ArrowUpRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
            </a>
          </div>

          {/* Navigate */}
          <div>
            <p className="text-[11px] font-bold text-[#0A0A1A] uppercase tracking-[0.14em] mb-4">Navigate</p>
            <nav className="flex flex-col gap-2.5">
              {links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="text-[14px] text-[#475569] hover:text-[#0A0A1A] transition-colors w-fit"
                >
                  {link.label}
                </a>
              ))}
            </nav>
          </div>

          {/* Get Started */}
          <div>
            <p className="text-[11px] font-bold text-[#0A0A1A] uppercase tracking-[0.14em] mb-4">Get Started</p>
            <p className="text-[14px] text-[#475569] mb-4 leading-relaxed">
              30 minutes. Bring your current setup; we&rsquo;ll walk a Revenue OS demo with you.
            </p>
            <a
              href="/demo"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#1A6FFF] text-white text-[13px] font-semibold rounded-lg hover:bg-[#1058D6] transition-all duration-200 hover:shadow-[0_6px_20px_rgba(26,111,255,0.3)]"
            >
              Book a demo
              <ArrowUpRight className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="pt-6 border-t border-black/[0.05] flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-[12px] text-[#94A3B8]">
            © {new Date().getFullYear()} VenueRise. All rights reserved.
          </p>
          <p className="text-[12px] text-[#94A3B8]">Privacy Policy · Terms of Service</p>
        </div>
      </div>
    </footer>
  )
}
