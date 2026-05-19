import { redirect } from 'next/navigation'
import { Inter } from 'next/font/google'
import { createClient } from '@/lib/supabase/server'
import { DashboardProvider } from '@/lib/contexts/dashboard-context'
import DashboardSidebar from '@/components/dashboard/DashboardSidebar'
import DashboardTopBar from '@/components/dashboard/DashboardTopBar'
import BillingBanner from '@/components/dashboard/billing/BillingBanner'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

/**
 * Phase 8AG — dashboard shell redesign.
 *
 * Two-column grid: fixed dark sidebar (260px on lg+) + main column
 * with sticky white topbar + light slate page background. All
 * existing data fetches, role gates, and the BillingBanner above the
 * main content remain wired exactly as before — the change is
 * cosmetic (sidebar replaces top-nav; cleaner card surface) and the
 * billing-banner placement just moves below the topbar so it lives
 * inside the content column rather than spanning the whole page.
 *
 * Sidebar counts (leads / inbox / tours) are computed via narrow
 * count-only queries here so the sidebar doesn't have to re-fetch
 * on every page render. Counts fail gracefully — a missing venue or
 * RLS denial collapses to no badge rather than a render error.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: venueRaw } = await supabase
    .from('venues')
    .select('*')
    .eq('owner_user_id', user.id)
    .order('created_at')
    .limit(1)
    .maybeSingle()

  const venue = (venueRaw as Parameters<typeof DashboardProvider>[0]['initialVenue']) ?? null
  // Phase 7D — pull venue id for the billing banner. Falls back to null
  // when the user has no owned venue (e.g. invited member viewing a shared
  // venue) — banner is a no-op in that case.
  const venueId = (venue as { id?: string } | null)?.id ?? null

  // Phase 8AG — sidebar nav counts. Narrow count-only reads so the
  // sidebar stays snappy and missing venues / RLS denials don't
  // surface a render error. Each Promise resolves to `null` on miss
  // and the sidebar simply omits the badge.
  type SidebarCounts = {
    leads: number | null
    inbox: number | null
    inboxUnread: boolean
    tours: number | null
  }
  const counts: SidebarCounts = await (async (): Promise<SidebarCounts> => {
    if (!venueId) return { leads: null, inbox: null, inboxUnread: false, tours: null }
    const [leadsRes, conversationsRes, toursRes] = await Promise.allSettled([
      supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId),
      supabase
        .from('conversations')
        .select('id, status', { count: 'exact', head: false })
        .eq('venue_id', venueId)
        .limit(50),
      supabase
        .from('tours')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .in('status', ['scheduled', 'confirmed']),
    ])
    const leads =
      leadsRes.status === 'fulfilled' && typeof leadsRes.value.count === 'number'
        ? leadsRes.value.count
        : null
    const inboxRows =
      conversationsRes.status === 'fulfilled' && Array.isArray(conversationsRes.value.data)
        ? (conversationsRes.value.data as Array<{ status?: string | null }>)
        : []
    const inbox =
      conversationsRes.status === 'fulfilled' && typeof conversationsRes.value.count === 'number'
        ? conversationsRes.value.count
        : inboxRows.length || null
    const inboxUnread = inboxRows.some(
      (c) => (c.status ?? '').toLowerCase() === 'open' || (c.status ?? '').toLowerCase() === 'unread'
    )
    const tours =
      toursRes.status === 'fulfilled' && typeof toursRes.value.count === 'number'
        ? toursRes.value.count
        : null
    return { leads, inbox, inboxUnread, tours }
  })()

  const ownerName =
    (user.user_metadata?.full_name as string | undefined) ?? user.email ?? 'Account'
  const ownerSubtitle =
    (user.user_metadata?.location as string | undefined) ??
    (venue?.name ? venue.name : null)

  return (
    <div className={`${inter.variable} font-sans`}>
      <DashboardProvider initialVenue={venue}>
        <div className="min-h-screen w-full bg-[#F4F7FB] text-slate-950">
          <DashboardSidebar
            leadCount={counts.leads}
            inboxCount={counts.inbox}
            inboxUnread={counts.inboxUnread}
            tourCount={counts.tours}
            ownerName={ownerName}
            ownerSubtitle={ownerSubtitle}
          />
          <div className="lg:ml-[260px] min-w-0 flex flex-col min-h-screen">
            <DashboardTopBar />
            {/* Banner is fail-open: if the subscription read throws, it renders
                nothing and the dashboard keeps working. See BillingBanner. */}
            <BillingBanner venueId={venueId} />
            <main className="flex-1 w-full overflow-x-hidden">
              {children}
            </main>
          </div>
        </div>
      </DashboardProvider>
    </div>
  )
}
