'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  Home,
  Users,
  Inbox as InboxIcon,
  CalendarCheck,
  BarChart3,
  Settings,
  LogOut,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useDashboard } from '@/lib/contexts/dashboard-context'

/**
 * Phase 8AG — dark charcoal sidebar matching the reference design.
 *
 * Sits at fixed-left, 260px wide, with:
 *   - Brand block (square mark + venue name + "VENUERISE" eyebrow)
 *   - Workspace label
 *   - Nav items (Overview / Leads / Inbox / Tours / Analytics / Settings)
 *     with optional count badges + accent dot for unread
 *   - Bottom owner/venue card with initials avatar + status dot
 *
 * Counts (`leadCount`, `inboxCount`, `tourCount`) are optional — the
 * layout passes server-fetched counts when available; missing ones
 * render without a badge. Active state uses a subtle white-tint pill.
 *
 * No backend behavior changes. Existing auth + role gates intact.
 */

interface DashboardSidebarProps {
  leadCount?: number | null
  inboxCount?: number | null
  inboxUnread?: boolean
  tourCount?: number | null
  /** Owner / current user display name. Falls back to venue/email. */
  ownerName?: string | null
  /** Optional sub-label under the owner name (e.g. "Camden, Maine"). */
  ownerSubtitle?: string | null
  /** Initials shown in the bottom avatar. Falls back to first letter. */
  ownerInitials?: string | null
}

const navItems = [
  { href: '/dashboard',           label: 'Overview',  icon: Home,          key: 'home' as const },
  { href: '/dashboard/leads',     label: 'Leads',     icon: Users,         key: 'leads' as const },
  { href: '/dashboard/inbox',     label: 'Inbox',     icon: InboxIcon,     key: 'inbox' as const },
  { href: '/dashboard/tours',     label: 'Tours',     icon: CalendarCheck, key: 'tours' as const },
  { href: '/dashboard/analytics', label: 'Analytics', icon: BarChart3,     key: 'analytics' as const },
  { href: '/dashboard/settings',  label: 'Settings',  icon: Settings,      key: 'settings' as const },
]

export default function DashboardSidebar({
  leadCount,
  inboxCount,
  inboxUnread,
  tourCount,
  ownerName,
  ownerSubtitle,
  ownerInitials,
}: DashboardSidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { venue } = useDashboard()

  const handleLogout = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  const brandInitial = (venue?.name ?? 'V').slice(0, 1).toUpperCase()
  const displayOwner = ownerName ?? venue?.name ?? 'Account'
  const displaySubtitle = ownerSubtitle ?? venue?.name ?? ''
  const initials =
    ownerInitials ??
    (ownerName
      ? ownerName
          .split(/\s+/)
          .slice(0, 2)
          .map((s) => s.charAt(0).toUpperCase())
          .join('')
      : brandInitial)

  const countFor = (key: 'leads' | 'inbox' | 'tours'): number | null => {
    if (key === 'leads') return leadCount ?? null
    if (key === 'inbox') return inboxCount ?? null
    if (key === 'tours') return tourCount ?? null
    return null
  }

  return (
    <aside className="hidden lg:flex fixed inset-y-0 left-0 z-40 w-[260px] bg-[#14141A] border-r border-[#20202A] text-[#C9D0DC] flex-col">
      {/* Brand block */}
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-[#20202A]">
        <div className="w-7 h-7 rounded-lg bg-white text-[#14141A] flex items-center justify-center font-bold text-[13px] tracking-[-0.04em]">
          {brandInitial}
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-white leading-none tracking-[-0.018em] truncate">
            {venue?.name ?? 'Workspace'}
          </div>
          <div className="text-[9px] uppercase tracking-[0.18em] text-[#7A8094] font-semibold mt-1">
            VenueRise
          </div>
        </div>
      </div>

      {/* Nav group */}
      <div className="pt-4 px-3">
        <div className="px-2.5 pb-2 text-[10px] uppercase tracking-[0.18em] text-[#7A8094] font-semibold">
          Workspace
        </div>
        <nav className="space-y-0.5">
          {navItems.map(({ href, label, icon: Icon, key }) => {
            const isActive =
              href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href)
            const count = countFor(key as 'leads' | 'inbox' | 'tours')
            const showDot = key === 'inbox' && inboxUnread
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'group flex items-center gap-3 px-2.5 py-[9px] rounded-[10px] text-[13.5px] transition-colors relative',
                  isActive
                    ? 'bg-white/[0.06] text-white font-medium'
                    : 'text-[#C9D0DC] hover:text-white hover:bg-white/[0.04] font-normal'
                )}
              >
                <Icon className={cn('w-4 h-4 shrink-0', isActive ? 'text-white' : 'text-[#7A8094] group-hover:text-white transition-colors')} />
                <span className="flex-1">{label}</span>
                {count != null && count > 0 && (
                  <span className="text-[11px] px-[7px] py-px rounded-md bg-white/[0.07] text-[#C9D0DC] tabular-nums">
                    {count}
                  </span>
                )}
                {showDot && (
                  <span className="absolute right-2 top-[10px] w-1.5 h-1.5 rounded-full bg-[#2563EB]" />
                )}
              </Link>
            )
          })}
        </nav>
      </div>

      <div className="flex-1" />

      {/* Owner / venue card */}
      <div className="m-3 p-[14px] rounded-[14px] bg-white/[0.04] border border-white/[0.06]">
        <div className="flex items-center gap-2.5 mb-2.5">
          <div className="w-8 h-8 rounded-[10px] bg-white/[0.08] text-white flex items-center justify-center font-semibold text-[11px] tracking-[0.02em]">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] text-white font-medium truncate">{displayOwner}</div>
            {displaySubtitle ? (
              <div className="text-[11px] text-[#7A8094] truncate">{displaySubtitle}</div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-[#7A8094]">
          <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500">
            <span className="absolute inset-[-3px] rounded-full bg-emerald-500/30 animate-ping" />
          </span>
          <span>AI active · 24/7 coverage</span>
        </div>
        <button
          onClick={handleLogout}
          className="mt-3 w-full flex items-center justify-center gap-2 text-[11px] text-[#7A8094] hover:text-white hover:bg-white/[0.04] rounded-lg py-1.5 transition-colors"
        >
          <LogOut className="w-3 h-3" />
          Sign out
        </button>
      </div>
    </aside>
  )
}
