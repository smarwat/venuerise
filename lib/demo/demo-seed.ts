import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * Phase 8A — demo seed + reset for a single venue.
 *
 * GOAL
 *   Make every dashboard page non-empty for a founder-led demo:
 *     /dashboard           → KPI cards + recent leads
 *     /dashboard/leads     → kanban with stages populated
 *     /dashboard/inbox     → conversations w/ message history
 *     /dashboard/tours     → scheduled + completed tours this month
 *     /dashboard/analytics → leads-over-time + funnel
 *
 * IDENTITY
 *   Every demo row is tagged so reset can clean only its own rows:
 *     - leads.email        → 'demo+leadN@venuerise.test'
 *     - ai_actions.agent   → 'demo-seed'
 *   Cascades from `leads` handle conversations, messages, tours, and
 *   follow_up_schedules (all are ON DELETE CASCADE on `lead_id` per
 *   migration 001). `ai_actions.lead_id` is ON DELETE SET NULL, so we
 *   delete those by the agent tag in a separate statement.
 *
 * IDEMPOTENCY
 *   `seedDemoVenue` runs `resetDemoVenue` first, so re-running is safe
 *   and produces the same counts. Real (non-demo) data is never touched.
 *
 * SERVICE-ROLE USAGE
 *   We bypass RLS to write across leads + conversations + messages +
 *   tours + follow_up_schedules + ai_actions in one call. The route layer
 *   gates this with `requireAdmin()` + ADMIN_ROLES so only owner/admin
 *   can trigger.
 *
 * `server-only` so the service-role import can't leak.
 */

// ---------------------------------------------------------------------------
// Demo identity
// ---------------------------------------------------------------------------

const DEMO_EMAIL_LIKE = 'demo+%@venuerise.test'
const DEMO_AI_AGENT = 'demo-seed'

