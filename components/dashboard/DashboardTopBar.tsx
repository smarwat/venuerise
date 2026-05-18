'use client'

import { Bell, Search } from 'lucide-react'
import { useDashboard } from '@/lib/contexts/dashboard-context'

interface DashboardTopBarProps {
  title: string
  subtitle?: string
}

export default function DashboardTopBar({ title, subtitle }: DashboardTopBarProps) {
  const { venue } = useDashboard()

  return (
    <header className="h-[60px] border-b border-[#1C2333] bg-[#0D1117] flex items-center px-6 gap-4 sticky top-0 z-30">
      {/* Title */}
      <div className="flex-1 min-w-0">
        <h1 className="text-[15px] font-semibold text-[#F0F6FC] truncate">{title}</h1>
        {subtitle && (
          <p className="text-xs text-[#8B949E] truncate">{subtitle}</p>
        )}
      </div>

      {/* Search */}
      <div className="hidden md:flex items-center gap-2 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 h-8 w-64">
        <Search className="w-3.5 h-3.5 text-[#8B949E] shrink-0" />
        <input
          placeholder="Search leads, conversations…"
          className="flex-1 bg-transparent text-xs text-[#8B949E] placeholder:text-[#8B949E] outline-none"
        />
        <kbd className="text-[10px] text-[#8B949E] bg-white/[0.06] rounded px-1">⌘K</kbd>
      </div>

      {/* Notifications */}
      <button className="relative w-8 h-8 flex items-center justify-center rounded-xl text-[#8B949E] hover:text-[#F0F6FC] hover:bg-white/[0.06] transition-all">
        <Bell className="w-4 h-4" />
        <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-[#1A7FFF]" />
      </button>

      {/* Venue avatar */}
      <div className="w-8 h-8 rounded-xl bg-[#1A7FFF]/20 border border-[#1A7FFF]/30 flex items-center justify-center">
        <span className="text-xs font-semibold text-[#1A7FFF]">
          {venue?.name?.charAt(0) ?? 'V'}
        </span>
      </div>
    </header>
  )
}
