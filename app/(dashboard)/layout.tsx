import { redirect } from 'next/navigation'
import { Inter } from 'next/font/google'
import { createClient } from '@/lib/supabase/server'
import { DashboardProvider } from '@/lib/contexts/dashboard-context'
import DashboardTopNav from '@/components/dashboard/DashboardTopNav'
import BillingBanner from '@/components/dashboard/billing/BillingBanner'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

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

  return (
    <div className={`${inter.variable} font-sans`}>
      <DashboardProvider initialVenue={venue}>
        <div className="min-h-screen w-full bg-[#F8FAFC] text-slate-950">
          <DashboardTopNav />
          {/* Banner is fail-open: if the subscription read throws, it renders
              nothing and the dashboard keeps working. See BillingBanner. */}
          <BillingBanner venueId={venueId} />
          <main className="min-h-[calc(100vh-72px)] w-full overflow-x-hidden">
            {children}
          </main>
        </div>
      </DashboardProvider>
    </div>
  )
}