function demoEmail(slug: string): string {
  return `demo+${slug}@venuerise.test`
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SeedDemoVenueArgs {
  venueId: string
  ownerUserId: string
  requestId?: string
}

export interface DemoCounts {
  leadsCreated: number
  conversationsCreated: number
  messagesCreated: number
  toursCreated: number
  followUpsCreated: number
  aiActionsCreated?: number
}

export interface ResetDemoVenueResult {
  leadsDeleted: number
  aiActionsDeleted: number
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

type Stage =
  | 'new_inquiry'
  | 'qualified'
  | 'tour_scheduled'
  | 'tour_completed'
  | 'negotiation'
  | 'booked'
  | 'lost'

type Urgency = 'low' | 'medium' | 'high' | 'critical'

interface LeadFixture {
  slug: string // → 'demo+<slug>@venuerise.test'
  name: string
  stage: Stage
  lead_score: number
  urgency: Urgency
  guest_count: number
  budget: number
  notes: string
  /** Days from now; positive = future event. */
  eventDateDays: number
  /** Days ago this lead was created (for realistic chart spread). */
  createdAgoDays: number
}

const LEADS: readonly LeadFixture[] = [
  {
    slug: 'lead1',
    name: 'Sarah & Michael Johnson',
    stage: 'new_inquiry',
    lead_score: 72,
    urgency: 'high',
    guest_count: 180,
    budget: 28000,
    notes: 'Garden ceremony + reception. Saturday in October. Asking about catering partners.',
    eventDateDays: 240,
    createdAgoDays: 0,
  },
  {
    slug: 'lead2',
    name: 'Priya Sharma',
    stage: 'new_inquiry',
    lead_score: 58,
    urgency: 'medium',
    guest_count: 220,
    budget: 35000,
    notes: 'Multi-day Indian wedding. Needs vendor flexibility for Mehndi + Sangeet.',
    eventDateDays: 310,
    createdAgoDays: 1,
  },
  {
    slug: 'lead3',
    name: 'Emily Chen & Daniel Park',
    stage: 'qualified',
    lead_score: 81,
    urgency: 'high',
    guest_count: 140,
    budget: 32000,
    notes: 'Wants late September; loved the gallery on the website.',
    eventDateDays: 180,
    createdAgoDays: 2,
  },
  {
    slug: 'lead4',
    name: 'Hannah & Marcus Webb',
    stage: 'tour_scheduled',
    lead_score: 88,
    urgency: 'high',
    guest_count: 165,
    budget: 30000,
    notes: 'Booked tour for next week. Considering us + one other venue.',
    eventDateDays: 200,
    createdAgoDays: 4,
  },
  {
    slug: 'lead5',
    name: 'Isabella Romano',
    stage: 'tour_scheduled',
    lead_score: 74,
    urgency: 'medium',
    guest_count: 110,
    budget: 22000,
    notes: 'Smaller intimate ceremony. Italian-American family, vendor preferences noted.',
    eventDateDays: 365,
    createdAgoDays: 6,
  },
  {
    slug: 'lead6',
    name: 'Olivia & James Bennett',
    stage: 'tour_completed',
    lead_score: 91,
    urgency: 'critical',
    guest_count: 200,
    budget: 38000,
    notes: 'Loved the venue at the tour. Waiting on final quote.',
    eventDateDays: 150,
    createdAgoDays: 11,
  },
  {
    slug: 'lead7',
    name: 'Aisha & Devon Williams',
    stage: 'tour_completed',
    lead_score: 79,
    urgency: 'high',
    guest_count: 175,
    budget: 27000,
    notes: 'Tour went well. Need to confirm with parents on date.',
    eventDateDays: 270,
    createdAgoDays: 14,
  },
  {
    slug: 'lead8',
    name: 'Chloe & Ryan Pierce',
    stage: 'negotiation',
    lead_score: 86,
    urgency: 'critical',
    guest_count: 160,
    budget: 33000,
    notes: 'Negotiating deposit + bar package. 90% likely to book.',
    eventDateDays: 190,
    createdAgoDays: 18,
  },
  {
    slug: 'lead9',
    name: 'Sophie & Liam Foster',
    stage: 'booked',
    lead_score: 95,
    urgency: 'medium',
    guest_count: 145,
    budget: 31000,
    notes: 'Booked! Deposit cleared last week. Send final contract by Friday.',
    eventDateDays: 220,
    createdAgoDays: 24,
  },
  {
    slug: 'lead10',
    name: 'Madison Hayes',
    stage: 'lost',
    lead_score: 42,
    urgency: 'low',
    guest_count: 90,
    budget: 16000,
    notes: 'Went with a smaller venue closer to her family. Stay in touch for future events.',
    eventDateDays: 95,
    createdAgoDays: 28,
  },
]

interface MessageFixture {
  role: 'lead' | 'ai' | 'human' | 'system'
  content: string
  agoMinutes: number // Older messages have larger numbers; conversation rendered ascending.
}

interface ConversationFixture {
  leadSlug: string
  sentiment: 'positive' | 'neutral' | 'negative' | 'urgent'
  unreadCount: number
  messages: readonly MessageFixture[]
}

const CONVERSATIONS: readonly ConversationFixture[] = [
  {
    leadSlug: 'lead3',
    sentiment: 'positive',
    unreadCount: 0,
    messages: [
      { role: 'lead', content: 'Hi! We loved the photos on your site — is September 21st available?', agoMinutes: 360 },
      { role: 'ai', content: 'Hi Emily! Thanks for reaching out. September 21st is currently available. Would you like to book a tour next week to see the space in person?', agoMinutes: 358 },
      { role: 'lead', content: 'Yes please! Saturday morning would be ideal.', agoMinutes: 330 },
      { role: 'ai', content: 'Got it — I have Saturday at 10am open. I’ll confirm the tour and send you parking instructions shortly.', agoMinutes: 328 },
    ],
  },
  {
    leadSlug: 'lead4',
    sentiment: 'positive',
    unreadCount: 1,
    messages: [
      { role: 'lead', content: 'We have a date in mid-May 2027 in mind. Could you share pricing for that weekend?', agoMinutes: 240 },
      { role: 'ai', content: 'Of course! Mid-May is peak season — our weekend rental starts at $30,000 for up to 175 guests. I can also send the full menu of add-ons. Want me to email those over?', agoMinutes: 235 },
      { role: 'lead', content: 'Yes that would be helpful, thanks!', agoMinutes: 30 },
    ],
  },
  {
    leadSlug: 'lead6',
    sentiment: 'positive',
    unreadCount: 0,
    messages: [
      { role: 'lead', content: 'The tour was incredible. We’re ready to move forward — what does the contract process look like?', agoMinutes: 4320 },
      { role: 'ai', content: 'So glad you enjoyed it! I’ll send a formal quote within 24 hours, then we typically sign + deposit within a week. Anything specific you want included in the quote?', agoMinutes: 4318 },
      { role: 'lead', content: 'Just full-day venue + tables/chairs + the bridal suite. We’ll bring our own bar and catering.', agoMinutes: 4290 },
      { role: 'human', content: 'Quote sent at 2:14pm. Let me know if you have any questions.', agoMinutes: 4200 },
    ],
  },
  {
    leadSlug: 'lead8',
    sentiment: 'urgent',
    unreadCount: 2,
    messages: [
      { role: 'lead', content: 'We need to lock in the date by end of week. Can you do $30k all-in with the open bar package?', agoMinutes: 1440 },
      { role: 'ai', content: 'Let me check with the team on the package adjustment. The open bar is normally a $4k add-on — I’ll see what we can do to get you to $30k flat.', agoMinutes: 1430 },
      { role: 'lead', content: 'Appreciate it. Family deciding tomorrow morning so any answer today helps.', agoMinutes: 90 },
      { role: 'lead', content: 'Following up — any update?', agoMinutes: 20 },
    ],
  },
]

interface TourFixture {
  leadSlug: string
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'
  scheduledAtDays: number // Negative = past.
  hour: number
  durationMinutes: number
  locationNotes: string
  outcome?: string
}

const TOURS: readonly TourFixture[] = [
  {
    leadSlug: 'lead4',
    status: 'scheduled',
    scheduledAtDays: 6,
    hour: 10,
    durationMinutes: 60,
    locationNotes: 'Meet at the main gate. Parking on the south lot.',
  },
  {
    leadSlug: 'lead5',
    status: 'confirmed',
    scheduledAtDays: 10,
    hour: 14,
    durationMinutes: 75,
    locationNotes: 'Smaller party — gallery + garden walk-through.',
  },
  {
    leadSlug: 'lead6',
    status: 'completed',
    scheduledAtDays: -3,
    hour: 11,
    durationMinutes: 90,
    locationNotes: 'Full tour including bridal suite + ballroom.',
    outcome: 'Excellent — proceeding to formal quote.',
  },
  {
    leadSlug: 'lead7',
    status: 'completed',
    scheduledAtDays: -8,
    hour: 15,
    durationMinutes: 60,
    locationNotes: 'Tour with both sets of parents.',
    outcome: 'Positive — pending family decision.',
  },
]

interface FollowUpFixture {
  leadSlug: string
  touchNumber: 1 | 2 | 3 | 4 | 5
  /** Negative = already sent, positive = upcoming. */
  scheduledAgoDays: number
  status: 'pending' | 'sent' | 'cancelled'
  subject: string
  body: string
}

const FOLLOWUPS: readonly FollowUpFixture[] = [
  {
    leadSlug: 'lead1',
    touchNumber: 1,
    scheduledAgoDays: -1,
    status: 'pending',
    subject: 'Following up on your wedding inquiry',
    body: 'Hi Sarah, just wanted to follow up on your inquiry about an October Saturday. Happy to share availability + a virtual tour link if helpful.',
  },
  {
    leadSlug: 'lead2',
    touchNumber: 1,
    scheduledAgoDays: -2,
    status: 'pending',
    subject: 'Quick question on your multi-day plans',
    body: 'Hi Priya, thanks for reaching out about your Indian wedding. Would love to learn more about the Mehndi + Sangeet logistics so we can put together a tailored quote.',
  },
  {
    leadSlug: 'lead3',
    touchNumber: 2,
    scheduledAgoDays: 3,
    status: 'pending',
    subject: 'Tour confirmation + parking info',
    body: 'Hi Emily, just confirming your Saturday morning tour — parking instructions are in the calendar invite. Let me know if anything changes.',
  },
  {
    leadSlug: 'lead7',
    touchNumber: 3,
    scheduledAgoDays: 1,
    status: 'pending',
    subject: 'Following up after our tour',
    body: 'Hi Aisha — thanks again for visiting us last week. Whenever you and the family are ready, I’d love to hold the date for 48 hours while you finalize.',
  },
  {
    leadSlug: 'lead4',
    touchNumber: 2,
    scheduledAgoDays: -3,
    status: 'sent',
    subject: 'Pricing details + menu options',
    body: 'Hi Hannah, attached is the full pricing sheet + bar/menu package options we discussed. Let me know if anything needs adjusting.',
  },
  {
    leadSlug: 'lead8',
    touchNumber: 1,
    scheduledAgoDays: -5,
    status: 'sent',
    subject: 'Custom quote for your spring date',
    body: 'Hi Chloe + Ryan, sending over the bundled quote we discussed. Looking forward to hearing back once you’ve had a chance to review.',
  },
  {
    leadSlug: 'lead6',
    touchNumber: 1,
    scheduledAgoDays: -1,
    status: 'sent',
    subject: 'Formal quote attached',
    body: 'Hi Olivia + James, attached is your formal quote with the items we walked through. Happy to jump on a call this week to finalize.',
  },
]

interface AiActionFixture {
  leadSlug: string
  action: string
  input_summary: string
  output_summary: string
  latency_ms: number
  tokens_used: number
}

const AI_ACTIONS: readonly AiActionFixture[] = [
  {
    leadSlug: 'lead1',
    action: 'qualify-lead',
    input_summary: '180-guest October Saturday, $28k budget',
    output_summary: 'Score 72 — high fit; recommended garden+ballroom hybrid',
    latency_ms: 1420,
    tokens_used: 920,
  },
  {
    leadSlug: 'lead3',
    action: 'qualify-lead',
    input_summary: 'Sept 21 date, 140 guests, $32k budget',
    output_summary: 'Score 81 — strong match; flag for tour priority',
    latency_ms: 1290,
    tokens_used: 880,
  },
  {
    leadSlug: 'lead4',
    action: 'send-reply',
    input_summary: 'Pricing inquiry mid-May 2027',
    output_summary: 'Quoted $30k baseline; offered to email full add-on menu',
    latency_ms: 1850,
    tokens_used: 1120,
  },
  {
    leadSlug: 'lead6',
    action: 'send-reply',
    input_summary: 'Tour follow-up — ready to move forward',
    output_summary: 'Promised formal quote within 24h; gathered scope (venue+seating+suite)',
    latency_ms: 1610,
    tokens_used: 1010,
  },
  {
    leadSlug: 'lead8',
    action: 'qualify-lead',
    input_summary: 'Urgent — needs $30k all-in including open bar',
    output_summary: 'Score 86 — urgent; flagged for human review on pricing adjustment',
    latency_ms: 1380,
    tokens_used: 940,
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}

function dateAtHour(base: Date, hour: number): Date {
  const d = new Date(base)
  d.setUTCHours(hour, 0, 0, 0)
  return d
}

function minutesAgo(mins: number): Date {
  return new Date(Date.now() - mins * 60 * 1000)
}

// ---------------------------------------------------------------------------
// resetDemoVenue
// ---------------------------------------------------------------------------

export async function resetDemoVenue({
  venueId,
  requestId,
}: {
  venueId: string
  requestId?: string
}): Promise<ResetDemoVenueResult> {
  const reqLog = log.child({ requestId, venueId, op: 'demo.reset' })
  const svc = createServiceClient()

  // 1. Delete ai_actions tagged 'demo-seed' first (lead_id is SET NULL on
  // cascade, so they survive a leads-delete otherwise).
  let aiActionsDeleted = 0
  try {
    const { data: aiRows, error: aiErr } = await svc
      .from('ai_actions')
      .delete()
      .eq('venue_id', venueId)
      .eq('agent', DEMO_AI_AGENT)
      .select('id')
    if (aiErr) {
      reqLog.warn({ err: aiErr }, 'demo.reset.ai_actions_delete_failed')
      captureApiError(aiErr, { requestId, route: 'demo.reset', venueId })
    } else {
      aiActionsDeleted = (aiRows ?? []).length
    }
  } catch (err) {
    reqLog.warn({ err }, 'demo.reset.ai_actions_delete_threw')
    captureApiError(err, { requestId, route: 'demo.reset', venueId })
  }

  // 2. Delete demo leads. Cascades hit conversations, messages, tours,
  // follow_up_schedules — see migration 001 ON DELETE CASCADE.
  let leadsDeleted = 0
  try {
    const { data: leadRows, error: leadErr } = await svc
      .from('leads')
      .delete()
      .eq('venue_id', venueId)
      .like('email', DEMO_EMAIL_LIKE)
      .select('id')
    if (leadErr) {
      reqLog.error({ err: leadErr }, 'demo.reset.leads_delete_failed')
      captureApiError(leadErr, { requestId, route: 'demo.reset', venueId })
    } else {
      leadsDeleted = (leadRows ?? []).length
    }
  } catch (err) {
    reqLog.error({ err }, 'demo.reset.leads_delete_threw')
    captureApiError(err, { requestId, route: 'demo.reset', venueId })
  }

  reqLog.info({ leadsDeleted, aiActionsDeleted }, 'demo.reset.completed')
  return { leadsDeleted, aiActionsDeleted }
}

// ---------------------------------------------------------------------------
// seedDemoVenue
// ---------------------------------------------------------------------------

export async function seedDemoVenue(args: SeedDemoVenueArgs): Promise<DemoCounts> {
  const { venueId, ownerUserId, requestId } = args
  const reqLog = log.child({ requestId, venueId, op: 'demo.seed' })
  reqLog.info({}, 'demo.seed.start')

  // 1. Wipe any previous demo rows so re-running is safe.
  await resetDemoVenue({ venueId, requestId })

  const svc = createServiceClient()

  // 2. Insert leads.
  const leadRows = LEADS.map((l) => ({
    venue_id: venueId,
    name: l.name,
    email: demoEmail(l.slug),
    phone: '5555550100',
    stage: l.stage,
    lead_score: l.lead_score,
    urgency: l.urgency,
    guest_count: l.guest_count,
    budget: l.budget,
    source: 'demo',
    ai_active: l.stage !== 'lost' && l.stage !== 'booked',
    notes: l.notes,
    event_date: daysFromNow(l.eventDateDays).toISOString().slice(0, 10),
    created_at: daysFromNow(-l.createdAgoDays).toISOString(),
  }))

  const { data: insertedLeads, error: leadErr } = await svc
    .from('leads')
    .insert(leadRows)
    .select('id, email')

  if (leadErr || !insertedLeads) {
    reqLog.error({ err: leadErr }, 'demo.seed.leads_insert_failed')
    captureApiError(leadErr ?? new Error('leads insert returned no rows'), {
      requestId,
      route: 'demo.seed',
      venueId,
    })
    throw new Error(`demo.seed leads insert failed: ${leadErr?.message ?? 'no rows returned'}`)
  }

  const leadIdBySlug = new Map<string, string>()
  for (const row of insertedLeads as Array<{ id: string; email: string }>) {
    const match = row.email.match(/^demo\+(.+)@venuerise\.test$/)
    if (match) leadIdBySlug.set(match[1], row.id)
  }

  // 3. Conversations + messages.
  let conversationsCreated = 0
  let messagesCreated = 0
  for (const conv of CONVERSATIONS) {
    const leadId = leadIdBySlug.get(conv.leadSlug)
    if (!leadId) continue
    const lastMessageAt = conv.messages.reduce<Date>((acc, m) => {
      const t = minutesAgo(m.agoMinutes)
      return t > acc ? t : acc
    }, new Date(0))
    const { data: convRow, error: convErr } = await svc
      .from('conversations')
      .insert({
        lead_id: leadId,
        venue_id: venueId,
        sentiment: conv.sentiment,
        unread_count: conv.unreadCount,
        last_message_at: lastMessageAt.toISOString(),
      })
      .select('id')
      .single()
    if (convErr || !convRow) {
      reqLog.warn(
        { err: convErr, leadSlug: conv.leadSlug },
        'demo.seed.conversation_insert_failed'
      )
      continue
    }
    conversationsCreated++

    const conversationId = (convRow as { id: string }).id
    const msgRows = conv.messages.map((m) => ({
      conversation_id: conversationId,
      lead_id: leadId,
      venue_id: venueId,
      role: m.role,
      content: m.content,
      metadata: { source: 'demo-seed' } as Record<string, unknown>,
      created_at: minutesAgo(m.agoMinutes).toISOString(),
    }))
    const { error: msgErr, data: insertedMsgs } = await svc
      .from('messages')
      .insert(msgRows)
      .select('id')
    if (msgErr) {
      reqLog.warn(
        { err: msgErr, leadSlug: conv.leadSlug },
        'demo.seed.messages_insert_failed'
      )
    } else {
      messagesCreated += (insertedMsgs ?? []).length
    }
  }

  // 4. Tours.
  let toursCreated = 0
  const tourRows = TOURS.map((t) => {
    const leadId = leadIdBySlug.get(t.leadSlug)
    if (!leadId) return null
    const scheduledAt = dateAtHour(daysFromNow(t.scheduledAtDays), t.hour)
    return {
      lead_id: leadId,
      venue_id: venueId,
      scheduled_at: scheduledAt.toISOString(),
      duration_minutes: t.durationMinutes,
      status: t.status,
      location_notes: t.locationNotes,
      reminder_24h_sent: t.scheduledAtDays <= 1,
      reminder_2h_sent: t.scheduledAtDays <= 0,
      outcome: t.outcome ?? null,
    }
  }).filter((r): r is NonNullable<typeof r> => r !== null)

  if (tourRows.length > 0) {
    const { data: insertedTours, error: toursErr } = await svc
      .from('tours')
      .insert(tourRows)
      .select('id')
    if (toursErr) {
      reqLog.warn({ err: toursErr }, 'demo.seed.tours_insert_failed')
      captureApiError(toursErr, { requestId, route: 'demo.seed', venueId })
    } else {
      toursCreated = (insertedTours ?? []).length
    }
  }

  // 5. Follow-up schedules.
  let followUpsCreated = 0
  const followUpRows = FOLLOWUPS.map((f) => {
    const leadId = leadIdBySlug.get(f.leadSlug)
    if (!leadId) return null
    const scheduledAt = daysFromNow(f.scheduledAgoDays)
    return {
      lead_id: leadId,
      venue_id: venueId,
      touch_number: f.touchNumber,
      scheduled_at: scheduledAt.toISOString(),
      sent_at: f.status === 'sent' ? scheduledAt.toISOString() : null,
      status: f.status,
      subject: f.subject,
      body: f.body,
    }
  }).filter((r): r is NonNullable<typeof r> => r !== null)

  if (followUpRows.length > 0) {
    const { data: insertedFollowUps, error: followUpsErr } = await svc
      .from('follow_up_schedules')
      .insert(followUpRows)
      .select('id')
    if (followUpsErr) {
      reqLog.warn({ err: followUpsErr }, 'demo.seed.follow_ups_insert_failed')
      captureApiError(followUpsErr, { requestId, route: 'demo.seed', venueId })
    } else {
      followUpsCreated = (insertedFollowUps ?? []).length
    }
  }

  // 6. AI actions — tagged with agent='demo-seed' so reset can target them.
  let aiActionsCreated = 0
  const aiRows = AI_ACTIONS.map((a) => {
    const leadId = leadIdBySlug.get(a.leadSlug)
    if (!leadId) return null
    return {
      venue_id: venueId,
      lead_id: leadId,
      agent: DEMO_AI_AGENT,
      action: a.action,
      input_summary: a.input_summary,
      output_summary: a.output_summary,
      latency_ms: a.latency_ms,
      tokens_used: a.tokens_used,
      success: true,
    }
  }).filter((r): r is NonNullable<typeof r> => r !== null)

  if (aiRows.length > 0) {
    const { data: insertedAi, error: aiErr } = await svc
      .from('ai_actions')
      .insert(aiRows)
      .select('id')
    if (aiErr) {
      reqLog.warn({ err: aiErr }, 'demo.seed.ai_actions_insert_failed')
      captureApiError(aiErr, { requestId, route: 'demo.seed', venueId })
    } else {
      aiActionsCreated = (insertedAi ?? []).length
    }
  }

  // `ownerUserId` is reserved for future enrichment (e.g. tagging a
  // demo `human` message author). Currently unused; reference here so
  // TypeScript noUnusedParameters doesn't complain.
  void ownerUserId

  const result: DemoCounts = {
    leadsCreated: insertedLeads.length,
    conversationsCreated,
    messagesCreated,
    toursCreated,
    followUpsCreated,
    aiActionsCreated,
  }
  reqLog.info(result, 'demo.seed.completed')
  return result
}
