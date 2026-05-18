'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Bell, Search, Settings, LogOut, ChevronDown } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useDashboard } from '@/lib/contexts/dashboard-context'

const navItems = [
  { href: '/dashboard',           label: 'Overview' },
  { href: '/dashboard/leads',     label: 'Leads' },
  { href: '/dashboard/inbox',     label: 'Inbox' },
  { href: '/dashboard/tours',     label: 'Tours' },
  { href: '/dashboard/analytics', label: 'Analytics' },
  { href: '/dashboard/settings',  label: 'Settings' },
]

export default function DashboardTopNav() {
  const pathname = usePathname()
  const router = useRouter()
  const { venue } = useDashboard()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const handleLogout = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  const initial = venue?.name?.charAt(0) ?? 'V'

  return (
    <header className="flex items-center h-[72px] px-6 border-b border-[#E2E8F0] bg-white sticky top-0 z-40">
      {/* Left — logo + workspace pills */}
      <div className="flex items-center gap-3">
        <Link href="/dashboard" className="flex items-center gap-2.5 group">
          <div className="w-9 h-9 rounded-xl bg-navy-blue flex items-center justify-center shadow-[0_4px_12px_rgba(15,23,42,0.20)] group-hover:shadow-[0_6px_18px_rgba(15,23,42,0.28)] transition-shadow">
            <svg viewBox="0 0 300 270" xmlns="http://www.w3.org/2000/svg" fill="white" className="w-5 h-5">
              <polygon points="8,26 58,26 33,72" />
              <polygon points="78,20 122,20 170,210 146,242 94,54" />
              <path d="M158,20 L204,20 Q268,20 268,96 L237,242 L208,210 L234,96 Q228,56 194,50 L158,50 Z" />
            </svg>
          </div>
          <span className="font-semibold text-[#0F172A] text-[15px] tracking-[-0.01em] hidden sm:inline">
            VenueRise
          </span>
        </Link>

        {/* Workspace label — restrained, enterprise */}
        {venue?.name && (
          <div className="hidden md:flex items-center gap-2 ml-2 pl-3 border-l border-[#E2E8F0]">
            <span className="text-[12px] text-[#64748B]">Workspace</span>
            <span className="text-[12px] font-semibold text-[#0F172A] truncate max-w-[180px]">{venue.name}</span>
          </div>
        )}
      </div>

      {/* Center — primary nav */}
      <nav className="hidden lg:flex items-center gap-0.5 mx-auto bg-[#F1F5F9] border border-[#E2E8F0] rounded-full p-1">
        {navItems.map(({ href, label }) => {
          const isActive = href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'px-3.5 py-1.5 text-[13px] font-medium rounded-full transition-all duration-200',
                isActive
                  ? 'bg-white text-[#0F172A] shadow-[0_1px_3px_rgba(15,23,42,0.08)]'
                  : 'text-[#475569] hover:text-[#0F172A] hover:bg-white/60'
              )}
            >
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Mobile nav scroll */}
      <nav className="lg:hidden flex items-center gap-0.5 ml-3 overflow-x-auto flex-1 no-scrollbar">
        {navItems.map(({ href, label }) => {
          const isActive = href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'shrink-0 px-3 py-1.5 text-[13px] font-medium rounded-full transition-all',
                isActive
                  ? 'bg-[#0F172A] text-white shadow-[0_2px_8px_rgba(15,23,42,0.30)]'
                  : 'text-[#475569] hover:text-[#0F172A]'
              )}
            >
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Right — search, bell, avatar */}
      <div className="flex items-center gap-2 ml-auto">
        <button className="hidden md:flex w-9 h-9 items-center justify-center rounded-full text-[#475569] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition-colors" aria-label="Search">
          <Search className="w-4 h-4" />
        </button>
        <button className="hidden sm:flex w-9 h-9 items-center justify-center rounded-full text-[#475569] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition-colors relative" aria-label="Notifications">
          <Bell className="w-4 h-4" />
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-[#1D4ED8]" />
        </button>

        <div ref={menuRef} className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full hover:bg-[#F1F5F9] transition-colors"
          >
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#1E293B] to-[#0F172A] flex items-center justify-center text-white text-xs font-bold ring-2 ring-white shadow-sm">
              {initial}
            </div>
            <ChevronDown className="w-3 h-3 text-[#94A3B8]" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full mt-2 w-56 bg-white border border-[#E2E8F0] rounded-2xl shadow-[0_20px_50px_rgba(15,23,42,0.18)] p-2 z-50 animate-fade-in">
              {venue && (
                <div className="px-3 py-2 border-b border-[#F1F5F9] mb-1">
                  <p className="text-[11px] text-[#94A3B8] uppercase tracking-wider font-semibold">Workspace</p>
                  <p className="text-sm font-medium text-[#0F172A] truncate mt-0.5">{venue.name}</p>
                </div>
              )}
              <Link href="/dashboard/settings" className="flex items-center gap-2.5 px-3 py-2 text-sm text-[#0F172A] hover:bg-[#F1F5F9] rounded-lg transition-colors">
                <Settings className="w-4 h-4 text-[#475569]" />
                Settings
              </Link>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-[#DC2626] hover:bg-[#FEF2F2] rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
