'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Bell, Search, Plus } from 'lucide-react'
import { useDashboard } from '@/lib/contexts/dashboard-context'
import CommandPalette from './CommandPalette'

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

  // Phase 8AJ — global ⌘K / Ctrl+K palette state. The topbar owns it
  // so any dashboard page picks up the keybinding without each page
  // wiring its own listener. Keybinding works regardless of focus
  // target except when typing into a text input / textarea / contentEditable
  // (we let those keystrokes pass through so palette-like input
  // tokens don't get hijacked while editing a draft).
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKey = (e: KeyboardEvent) => {
      const isModK =
        (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)
      if (!isModK) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const inEditable =
        tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true
      // Allow ⌘K from within text inputs too — operators expect the
      // standard global shortcut to win. Preventing default keeps
      // the browser's "focus location bar" behavior from firing.
      e.preventDefault()
      setPaletteOpen((o) => !o)
      // Reference the unused branch flag so a future refactor can
      // toggle the policy without dropping the variable.
      void inEditable
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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

      {/* Phase 8AJ — search pill now opens the global CommandPalette.
          We render a non-editable button-shaped pill so the click
          target is the whole pill (clicking the input would otherwise
          focus a real input the operator can't actually search with
          yet). The palette owns the typeable input. */}
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="flex items-center gap-2.5 px-3 py-[7px] rounded-full bg-[#F8FAFC] border border-[#E6E8EF] min-w-0 flex-1 lg:flex-none lg:min-w-[340px] hover:bg-white hover:border-[#CBD5E1] transition-colors text-left"
        aria-label="Open command palette"
      >
        <Search className="w-[14px] h-[14px] text-[#64748B] shrink-0" />
        <span className="text-[13px] text-[#94A3B8] flex-1 truncate min-w-0">
          Search leads, tours, messages…
        </span>
        <span className="hidden sm:inline font-mono text-[11px] px-1.5 py-px border border-[#E6E8EF] rounded-md bg-white text-[#475569]">
          ⌘K
        </span>
      </button>

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

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </header>
  )
}
