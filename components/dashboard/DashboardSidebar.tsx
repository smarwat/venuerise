'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  CalendarCheck,
  BarChart3,
  Settings,
  LogOut,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useDashboard } from '@/lib/contexts/dashboard-context'

const navItems = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/leads', label: 'Leads', icon: Users },
  { href: '/dashboard/inbox', label: 'Inbox', icon: MessageSquare },
  { href: '/dashboard/tours', label: 'Tours', icon: CalendarCheck },
  { href: '/dashboard/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
]

export default function DashboardSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { venue } = useDashboard()

  const handleLogout = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <aside className="fixed inset-y-0 left-0 z-40 w-[240px] bg-[#0D1117] border-r border-[#1C2333] flex flex-col">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 h-[60px] border-b border-[#1C2333]">
        <div className="w-7 h-7 text-[#1A7FFF]">
          <svg viewBox="0 0 300 270" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
            <polygon points="8,26 58,26 33,72" />
            <polygon points="78,20 122,20 170,210 146,242 94,54" />
            <path d="M158,20 L204,20 Q268,20 268,96 L237,242 L208,210 L234,96 Q228,56 194,50 L158,50 Z" />
          </svg>
        </div>
        <span className="text-[#F0F6FC] font-semibold text-[15px] tracking-[-0.01em]">VenueRise</span>
        <span className="ml-auto text-[10px] font-semibold text-[#1A7FFF] bg-[#1A7FFF]/10 rounded px-1.5 py-0.5">AI</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 px-3 space-y-0.5 overflow-y-auto">
        {navItems.map(({ href, label, icon: Icon }) => {
          const isActive = href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150',
                isActive
                  ? 'bg-white/[0.08] text-[#F0F6FC]'
                  : 'text-[#8B949E] hover:text-[#F0F6FC] hover:bg-white/[0.05]'
              )}
            >
              <Icon className={cn('w-4 h-4 shrink-0', isActive ? 'text-[#1A7FFF]' : '')} />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Bottom: venue pill + logout */}
      <div className="p-3 border-t border-[#1C2333] space-y-2">
        {venue && (
          <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-white/[0.03]">
            <div className="w-7 h-7 rounded-lg bg-[#1A7FFF]/20 flex items-center justify-center shrink-0">
              <Zap className="w-3.5 h-3.5 text-[#1A7FFF]" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-[#F0F6FC] truncate">{venue.name}</p>
              <p className="text-[11px] text-[#8B949E]">AI Active</p>
            </div>
            <div className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          </div>
        )}
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm text-[#8B949E] hover:text-[#F0F6FC] hover:bg-white/[0.05] transition-all duration-150"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          Sign out
        </button>
      </div>
    </aside>
  )
}
