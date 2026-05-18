import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import PageHeader from '@/components/dashboard/PageHeader'
import SettingsTabs from '@/components/dashboard/SettingsTabs'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: venueRaw } = await supabase
    .from('venues').select('*').eq('owner_user_id', user.id)
    .order('created_at').limit(1).maybeSingle()
  const venue = venueRaw as Record<string, unknown> | null

  const knowledgeBase = venue
    ? (await supabase.from('knowledge_base').select('*').eq('venue_id', venue.id as string).order('priority', { ascending: false })).data ?? []
    : []

  const tourAvailability = venue
    ? (await supabase.from('tour_availability').select('*').eq('venue_id', venue.id as string).order('day_of_week').order('start_time')).data ?? []
    : []

  return (
    <div className="p-6 lg:p-8 animate-slide-up">
      <PageHeader
        title="Settings"
        subtitle="Configure your venue profile, AI behavior, and team"
      />
      <SettingsTabs
        venue={venue}
        knowledgeBase={knowledgeBase as Record<string, unknown>[]}
        tourAvailability={tourAvailability as Record<string, unknown>[]}
      />
    </div>
  )
}
