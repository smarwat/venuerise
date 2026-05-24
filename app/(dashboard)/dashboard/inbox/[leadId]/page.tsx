import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import ConversationList from '@/components/dashboard/ConversationList'
import ConversationThread from '@/components/dashboard/ConversationThread'
import MessageComposer from '@/components/dashboard/MessageComposer'
import TourLifecycleStrip from '@/components/dashboard/inbox/TourLifecycleStrip'
import { Badge } from '@/components/dashboard/ui/Badge'
import { MoreHorizontal, Star, Share2 } from 'lucide-react'
// Phase 8BE-2 — per-conversation channel metadata join. Same
// helper as the inbox index page; populates `conv.channel_type`
// so the sidebar badge lights up here too.
import { loadInboxChannelMap } from '@/lib/integrations/channels/inbox-channels'
// Phase 8BM — pure resolver that maps (channel, contact info)
// into the operator-facing "where will my reply go?" description.
import { resolveReplyMethod } from '@/lib/integrations/channels/reply-method'
// Phase 8BN — server-side check for whether outbound email
// delivery is wired (kill switch + Resend config). Result is
// passed into resolveReplyMethod so the bar flips to "Direct"
// when sending is actually available.
import { isOutboundEmailConfigured } from '@/lib/integrations/delivery/email'
// Phase 8BR — parallel SMS-side check (Twilio + OUTBOUND_SMS_*
// env vars). Same plumbing as email: flag flows through the
// resolver, so phone-bearing leads flip to delivery_mode='direct'
// when SMS is wired AND the lead has a normalizable phone.
import { isOutboundSmsConfigured } from '@/lib/integrations/delivery/sms'

/**
 * Phase 8F — pick the most relevant tour for a lead.
 *
 * Priority: an upcoming `scheduled` or `confirmed` tour wins over any
 * past row. If there's no upcoming, return the most recent past tour
 * (any status) so the strip can show "last tour completed/cancelled".
 * Falls back to null when the lead has never had a tour.
 */
function pickRelevantTour(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return null
  const now = Date.now()
  const upcomingOpen = rows.find((t) => {
    const status = t.status as string
    if (!['scheduled', 'confirmed'].includes(status)) return false
    return new Date(t.scheduled_at as string).getTime() > now
  })
  if (upcomingOpen) return upcomingOpen
  // Rows arrive ordered by scheduled_at desc, so the first one is the
  // latest past tour regardless of status.
  return rows[0]
}

function scoreBadge(score: number) {
  if (score >= 80) return 'score_high' as const
  if (score >= 60) return 'score_mid' as const
  if (score >= 40) return 'score_low' as const
  return 'score_poor' as const
}

