import { redirect } from 'next/navigation'
import { Inter } from 'next/font/google'
import { createClient } from '@/lib/supabase/server'
import { DashboardProvider } from '@/lib/contexts/dashboard-context'
import DashboardTopNav from '@/components/dashboard/DashboardTopNav'

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

  return (
    <div className={`${inter.variable} font-sans`}>
      <DashboardProvider initialVenue={venue}>
        <div className="min-h-screen w-full bg-[#F8FAFC] text-slate-950">
          <DashboardTopNav />
          <main className="min-h-[calc(100vh-72px)] w-full overflow-x-hidden">
            {children}
          </main>
        </div>
      </DashboardProvider>
    </div>
  )
}
