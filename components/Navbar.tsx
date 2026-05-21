'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Menu, X, ArrowRight } from 'lucide-react'

const navLinks = [
  { label: 'Revenue leaks', href: '#leaks' },
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Operator control', href: '#why' },
  { label: 'Pilot', href: '#pilot' },
  { label: 'FAQ', href: '#faq' },
]

function VenueLogo() {
  return (
    <svg width="28" height="28" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Small triangle top-left */}
      <polygon points="4,6 22,6 13,20" fill="#1A6FFF" />
      {/* Left thick diagonal stroke */}
      <polygon points="22,6 40,6 26,74 8,74" fill="#1A6FFF" />
      {/* Right curved stroke */}
      <path d="M44 6 L62 6 Q72 6 74 16 L58 74 L40 74 Z" fill="#1A6FFF" />
    </svg>
  )
}

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const handleScroll = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault()
    const el = document.querySelector(href)
    if (el) el.scrollIntoView({ behavior: 'smooth' })
    setMobileOpen(false)
  }

  return (
    <>
      <motion.header
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5 }}
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
          scrolled
            ? 'bg-white/95 backdrop-blur-xl border-b border-black/[0.06] shadow-sm'
            : 'bg-[#070B1A]/20 backdrop-blur-md border-b border-white/[0.08]'
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16 lg:h-18">
            {/* Logo */}
            <a href="#hero" onClick={(e) => handleScroll(e, '#hero')} className="flex items-center gap-2.5 group">
              <VenueLogo />
              <span
                className={`font-display font-bold text-lg tracking-tight group-hover:text-[#4D90FF] transition-colors ${
                  scrolled ? 'text-[#0A0A1A]' : 'text-white'
                }`}
              >
                VenueRise
              </span>
            </a>

            {/* Desktop Nav */}
            <nav className="hidden lg:flex items-center gap-1">
              {navLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={(e) => handleScroll(e, link.href)}
                  className={`px-4 py-2 text-sm transition-colors rounded-lg ${
                    scrolled
                      ? 'text-[#4A5568] hover:text-[#0A0A1A] hover:bg-[#1A6FFF]/[0.05]'
                      : 'text-white/80 hover:text-white hover:bg-white/[0.08]'
                  }`}
                >
                  {link.label}
                </a>
              ))}
            </nav>

            {/* Desktop CTA */}
            <div className="hidden lg:flex items-center gap-3">
              <a
                href="/demo"
                className="flex items-center gap-2 px-5 py-2.5 bg-[#1A6FFF] text-white text-sm font-semibold rounded-xl hover:bg-[#1058D6] transition-all duration-200 hover:shadow-[0_6px_24px_rgba(26,111,255,0.45)]"
              >
                Book a demo
                <ArrowRight className="w-3.5 h-3.5" />
              </a>
            </div>

            {/* Mobile menu button */}
            <button
              className={`lg:hidden p-2 transition-colors ${
                scrolled ? 'text-[#4A5568] hover:text-[#0A0A1A]' : 'text-white/85 hover:text-white'
              }`}
              onClick={() => setMobileOpen(!mobileOpen)}
              aria-label="Toggle menu"
            >
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </motion.header>

      {/* Mobile Menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-x-0 top-16 z-40 bg-white/98 backdrop-blur-xl border-b border-black/[0.06] shadow-lg lg:hidden"
          >
            <div className="max-w-7xl mx-auto px-4 py-6 flex flex-col gap-1">
              {navLinks.map((link, i) => (
                <motion.a
                  key={link.href}
                  href={link.href}
                  onClick={(e) => handleScroll(e, link.href)}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="px-4 py-3 text-[#4A5568] hover:text-[#0A0A1A] hover:bg-[#1A6FFF]/[0.05] rounded-xl transition-all text-sm font-medium"
                >
                  {link.label}
                </motion.a>
              ))}
              <div className="pt-3 mt-2 border-t border-black/[0.06]">
                <a
                  href="/demo"
                  className="flex items-center justify-center gap-2 w-full px-5 py-3 bg-[#1A6FFF] text-white font-semibold rounded-xl text-sm"
                >
                  Book a demo
                  <ArrowRight className="w-4 h-4" />
                </a>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