export default async function InboxThreadPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: venueRaw } = await supabase
    .from('venues').select('id').eq('owner_user_id', user!.id)
    .order('created_at').limit(1).maybeSingle()
  const venueId = (venueRaw as { id?: string } | null)?.id ?? null

  const [conversationsRes, leadRes] = await Promise.all([
    venueId
      ? supabase
          .from('conversations')
          .select('*, leads(id, name, email, lead_score)')
          .eq('venue_id', venueId)
          .order('last_message_at', { ascending: false })
      : Promise.resolve({ data: [] }),
    supabase.from('leads').select('*').eq('id', leadId).maybeSingle(),
  ])

  const conversationsRawList = conversationsRes.data ?? []
  // Phase 8BE-2 — join channel posture across all sidebar rows so
  // the badge renders on every conversation, not just the active
  // one. Empty input is a no-op.
  const channelMap = await loadInboxChannelMap(
    venueId,
    (conversationsRawList as Array<{ id: string }>).map((c) => c.id)
  )
  const conversations = (conversationsRawList as Array<Record<string, unknown> & { id: string }>).map(
    (c) => {
      const meta = channelMap.get(c.id)
      return {
        ...c,
        channel_type: meta?.channelType ?? null,
        manual_reply_required: meta?.manualReplyRequired ?? false,
        // Phase 8BG — parse-review warning dot signal.
        parse_needs_review: meta?.parseNeedsReview ?? false,
      }
    }
  ) as unknown as typeof conversationsRawList
  const lead = leadRes.data as Record<string, unknown> | null
  if (!lead) notFound()

  // Phase 8F — fetch the most relevant tour for this lead. We pull up to
  // 10 rows ordered desc so `pickRelevantTour` can prefer an upcoming
  // scheduled/confirmed one without needing two round-trips.
  const tourRows = venueId
    ? (await supabase
        .from('tours')
        .select('id, lead_id, scheduled_at, duration_minutes, location_notes, status')
        .eq('venue_id', venueId)
        .eq('lead_id', leadId)
        .order('scheduled_at', { ascending: false })
        .limit(10)
      ).data ?? []
    : []
  const relevantTour = pickRelevantTour(tourRows as Array<Record<string, unknown>>)

  const conv = conversations.find((c) => {
    const cl = c as Record<string, unknown>
    const leads = cl.leads as { id?: string } | null
    return leads?.id === leadId
  }) as Record<string, unknown> | undefined

  const messages = conv
    ? (await supabase.from('messages').select('*').eq('conversation_id', conv.id as string).order('created_at')).data ?? []
    : []

  return (
    // Phase 8AK — left-rail orientation. ConversationList sits on the
    // left, thread occupies center/right on lg+. On smaller screens the
    // list collapses (single-column) so the active thread owns the
    // viewport — operators on phones land directly in the conversation
    // they tapped from /dashboard/inbox.
    //
    // Phase 8BL-Hotfix-3 — inbox uses parent height. The dashboard
    // shell owns the viewport; this page just claims `h-full`. The
    // inner column gets `min-h-0 overflow-hidden flex flex-col` so
    // ConversationThread's internal scroll can engage. Lead header
    // and TourLifecycleStrip stay `shrink-0`.
    <div className="flex h-full min-h-0 overflow-hidden animate-fade-in bg-[#F4F7FB]">
      <div className="hidden lg:flex">
        <ConversationList
          conversations={conversations as Parameters<typeof ConversationList>[0]['conversations']}
          activeLeadId={leadId}
        />
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-white">
        <div className="shrink-0 flex items-center gap-3 px-6 py-4 border-b border-[#E6E8EF]">
          <div className="relative shrink-0">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#1E293B] to-[#0F172A] flex items-center justify-center text-white text-[13px] font-bold">
              {(lead.name as string).charAt(0)}
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#059669] border-2 border-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[14px] font-semibold text-[#0F172A]">{lead.name as string}</h2>
            <p className="text-[11px] text-[#64748B]">
              {lead.email as string}
              {lead.event_date ? ` • Event: ${new Date(lead.event_date as string).toLocaleDateString()}` : ''}
              {lead.guest_count ? ` • ${lead.guest_count} guests` : ''}
            </p>
          </div>

          <div className="flex items-center gap-1.5">
            <Badge variant={scoreBadge(lead.lead_score as number)}>Score {lead.lead_score as number}</Badge>
            {!!lead.ai_active && <Badge variant="navy">🤖 AI</Badge>}
            <button className="w-8 h-8 rounded-full flex items-center justify-center text-[#94A3B8] hover:text-[#1D4ED8] hover:bg-[#F1F5F9] transition-colors ml-1">
              <Share2 className="w-4 h-4" />
            </button>
            <button className="w-8 h-8 rounded-full flex items-center justify-center text-[#94A3B8] hover:text-[#1D4ED8] hover:bg-[#F1F5F9] transition-colors">
              <Star className="w-4 h-4" />
            </button>
            <button className="w-8 h-8 rounded-full flex items-center justify-center text-[#94A3B8] hover:text-[#1D4ED8] hover:bg-[#F1F5F9] transition-colors">
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Phase 8F — tour lifecycle strip. Renders above the conversation
            so the operator sees tour status at a glance + a one-click
            schedule/edit button. */}
        <TourLifecycleStrip
          lead={{
            id: leadId,
            name: lead.name as string,
            email: (lead.email as string | null) ?? null,
            stage: (lead.stage as string | null) ?? null,
          }}
          tour={
            relevantTour
              ? {
                  id: relevantTour.id as string,
                  lead_id: relevantTour.lead_id as string,
                  scheduled_at: relevantTour.scheduled_at as string,
                  duration_minutes: (relevantTour.duration_minutes as number | null) ?? null,
                  location_notes: (relevantTour.location_notes as string | null) ?? null,
                  status: (relevantTour.status as string | null) ?? null,
                }
              : null
          }
        />

        {conv ? (
          <>
            <ConversationThread
              conversationId={conv.id as string}
              initialMessages={messages as Parameters<typeof ConversationThread>[0]['initialMessages']}
              leadName={lead.name as string}
            />
            {(() => {
              // Phase 8BM — resolve the reply method server-side and
              // pass it to the composer. Honors the channel
              // capability matrix + the lead's email/phone.
              //
              // Phase 8BN — pass the live `emailDirectDeliveryEnabled`
              // flag so the resolver flips email-bearing leads to
              // `deliveryMode: 'direct'` when the venue has Resend +
              // OUTBOUND_EMAIL_DELIVERY_ENABLED wired. When the flag
              // is off the resolver falls back to `internal_only`
              // ("Saved in VenueRise only") — the previous honest
              // default.
              const emailDirectDeliveryEnabled = isOutboundEmailConfigured()
              const smsDirectDeliveryEnabled = isOutboundSmsConfigured()
              const replyMethod = resolveReplyMethod({
                channelType: (conv as { channel_type?: string | null }).channel_type ?? null,
                leadEmail: (lead.email as string | null) ?? null,
                leadPhone: (lead.phone as string | null) ?? null,
                emailDirectDeliveryEnabled,
                smsDirectDeliveryEnabled,
              })
              return (
                <MessageComposer
                  conversationId={conv.id as string}
                  leadId={leadId}
                  aiActive={lead.ai_active as boolean}
                  replyMethod={replyMethod}
                />
              )
            })()}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[13px] text-[#64748B]">
            No conversation started yet. AI will initiate once the lead is qualified.
          </div>
        )}
      </div>
    </div>
  )
}
