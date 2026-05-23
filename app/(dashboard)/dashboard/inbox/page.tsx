import { createClient } from '@/lib/supabase/server'
import ConversationList from '@/components/dashboard/ConversationList'
import RealtimeMessagesLayer from '@/components/dashboard/inbox/RealtimeMessagesLayer'
import WeekTourPanel, {
  type WeekTour,
} from '@/components/dashboard/inbox/WeekTourPanel'
import { MessageSquare } from 'lucide-react'
// Phase 8BE-2 — omnichannel inbox loader join. Pulls per-conversation
// channel metadata (from external_conversations or messages.metadata
// fallback) so ConversationList rows can light up the source badge
// for normalized conversations.
import { loadInboxChannelMap } from '@/lib/integrations/channels/inbox-channels'

/**
 * Phase 8J — week boundary helper. We always anchor to the local start
 * of the current week (Sunday 00:00) and the local end of Saturday so
 * the panel matches what a human reading "this week" expects, regardless
 * of when in the week the inbox is opened.
 */
function currentWeekWindow(now: Date): { from: Date; to: Date } {
  const dayOfWeek = now.getDay() // 0 = Sun
  const start = new Date(now)
  start.setDate(now.getDate() - dayOfWeek)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  end.setHours(23, 59, 59, 999)
  return { from: start, to: end }
}

export default async function InboxPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: venueRaw } = await supabase
    .from('venues').select('id').eq('owner_user_id', user!.id)
    .order('created_at').limit(1).maybeSingle()
  const venueId = (venueRaw as { id?: string } | null)?.id ?? null

  const conversationsRaw = venueId
    ? (await supabase
        .from('conversations')
        .select('*, leads(id, name, email, lead_score)')
        .eq('venue_id', venueId)
        .order('last_message_at', { ascending: false })
      ).data ?? []
    : []

  // Phase 8BE-2 — join the per-conversation channel posture so
  // ConversationList can light up the source badge. Legacy
  // conversations with no channel context fall through to null
  // and the badge hides gracefully.
  const channelMap = await loadInboxChannelMap(
    venueId,
    (conversationsRaw as Array<{ id: string }>).map((c) => c.id)
  )
  const conversations = (conversationsRaw as Array<Record<string, unknown> & { id: string }>).map(
    (c) => {
      const meta = channelMap.get(c.id)
      return {
        ...c,
        channel_type: meta?.channelType ?? null,
        manual_reply_required: meta?.manualReplyRequired ?? false,
        // Phase 8BG — surface the latest-message parse-review
        // flag so ConversationList can render the warning dot.
        parse_needs_review: meta?.parseNeedsReview ?? false,
      }
    }
  ) as unknown as typeof conversationsRaw

  // Phase 8J — "This week's tours" panel data. Server-side fetch, narrow
  // SELECT, no fan-out: we deliberately keep this to the index page only
  // (the [leadId] thread page does NOT render the panel — operators in a
  // conversation don't need another nav surface competing for attention).
  // We include the lead relation for name + guest_count + email so the
  // panel doesn't need a second query.
  const week = currentWeekWindow(new Date())
  const weekToursRaw = venueId
    ? (await supabase
        .from('tours')
        .select(
          'id, lead_id, scheduled_at, duration_minutes, status, leads(name, email, guest_count)'
        )
        .eq('venue_id', venueId)
        .in('status', ['scheduled', 'confirmed'])
        .gte('scheduled_at', week.from.toISOString())
        .lte('scheduled_at', week.to.toISOString())
        .order('scheduled_at', { ascending: true })
      ).data ?? []
    : []
  type RawRow = {
    id: string
    lead_id: string
    scheduled_at: string
    duration_minutes: number | null
    status: string
    leads: { name?: string | null; email?: string | null; guest_count?: number | null } | null
  }
  const weekTours: WeekTour[] = (weekToursRaw as RawRow[])
    // Defense in depth — status guard re-applied so an orphaned row with
    // an unexpected status string can't sneak into the panel.
    .filter((t): t is RawRow & { status: 'scheduled' | 'confirmed' } =>
      t.status === 'scheduled' || t.status === 'confirmed'
    )
    .map((t) => ({
      id: t.id,
      lead_id: t.lead_id,
      lead_name: t.leads?.name ?? 'Unknown',
      lead_email: t.leads?.email ?? null,
      status: t.status,
      scheduled_at: t.scheduled_at,
      duration_minutes: t.duration_minutes,
      guest_count: t.leads?.guest_count ?? null,
    }))

  return (
    // Phase 8AK — left-rail orientation flip. ConversationList sits on
    // the left (matches operator expectations from /dashboard/inbox/[id]);
    // the empty-state panel + week tour panel occupy the remaining
    // space. On smaller screens the list takes the full viewport — the
    // empty-state panel hides until the operator picks a conversation.
    //
    // Phase 8BL-Hotfix-2 — inbox scroll container fix.
    //   - `100dvh` (was `100vh`) handles mobile/iOS browser chrome
    //     correctly — `vh` includes the URL bar height that gets
    //     hidden on scroll, which left a stale gap.
    //   - `min-h-0` lets flex children shrink below their
    //     content-derived size so the internal scroll regions
    //     (conversation list + thread + composer) work correctly.
    //   - `overflow-hidden` is the safety net: even when a banner
    //     (BillingBanner, DemoModeBanner) pushes us down a few
    //     pixels, the inbox can't leak into body-scroll territory.
    //   - Removed `min-h-[640px]` — it forced the inbox taller than
    //     the viewport on small laptops, which manifested as the
    //     "huge blank whitespace below messages" bug.
    <div className="flex h-[calc(100dvh-60px)] min-h-0 overflow-hidden animate-fade-in bg-[#F4F7FB]">
      <ConversationList
        conversations={conversations as Parameters<typeof ConversationList>[0]['conversations']}
      />
      <div className="hidden lg:flex flex-1 min-h-0 flex-col items-center justify-center px-6 gap-6 py-6 overflow-y-auto">
        {/* Phase 8J — week-at-a-glance panel. Renders ABOVE the empty
            state so the operator's eye lands on actionable tours first
            and the "select a conversation" prompt fills the remaining
            vertical space underneath. */}
        <WeekTourPanel tours={weekTours} />

        {/* Phase 8AI — empty-state card uses the new white surface +
            soft border to match the rest of the dashboard. */}
        <div className="bg-white border border-[#E6E8EF] rounded-2xl shadow-card max-w-md w-full px-6 py-7 text-center">
          <div className="w-12 h-12 rounded-2xl bg-[#F1F5F9] flex items-center justify-center mx-auto mb-3.5">
            <MessageSquare className="w-5 h-5 text-[#0F172A]" />
          </div>
          <h3 className="text-[15px] font-semibold text-[#0F172A] mb-1.5">
            Select a conversation
          </h3>
          <p className="text-[12.5px] text-[#475569] leading-relaxed">
            Click a lead from the right panel to view their messages and reply
            with AI or manually.
          </p>
        </div>
      </div>

      {/* Phase 8B — non-rendering client component. Subscribes to
          `public.conversations` postgres_changes filtered by venue_id and
          refreshes the page when a new conversation appears OR an
          existing conversation's last_message_at shifts. ConversationThread
          already handles per-thread realtime for the active inbox view. */}
      {venueId && <RealtimeMessagesLayer venueId={venueId} />}
    </div>
  )
}
