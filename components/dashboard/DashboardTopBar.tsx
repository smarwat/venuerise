'use client'

import Link from 'next/link'
import { Bell, Search, Plus } from 'lucide-react'
import { useDashboard } from '@/lib/contexts/dashboard-context'

/**
 * Phase 8AG — slim white topbar matching the reference design.
 *
 * Holds:
 *   - Search pill (placeholder + ⌘K kbd hint; non-interactive for now —
 *     wired in a later phase when global search lands)
 *   - Right cluster: live dot + dynamic date, bell w/ unread dot,
 *     primary "New lead" CTA linking to /dashboard/leads (the
 *     leads board owns the AddLeadModal trigger).
 *
 * Sticky to top of the main column; sits ALONGSIDE the dark
 * DashboardSidebar (sidebar covers leftmost 260px on lg+, topbar
 * occupies the remaining width).
 *
 * Mobile note: dark sidebar collapses on < lg breakpoints, so the
 * topbar's left edge picks up the brand-mark slot via the inline
 * fallback below.
 */

function formatHeaderDate(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

export default function DashboardTopBar() {
  const { venue } = useDashboard()
  const venueName = venue?.name ?? null

  return (
    <header className="sticky top-0 z-30 h-[60px] bg-white border-b border-[#E6E8EF] flex items-center gap-3 px-4 lg:px-6">
      {/* Mobile brand fallback (dark sidebar is hidden on <lg) */}
      <Link href="/dashboard" className="lg:hidden flex items-center gap-2 mr-1">
        <div className="w-7 h-7 rounded-lg bg-[#14141A] text-white flex items-center justify-center font-bold text-[12px]">
          {(venueName ?? 'V').slice(0, 1).toUpperCase()}
        </div>
        <span className="font-semibold text-[#0F172A] text-[14px] tracking-[-0.01em] truncate max-w-[140px]">
          {venueName ?? 'VenueRise'}
        </span>
      </Link>

      {/* Search pill — full width on mobile, fixed-ish on desktop */}
      <div className="flex items-center gap-2.5 px-3 py-[7px] rounded-full bg-[#F8FAFC] border border-[#E6E8EF] min-w-0 flex-1 lg:flex-none lg:min-w-[340px]">
        <Search className="w-[14px] h-[14px] text-[#64748B] shrink-0" />
        <input
          type="text"
          placeholder="Search leads, tours, messages…"
          className="bg-transparent border-0 outline-none text-[13px] text-[#0F172A] placeholder:text-[#94A3B8] flex-1 min-w-0"
        />
        <span className="hidden sm:inline font-mono text-[11px] px-1.5 py-px border border-[#E6E8EF] rounded-md bg-white text-[#475569]">
          ⌘K
        </span>
      </div>

      <div className="flex-1 hidden lg:block" />

      {/* Live indicator + date */}
      <div className="hidden md:flex items-center gap-2 text-[12px] text-[#64748B]">
        <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500">
          <span className="absolute inset-[-3px] rounded-full bg-emerald-500/30 animate-ping" />
        </span>
        <span>Live</span>
        <span className="text-[#94A3B8]">·</span>
        <span className="font-mono text-[11.5px]">{formatHeaderDate()}</span>
      </div>

      {/* Bell with unread dot */}
      <button
        type="button"
        aria-label="Notifications"
        className="relative w-9 h-9 rounded-[10px] border border-[#E6E8EF] bg-white flex items-center justify-center text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
      >
        <Bell className="w-[15px] h-[15px]" />
        <span className="absolute top-1.5 right-1.5 w-[7px] h-[7px] rounded-full bg-[#2563EB] ring-2 ring-white" />
      </button>

      {/* New lead CTA — links to /dashboard/leads where the existing
          AddLeadModal trigger lives. Avoids duplicating modal state
          in the topbar. */}
      <Link
        href="/dashboard/leads"
        className="inline-flex items-center gap-[7px] h-9 px-3.5 rounded-[10px] bg-[#0F172A] text-white text-[13px] font-medium hover:bg-[#1E293B] transition-colors"
      >
        <Plus className="w-[14px] h-[14px]" />
        <span className="hidden sm:inline">New lead</span>
      </Link>
    </header>
  )
}
