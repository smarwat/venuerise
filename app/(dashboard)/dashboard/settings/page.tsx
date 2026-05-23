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

  // Phase 8BC — hydrate blackout dates server-side so the
  // Availability tab paints with the venue's existing blocked
  // days. RLS scopes the read to sales-role members; ordering
  // matches what the UI renders (earliest first).
  const tourBlackouts = venue
    ? (await supabase
        .from('tour_blackouts')
        .select('id, venue_id, blackout_date, reason, created_at')
        .eq('venue_id', venue.id as string)
        .order('blackout_date', { ascending: true })).data ?? []
    : []

  return (
    <div className="p-6 lg:p-8 animate-slide-up">
      {/* GTM-0H — Workspace Settings reframe. Header repositions the
          page as a control center, not a forms dump. Explanation card
          immediately below the header teaches the buyer that every
          tab below maps to a real revenue surface (AI behavior,
          knowledge accuracy, tour availability, team access). */}
      <PageHeader
        title="Workspace settings"
        subtitle="Configure the venue details, AI behavior, team access, and revenue workflows that power VenueRise."
      />
      <section className="mb-5 rounded-2xl border border-[#E6E8EF] bg-white shadow-card overflow-hidden">
        <div className="relative px-5 py-4 lg:px-6 lg:py-4 bg-gradient-to-br from-white via-white to-[#FAF7F0]">
          <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-[#C5A572] via-[#92763C] to-[#C5A572]" />
          <div className="flex items-start gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="text-[10.5px] uppercase tracking-[0.16em] text-[#92763C] font-semibold mb-1">
                Control center
              </div>
              <p className="text-[13px] text-[#0F172A] leading-relaxed max-w-3xl">
                These settings control how your AI replies, which tour times it can safely offer, what venue facts it knows, and who can manage the revenue pipeline.
              </p>
            </div>
          </div>
        </div>
      </section>
      <SettingsTabs
        venue={venue}
        knowledgeBase={knowledgeBase as Record<string, unknown>[]}
        tourAvailability={tourAvailability as Record<string, unknown>[]}
        tourBlackouts={tourBlackouts as Record<string, unknown>[]}
      />
    </div>
  )
}
