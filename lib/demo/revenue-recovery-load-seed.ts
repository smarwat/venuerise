import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import type { SourceLabel } from '@/lib/enterprise/attribution/types'

/**
 * GTM-0A.2 — Revenue Recovery Load / Stress Seed.
 *
 * Sibling to `lib/demo/revenue-recovery-seed.ts` (GTM-0A) but built
 * for SCALE — 25–1000 leads per call so the dashboard, charts, and
 * Revenue OS surfaces can be tested under realistic-ish load. Four
 * profiles (`balanced`, `high_volume`, `messy_channels`,
 * `sales_demo`) tilt the stage / source / channel / leakage mix for
 * different demo scenarios.
 *
 * ── ISOLATION CONTRACT ───────────────────────────────────────────────
 * Every row inserted by this seeder is tagged with BOTH:
 *   - `demo_seed: true`
 *   - `demo_seed_type: 'load'`
 *   - `demo_seed_version: 'gtm_0a_2'`
 *
 * Reset matches on `demo_seed_type = 'load'` AND
 * `demo_seed_version = 'gtm_0a_2'` so a load-seed reset NEVER touches
 * GTM-0A's hand-crafted 24-lead demo (which tags `demo_seed_type`
 * absent / `demo_seed_version = 'gtm_0a'`).
 *
 * `server-only` — bypasses RLS via service-role client. Callers MUST
 * gate access (`requireAdmin()` + tenant venueId match).
 */

// ──────────────────────────────────────────────────────────────────────
//  Public types
// ──────────────────────────────────────────────────────────────────────

export const REVENUE_RECOVERY_LOAD_DEMO_VERSION = 'gtm_0a_2' as const
export const REVENUE_RECOVERY_LOAD_DEMO_TYPE = 'load' as const

export const LOAD_SEED_PROFILES = [
  'balanced',
  'high_volume',
  'messy_channels',
  'sales_demo',
] as const
export type LoadSeedProfile = (typeof LOAD_SEED_PROFILES)[number]

export const MIN_LEAD_COUNT = 25
export const DEFAULT_LEAD_COUNT = 250
export const MAX_LEAD_COUNT = 1000

export interface SeedRevenueRecoveryLoadDemoArgs {
  venueId: string
  actorUserId: string
  /** Defaults to `DEFAULT_LEAD_COUNT` (250). Clamped to
   *  `[MIN_LEAD_COUNT, MAX_LEAD_COUNT]` with a warning on clamp. */
  leadCount?: number
  /** Defaults to `balanced`. */
  profile?: LoadSeedProfile
  /** When true, delete every previously-seeded gtm_0a_2 LOAD row
   *  before re-seeding. Never touches GTM-0A hand-crafted rows. */
  resetExistingDemoData?: boolean
  /** Override clock for deterministic test runs. Defaults to `now`. */
  now?: Date
  /** Optional seed so two runs with identical args produce identical
   *  data (test snapshots). When omitted, a per-call seed mixes the
   *  venue+actor+clock so different operators get visibly different
   *  pipelines. */
  rngSeed?: number
  requestId?: string
}

export interface RevenueRecoveryLoadSeedResult {
  success: boolean
  venueId: string
  profile: LoadSeedProfile
  leadCountRequested: number
  leadCountClamped: number
  created: Record<string, number>
  distribution: {
    stages: Record<string, number>
    sources: Record<string, number>
    channels: Record<string, number>
    lostReasons: Record<string, number>
    leakageSignals: Record<string, number>
  }
  reset: Record<string, number>
  warnings: string[]
  durationMs: number
}

// ──────────────────────────────────────────────────────────────────────
//  Internal types
// ──────────────────────────────────────────────────────────────────────

type LeadStage =
  | 'new_inquiry'
  | 'qualified'
  | 'tour_scheduled'
  | 'tour_completed'
  | 'negotiation'
  | 'booked'
  | 'lost'

type LostReasonKey =
  | 'ghosted'
  | 'priced_out'
  | 'date_unavailable'
  | 'picked_competitor'
  | 'not_a_fit'
  | 'other'

type ChannelType =
  | 'website'
  | 'instagram'
  | 'facebook'
  | 'meta_lead_ads'
  | 'the_knot'
  | 'weddingwire'
  | 'email'

interface SourceSpec {
  source: string
  source_label: SourceLabel
  channel_type: ChannelType
  utm: {
    source?: string
    medium?: string
    campaign?: string
    landing_page?: string
    referrer?: string
    gclid?: string | null
    fbclid?: string | null
    msclkid?: string | null
    ttclid?: string | null
  }
}

interface ProfileDistribution {
  stages: Record<LeadStage, number>
  sources: Record<string, number>
  /** Channel mix used for the lead's *conversation* (and as a fallback
   *  for source.channel_type override). Source determines the lead's
   *  attribution; channel determines the inbound message channel. */
  channels: Record<ChannelType, number>
  /** % of leads that should get a conversation thread. */
  conversationCoverage: number
  /** Min/max messages per conversation. */
  messagesPerConversation: { min: number; max: number }
  /** Lost-reason mix conditional on `stage = 'lost'`. */
  lostReasons: Record<LostReasonKey, number>
}

// ──────────────────────────────────────────────────────────────────────
//  Per-profile distributions
// ──────────────────────────────────────────────────────────────────────

const BALANCED: ProfileDistribution = {
  stages: {
    new_inquiry: 0.18,
    qualified: 0.20,
    tour_scheduled: 0.14,
    tour_completed: 0.10,
    negotiation: 0.12,
    booked: 0.10,
    lost: 0.16,
  },
  sources: {
    google_ads: 0.18,
    meta_lead_ads: 0.16,
    instagram: 0.14,
    the_knot: 0.12,
    weddingwire: 0.10,
    website: 0.22,
    referral: 0.05,
    unknown: 0.03,
  },
  channels: {
    website: 0.32,
    instagram: 0.16,
    facebook: 0.04,
    meta_lead_ads: 0.16,
    the_knot: 0.14,
    weddingwire: 0.10,
    email: 0.08,
  },
  conversationCoverage: 0.7,
  messagesPerConversation: { min: 1, max: 8 },
  lostReasons: {
    ghosted: 0.35,
    priced_out: 0.25,
    date_unavailable: 0.15,
    picked_competitor: 0.10,
    not_a_fit: 0.10,
    other: 0.05,
  },
}

const HIGH_VOLUME: ProfileDistribution = {
  ...BALANCED,
  stages: {
    new_inquiry: 0.32,
    qualified: 0.20,
    tour_scheduled: 0.12,
    tour_completed: 0.06,
    negotiation: 0.06,
    booked: 0.06,
    lost: 0.18,
  },
  conversationCoverage: 0.6,
}

const MESSY_CHANNELS: ProfileDistribution = {
  ...BALANCED,
  sources: {
    google_ads: 0.10,
    meta_lead_ads: 0.24,
    instagram: 0.24,
    the_knot: 0.18,
    weddingwire: 0.14,
    website: 0.05,
    referral: 0.03,
    unknown: 0.02,
  },
  channels: {
    website: 0.08,
    instagram: 0.24,
    facebook: 0.06,
    meta_lead_ads: 0.26,
    the_knot: 0.20,
    weddingwire: 0.12,
    email: 0.04,
  },
  conversationCoverage: 0.75,
}

const SALES_DEMO: ProfileDistribution = {
  ...BALANCED,
  stages: {
    new_inquiry: 0.16,
    qualified: 0.18,
    tour_scheduled: 0.16,
    tour_completed: 0.12,
    negotiation: 0.14,
    booked: 0.14,
    lost: 0.10,
  },
  conversationCoverage: 0.75,
}

const PROFILE_MAP: Record<LoadSeedProfile, ProfileDistribution> = {
  balanced: BALANCED,
  high_volume: HIGH_VOLUME,
  messy_channels: MESSY_CHANNELS,
  sales_demo: SALES_DEMO,
}

// ──────────────────────────────────────────────────────────────────────
//  Source catalog — source key → SourceSpec
// ──────────────────────────────────────────────────────────────────────

const SOURCE_CATALOG: Record<string, SourceSpec> = {
  google_ads: {
    source: 'google_ads',
    source_label: 'Google Ads',
    channel_type: 'website',
    utm: {
      source: 'google',
      medium: 'cpc',
      campaign: 'spring-2026-wedding',
      landing_page: '/venue/garden',
      gclid: 'CjwKCAiA-load-gclid',
    },
  },
  meta_lead_ads: {
    source: 'meta_lead_ads',
    source_label: 'Meta Ads',
    channel_type: 'meta_lead_ads',
    utm: {
      source: 'meta',
      medium: 'paid_social',
      campaign: 'wedding-broad-q1',
      fbclid: 'IwAR0-load-fbclid',
    },
  },
  instagram: {
    source: 'instagram',
    source_label: 'Instagram',
    channel_type: 'instagram',
    utm: {
      source: 'instagram',
      medium: 'social',
      campaign: 'organic',
    },
  },
  the_knot: {
    source: 'the_knot',
    source_label: 'The Knot',
    channel_type: 'the_knot',
    utm: {
      source: 'the_knot',
      medium: 'directory',
      campaign: 'organic',
    },
  },
  weddingwire: {
    source: 'weddingwire',
    source_label: 'WeddingWire',
    channel_type: 'weddingwire',
    utm: {
      source: 'weddingwire',
      medium: 'directory',
    },
  },
  website: {
    source: 'website',
    source_label: 'Website',
    channel_type: 'website',
    utm: {
      source: 'direct',
      medium: 'direct',
    },
  },
  referral: {
    source: 'referral',
    source_label: 'Referral',
    channel_type: 'website',
    utm: {
      source: 'referral',
      medium: 'word_of_mouth',
    },
  },
  unknown: {
    source: 'unknown',
    source_label: 'Unknown',
    channel_type: 'website',
    utm: {
      source: undefined,
      medium: undefined,
    },
  },
}

// ──────────────────────────────────────────────────────────────────────
//  Name pools (realistic-ish; not real people)
// ──────────────────────────────────────────────────────────────────────

const FIRST_NAMES: ReadonlyArray<string> = [
  'Madison', 'Aisha', 'Tyler', 'Sophia', 'Olivia', 'Emma', 'James',
  'Hannah', 'Daniel', 'Ava', 'Liam', 'Grace', 'Noah', 'Charlotte',
  'Ethan', 'Mia', 'Lucas', 'Isabella', 'Ryan', 'Zoe', 'Ben',
  'Natalie', 'Jacob', 'Chloe', 'Owen', 'Amelia', 'Mason', 'Harper',
  'Logan', 'Lily', 'Carter', 'Layla', 'Henry', 'Aria', 'Sebastian',
  'Ella', 'Wyatt', 'Scarlett', 'Julian', 'Penelope', 'Grayson',
  'Hazel', 'Levi', 'Aurora', 'Isaac', 'Violet', 'Asher', 'Nora',
  'Eli', 'Stella', 'Caleb', 'Hannah', 'Adrian', 'Maya', 'Theodore',
  'Riley', 'Jonah', 'Camila', 'Miles', 'Ruby',
]

const LAST_NAMES: ReadonlyArray<string> = [
  'Reyes', 'Brooks', 'Nguyen', 'Patel', 'Chen', 'Thompson', 'Rivera',
  'Lewis', 'Walsh', 'Morgan', 'Carter', 'Mitchell', 'Bennett', 'Kim',
  'Park', 'Sanders', 'Foster', 'Rossi', 'OConnor', 'Anderson',
  'Reilly', 'Singh', 'Garcia', 'Hernandez', 'Martinez', 'Robinson',
  'Clark', 'Lewis', 'Walker', 'Young', 'Hall', 'Allen', 'King',
  'Wright', 'Scott', 'Green', 'Adams', 'Baker', 'Nelson', 'Hill',
  'Ramirez', 'Campbell', 'Mitchell', 'Roberts', 'Phillips', 'Evans',
  'Turner', 'Diaz', 'Parker', 'Edwards', 'Collins', 'Stewart',
  'Sanchez', 'Morris', 'Rogers', 'Reed', 'Cook', 'Bell', 'Murphy',
  'Bailey', 'Cooper', 'Howard', 'Ward', 'Cox', 'Richardson', 'Wood',
  'Watson', 'Brooks', 'Bennett', 'Gray', 'James', 'Hughes', 'Price',
]

// ──────────────────────────────────────────────────────────────────────
//  Seeded RNG (mulberry32 — small, fast, deterministic)
// ──────────────────────────────────────────────────────────────────────

function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickWeighted<K extends string>(
  rng: () => number,
  weights: Record<K, number>
): K {
  const entries = Object.entries(weights) as Array<[K, number]>
  const total = entries.reduce((s, [, w]) => s + w, 0)
  const r = rng() * total
  let acc = 0
  for (const [k, w] of entries) {
    acc += w
    if (r <= acc) return k
  }
  return entries[entries.length - 1][0]
}

function pick<T>(rng: () => number, arr: ReadonlyArray<T>): T {
  return arr[Math.floor(rng() * arr.length)]
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min
}

// Deterministic positive integer hash for the venueId+actor mix.
function hashSeed(...parts: string[]): number {
  let h = 2166136261
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      h ^= p.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  return h >>> 0
}

// ──────────────────────────────────────────────────────────────────────
//  Demo-tagging helpers
// ──────────────────────────────────────────────────────────────────────

function demoMetadata(args: { actorUserId: string; nowIso: string }) {
  return {
    demo_seed: true as const,
    demo_seed_type: REVENUE_RECOVERY_LOAD_DEMO_TYPE,
    demo_seed_version: REVENUE_RECOVERY_LOAD_DEMO_VERSION,
    demo_seeded_at: args.nowIso,
    demo_seeded_by: args.actorUserId,
  }
}

const DEMO_EMAIL_DOMAIN = 'venuerise-demo.test'
function demoEmail(slug: string): string {
  return `rrl-${slug}@${DEMO_EMAIL_DOMAIN}`
}

// ──────────────────────────────────────────────────────────────────────
//  Lead generator
// ──────────────────────────────────────────────────────────────────────

interface GeneratedLead {
  slug: string
  name: string
  email: string
  phone: string
  stage: LeadStage
  urgency: 'low' | 'medium' | 'high' | 'critical'
  lead_score: number
  ai_active: boolean
  source: string
  source_label: SourceLabel
  channel_type: ChannelType
  utm: SourceSpec['utm']
  event_date: string
  guest_count: number
  budget: number
  notes: string
  created_at: string
  updated_at: string
  lost_reason?: LostReasonKey
  conversation?: GeneratedConversation
  tour?: GeneratedTour
  /** Leakage signal flags for distribution accounting. */
  signals: {
    slow_first_reply: boolean
    qualified_no_tour: boolean
    cold_recovery: boolean
    pending_tour: boolean
    reactivation: boolean
    booked_attribution: boolean
  }
}

interface GeneratedConversation {
  channel_type: ChannelType
  sentiment: 'positive' | 'neutral' | 'negative' | 'urgent'
  messages: Array<{
    role: 'lead' | 'ai' | 'human' | 'system'
    content: string
    created_at: string
    channel_type: ChannelType
    parse_review?: boolean
    parse_confidence?: number
    parse_confidence_reasons?: string[]
    manual_reply?: boolean
  }>
  last_message_at: string
}

interface GeneratedTour {
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'
  scheduled_at: string
  duration_minutes: number
  outcome: string | null
}

const NOTE_TEMPLATES: ReadonlyArray<string> = [
  'Asked about Saturday availability.',
  'Wants to tour ASAP.',
  'Budget firm; date flexible.',
  'Sent pricing PDF.',
  'Requested vegetarian catering options.',
  'Family of 4 wants to tour.',
  'Inquiry mentions friend referral.',
  'Asked about rain plan + outdoor ceremony.',
  'Wants Friday discount details.',
  'Comparing 2 other venues — date is the deciding factor.',
  'Asked about bar packages.',
  'Wants a proposal sent over.',
  'Date held for 5 business days post-tour.',
]

function generateLead(
  rng: () => number,
  index: number,
  now: Date,
  profile: ProfileDistribution
): GeneratedLead {
  const stage = pickWeighted(rng, profile.stages)
  const sourceKey = pickWeighted(rng, profile.sources)
  const sourceSpec = SOURCE_CATALOG[sourceKey] ?? SOURCE_CATALOG.website
  const channelType =
    sourceSpec.channel_type === 'website' && rng() < 0.3
      ? pickWeighted(rng, profile.channels)
      : sourceSpec.channel_type

  const first = pick(rng, FIRST_NAMES)
  const last = pick(rng, LAST_NAMES)
  const name = `${first} ${last}`
  const slug = `${first.toLowerCase()}-${last.toLowerCase()}-${index}`

  // Stage-conditioned timing — older for advanced stages.
  let createdOffsetHours: number
  switch (stage) {
    case 'new_inquiry':
      createdOffsetHours = -randInt(rng, 1, 96)
      break
    case 'qualified':
      createdOffsetHours = -randInt(rng, 24, 240)
      break
    case 'tour_scheduled':
      createdOffsetHours = -randInt(rng, 48, 336)
      break
    case 'tour_completed':
      createdOffsetHours = -randInt(rng, 120, 480)
      break
    case 'negotiation':
      createdOffsetHours = -randInt(rng, 168, 720)
      break
    case 'booked':
      createdOffsetHours = -randInt(rng, 240, 1200)
      break
    case 'lost':
      createdOffsetHours = -randInt(rng, 720, 3600)
      break
  }
  const createdAt = new Date(now.getTime() + createdOffsetHours * 3_600_000)
  const updatedAt = new Date(
    createdAt.getTime() + randInt(rng, 0, 96) * 3_600_000
  )
  const eventDateDaysOut = randInt(rng, 45, 420)
  const eventDate = new Date(now.getTime() + eventDateDaysOut * 86_400_000)
    .toISOString()
    .slice(0, 10)

  const guestCount = randInt(rng, 40, 350)
  // Budget loosely tracks guest count with noise.
  const budget = Math.round(
    (guestCount * randInt(rng, 100, 220) + randInt(rng, -3000, 3000)) / 100
  ) * 100
  const clampedBudget = Math.max(6000, Math.min(60000, budget))

  const leadScore = randInt(rng, 35, 96)
  const urgency: GeneratedLead['urgency'] =
    leadScore >= 85
      ? 'high'
      : leadScore >= 70
        ? 'medium'
        : leadScore >= 50
          ? 'low'
          : 'low'

  // Lost reason
  let lostReason: LostReasonKey | undefined
  if (stage === 'lost') {
    lostReason = pickWeighted(rng, profile.lostReasons)
  }

  // AI active: off for booked / lost; on otherwise with 90% prob.
  const aiActive =
    stage !== 'booked' && stage !== 'lost' ? rng() < 0.9 : false

  const phone = `+1 (${randInt(rng, 200, 989)}) 555-${String(
    randInt(rng, 100, 9999)
  ).padStart(4, '0')}`

  // Conversation generation
  let conversation: GeneratedConversation | undefined
  if (rng() < profile.conversationCoverage) {
    conversation = generateConversation(
      rng,
      createdAt,
      channelType,
      stage,
      profile,
      name
    )
  }

  // Tour generation for stage-eligible leads
  let tour: GeneratedTour | undefined
  if (
    stage === 'tour_scheduled' ||
    stage === 'tour_completed' ||
    stage === 'negotiation' ||
    stage === 'booked'
  ) {
    tour = generateTour(rng, now, stage)
  }

  // Signal accounting (mirror Revenue OS detection logic)
  const hoursSinceCreated = Math.abs(createdOffsetHours)
  const replied =
    !!conversation && conversation.messages.some((m) => m.role !== 'lead')
  const slowFirstReply =
    stage === 'new_inquiry' && !replied && hoursSinceCreated >= 4
  const qualifiedNoTour = stage === 'qualified' && !tour
  const coldRecovery =
    (stage === 'qualified' || stage === 'tour_completed') &&
    hoursSinceCreated >= 72 &&
    !replied
  const pendingTour = stage === 'tour_scheduled' && tour?.status === 'scheduled'
  const reactivation =
    stage === 'lost' &&
    (lostReason === 'ghosted' || lostReason === 'priced_out') &&
    hoursSinceCreated >= 24 * 30
  const bookedAttribution = stage === 'booked'

  const note = pick(rng, NOTE_TEMPLATES)

  return {
    slug,
    name,
    email: demoEmail(slug),
    phone,
    stage,
    urgency,
    lead_score: leadScore,
    ai_active: aiActive,
    source: sourceSpec.source,
    source_label: sourceSpec.source_label,
    channel_type: channelType,
    utm: sourceSpec.utm,
    event_date: eventDate,
    guest_count: guestCount,
    budget: clampedBudget,
    notes: note,
    created_at: createdAt.toISOString(),
    updated_at: updatedAt.toISOString(),
    lost_reason: lostReason,
    conversation,
    tour,
    signals: {
      slow_first_reply: slowFirstReply,
      qualified_no_tour: qualifiedNoTour,
      cold_recovery: coldRecovery,
      pending_tour: !!pendingTour,
      reactivation,
      booked_attribution: bookedAttribution,
    },
  }
}

const LEAD_OPENERS: ReadonlyArray<string> = [
  'Hi! Loved your photos. What does pricing look like for ~{guests} guests?',
  'Found you on a directory listing — is {date} open?',
  'Hello — looking at a {guests}-person wedding next year. Any Saturdays left?',
  'Quick question: does the package include in-house catering?',
  "Hi! We're touring venues this weekend — can we come by?",
  'Inquiring about an outdoor ceremony with a rain plan.',
]

const AI_REPLIES: ReadonlyArray<string> = [
  'Thanks for reaching out! I can offer Tuesday 11am or Saturday 10am for a tour — which works?',
  'Happy to help. Could you share your target date and guest count so I can pull the right package?',
  'Yes, that date is open. The package starts at $X — would you like to schedule a tour?',
  'Great question — we cater in-house and have vegetarian + gluten-free options.',
]

const HUMAN_REPLIES: ReadonlyArray<string> = [
  'Hi — just confirming your tour for Saturday morning. Looking forward to meeting!',
  'Sent the packages PDF over email. Let me know if you have questions.',
  "Quick follow-up — wanted to check in before your date fills up.",
  "Hi — here's the proposal. Let me know if the all-in number lands.",
]

function generateConversation(
  rng: () => number,
  leadCreatedAt: Date,
  channel: ChannelType,
  stage: LeadStage,
  profile: ProfileDistribution,
  leadName: string
): GeneratedConversation {
  const count = randInt(
    rng,
    profile.messagesPerConversation.min,
    profile.messagesPerConversation.max
  )
  const sentiment: GeneratedConversation['sentiment'] =
    stage === 'booked'
      ? 'positive'
      : stage === 'lost'
        ? rng() < 0.3
          ? 'negative'
          : 'neutral'
        : rng() < 0.6
          ? 'positive'
          : 'neutral'

  const messages: GeneratedConversation['messages'] = []
  let cursor = leadCreatedAt.getTime()
  for (let i = 0; i < count; i++) {
    const role: 'lead' | 'ai' | 'human' =
      i === 0 ? 'lead' : i % 3 === 0 ? 'lead' : rng() < 0.55 ? 'ai' : 'human'
    cursor += randInt(rng, 30, 720) * 60_000 // 30min – 12h spacing
    const isManualRequiredChannel =
      channel === 'instagram' ||
      channel === 'the_knot' ||
      channel === 'weddingwire' ||
      channel === 'meta_lead_ads'
    const content =
      role === 'lead'
        ? pick(rng, LEAD_OPENERS)
            .replace('{guests}', String(randInt(rng, 80, 240)))
            .replace('{date}', 'April 18')
        : role === 'ai'
          ? pick(rng, AI_REPLIES)
          : pick(rng, HUMAN_REPLIES)
    const parseReview =
      channel === 'meta_lead_ads' && role === 'lead' && rng() < 0.25
    messages.push({
      role,
      content,
      created_at: new Date(cursor).toISOString(),
      channel_type: channel,
      parse_review: parseReview,
      parse_confidence: parseReview ? 0.6 + rng() * 0.2 : undefined,
      parse_confidence_reasons: parseReview
        ? ['budget_guessed_from_guest_count']
        : undefined,
      manual_reply:
        (role === 'human' || role === 'lead') && isManualRequiredChannel,
    })
  }

  // Reference the leadName so it's used (avoids dead-param warnings).
  if (messages.length > 0 && messages[0].role === 'lead') {
    messages[0].content = `${messages[0].content}`.replace(
      'Hi!',
      `Hi! I'm ${leadName.split(' ')[0]} —`
    )
  }

  return {
    channel_type: channel,
    sentiment,
    messages,
    last_message_at: messages[messages.length - 1]?.created_at ?? leadCreatedAt.toISOString(),
  }
}

function generateTour(
  rng: () => number,
  now: Date,
  stage: LeadStage
): GeneratedTour {
  // Stage shapes tour status & timing
  let status: GeneratedTour['status']
  let daysOut: number
  let outcome: string | null = null
  switch (stage) {
    case 'tour_scheduled':
      status = rng() < 0.6 ? 'scheduled' : 'confirmed'
      daysOut = randInt(rng, 1, 14)
      break
    case 'tour_completed':
      status = 'completed'
      daysOut = -randInt(rng, 1, 20)
      outcome = pick(rng, [
        'walked through both ceremony spaces',
        'family present; requested proposal',
        'liked the rooftop',
        'asked for revised quote',
      ])
      break
    case 'negotiation':
      status = 'completed'
      daysOut = -randInt(rng, 7, 45)
      outcome = 'proposal sent post-tour'
      break
    case 'booked':
      status = 'completed'
      daysOut = -randInt(rng, 14, 90)
      outcome = 'closed'
      break
    default:
      status = 'scheduled'
      daysOut = 7
  }
  const scheduledAt = new Date(now.getTime() + daysOut * 86_400_000)
  // Snap to 10am-ish slot for realism.
  scheduledAt.setHours(randInt(rng, 9, 16), randInt(rng, 0, 1) * 30, 0, 0)
  return {
    status,
    scheduled_at: scheduledAt.toISOString(),
    duration_minutes: randInt(rng, 45, 90),
    outcome,
  }
}

// ──────────────────────────────────────────────────────────────────────
//  Main entry point
// ──────────────────────────────────────────────────────────────────────

export async function seedRevenueRecoveryLoadDemo(
  args: SeedRevenueRecoveryLoadDemoArgs
): Promise<RevenueRecoveryLoadSeedResult> {
  const startedAt = Date.now()
  const now = args.now ?? new Date()
  const nowIso = now.toISOString()
  const profile: LoadSeedProfile = args.profile ?? 'balanced'
  const distribution = PROFILE_MAP[profile]
  const tag = demoMetadata({ actorUserId: args.actorUserId, nowIso })
  const svc = createServiceClient()
  const reqLog = log.child({
    requestId: args.requestId,
    venueId: args.venueId,
    op: 'demo.revenue_recovery_load.seed',
  })

  const requested = args.leadCount ?? DEFAULT_LEAD_COUNT
  const clamped = Math.max(
    MIN_LEAD_COUNT,
    Math.min(MAX_LEAD_COUNT, Math.floor(requested))
  )

  const warnings: string[] = []
  if (clamped !== requested) {
    warnings.push(
      `lead_count_clamped: requested=${requested} actual=${clamped} bounds=[${MIN_LEAD_COUNT}, ${MAX_LEAD_COUNT}]`
    )
  }

  const created: Record<string, number> = {
    leads: 0,
    conversations: 0,
    messages: 0,
    tours: 0,
  }
  const reset: Record<string, number> = { leads: 0 }
  const dist = {
    stages: {} as Record<string, number>,
    sources: {} as Record<string, number>,
    channels: {} as Record<string, number>,
    lostReasons: {} as Record<string, number>,
    leakageSignals: {
      slow_first_reply: 0,
      qualified_no_tour: 0,
      cold_recovery: 0,
      pending_tour: 0,
      reactivation: 0,
      booked_attribution: 0,
    } as Record<string, number>,
  }

  const rngSeed =
    args.rngSeed ??
    hashSeed(args.venueId, args.actorUserId, String(now.getTime()))
  const rng = makeRng(rngSeed)

  // ── Reset previous LOAD-seeded rows (NEVER touches GTM-0A rows) ──
  if (args.resetExistingDemoData) {
    try {
      const { data: leadIds, error: selectErr } = await svc
        .from('leads')
        .select('id')
        .eq('venue_id', args.venueId)
        .eq('metadata->>demo_seed_type', REVENUE_RECOVERY_LOAD_DEMO_TYPE)
        .eq(
          'metadata->>demo_seed_version',
          REVENUE_RECOVERY_LOAD_DEMO_VERSION
        )
      if (selectErr) throw selectErr
      const ids = (leadIds ?? []).map((r) => (r as { id: string }).id)
      if (ids.length > 0) {
        // Batch deletes — Postgres `IN ()` lists can balloon at 1k+.
        const chunkSize = 200
        for (let i = 0; i < ids.length; i += chunkSize) {
          const slice = ids.slice(i, i + chunkSize)
          const { error: delErr } = await svc
            .from('leads')
            .delete()
            .in('id', slice)
          if (delErr) throw delErr
        }
        reset.leads = ids.length
      }
    } catch (err) {
      reqLog.error({ err }, 'demo.revenue_recovery_load.reset_failed')
      warnings.push(
        `reset_failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // ── Generate all leads in memory first (cheap; ~1MB at 1k leads) ──
  const generated: GeneratedLead[] = []
  for (let i = 0; i < clamped; i++) {
    const lead = generateLead(rng, i, now, distribution)
    generated.push(lead)
    dist.stages[lead.stage] = (dist.stages[lead.stage] ?? 0) + 1
    dist.sources[lead.source] = (dist.sources[lead.source] ?? 0) + 1
    dist.channels[lead.channel_type] =
      (dist.channels[lead.channel_type] ?? 0) + 1
    if (lead.lost_reason) {
      dist.lostReasons[lead.lost_reason] =
        (dist.lostReasons[lead.lost_reason] ?? 0) + 1
    }
    for (const [k, v] of Object.entries(lead.signals)) {
      if (v) dist.leakageSignals[k] = (dist.leakageSignals[k] ?? 0) + 1
    }
  }

  // ── Insert leads in chunks of 100 ──────────────────────────────────
  type InsertedLead = { id: string; gen: GeneratedLead }
  const inserted: InsertedLead[] = []
  const LEAD_CHUNK = 100
  for (let i = 0; i < generated.length; i += LEAD_CHUNK) {
    const slice = generated.slice(i, i + LEAD_CHUNK)
    const payload = slice.map((g) => {
      const attribution = {
        source: g.utm.source ?? null,
        medium: g.utm.medium ?? null,
        campaign: g.utm.campaign ?? null,
        term: null,
        content: null,
        landing_page: g.utm.landing_page ?? null,
        referrer: g.utm.referrer ?? null,
        gclid: g.utm.gclid ?? null,
        fbclid: g.utm.fbclid ?? null,
        msclkid: g.utm.msclkid ?? null,
        ttclid: g.utm.ttclid ?? null,
        channel_type: g.channel_type,
        source_label: g.source_label,
        captured_at: g.created_at,
      }
      const metadata: Record<string, unknown> = {
        ...tag,
        attribution,
      }
      if (g.lost_reason) {
        metadata.lost_reason = {
          reason: g.lost_reason,
          recorded_at: g.updated_at,
        }
      }
      return {
        venue_id: args.venueId,
        name: g.name,
        email: g.email,
        phone: g.phone,
        stage: g.stage,
        lead_score: g.lead_score,
        urgency: g.urgency,
        event_date: g.event_date,
        guest_count: g.guest_count,
        budget: g.budget,
        source: g.source,
        ai_active: g.ai_active,
        notes: g.notes,
        metadata,
        created_at: g.created_at,
        updated_at: g.updated_at,
      }
    })
    const { data: rows, error } = await svc
      .from('leads')
      .insert(payload)
      .select('id')
    if (error) {
      warnings.push(`leads_insert_failed: chunk=${i / LEAD_CHUNK} ${error.message}`)
      continue
    }
    const idRows = (rows ?? []) as Array<{ id: string }>
    for (let j = 0; j < idRows.length; j++) {
      inserted.push({ id: idRows[j].id, gen: slice[j] })
      created.leads += 1
    }
  }

  // ── Insert conversations in chunks of 100 ──────────────────────────
  type InsertedConv = { id: string; leadId: string; gen: GeneratedConversation }
  const insertedConvs: InsertedConv[] = []
  const convChunks: Array<Array<{ leadId: string; gen: GeneratedConversation }>> = []
  let curConv: Array<{ leadId: string; gen: GeneratedConversation }> = []
  for (const il of inserted) {
    if (il.gen.conversation) {
      curConv.push({ leadId: il.id, gen: il.gen.conversation })
      if (curConv.length === 100) {
        convChunks.push(curConv)
        curConv = []
      }
    }
  }
  if (curConv.length > 0) convChunks.push(curConv)

  for (const chunk of convChunks) {
    const payload = chunk.map((c) => ({
      lead_id: c.leadId,
      venue_id: args.venueId,
      sentiment: c.gen.sentiment,
      unread_count: 0,
      last_message_at: c.gen.last_message_at,
      created_at: c.gen.messages[0]?.created_at ?? c.gen.last_message_at,
      updated_at: c.gen.last_message_at,
    }))
    const { data: rows, error } = await svc
      .from('conversations')
      .insert(payload)
      .select('id, lead_id')
    if (error) {
      warnings.push(`conversations_insert_failed: ${error.message}`)
      continue
    }
    const idRows = (rows ?? []) as Array<{ id: string; lead_id: string }>
    // Re-match conversations by lead_id (insert order is not guaranteed).
    const genByLead = new Map<string, GeneratedConversation>()
    for (const c of chunk) genByLead.set(c.leadId, c.gen)
    for (const r of idRows) {
      const gen = genByLead.get(r.lead_id)
      if (!gen) continue
      insertedConvs.push({ id: r.id, leadId: r.lead_id, gen })
      created.conversations += 1
    }
  }

  // ── Insert messages in chunks of 250 ───────────────────────────────
  const messagePayloads: Array<Record<string, unknown>> = []
  for (const conv of insertedConvs) {
    for (const msg of conv.gen.messages) {
      const metadata: Record<string, unknown> = { ...tag }
      metadata.channel_type = msg.channel_type
      if (msg.parse_review) {
        metadata.parse_needs_review = true
        metadata.parse_confidence = msg.parse_confidence ?? 0.65
        metadata.parse_confidence_reasons = msg.parse_confidence_reasons ?? []
      }
      if (msg.manual_reply) {
        metadata.source = 'manual_required'
        metadata.manual_reply_marked_at = msg.created_at
        metadata.manual_reply_marked_by = args.actorUserId
      }
      messagePayloads.push({
        conversation_id: conv.id,
        lead_id: conv.leadId,
        venue_id: args.venueId,
        role: msg.role,
        content: msg.content,
        metadata,
        created_at: msg.created_at,
      })
    }
  }
  const MSG_CHUNK = 250
  for (let i = 0; i < messagePayloads.length; i += MSG_CHUNK) {
    const slice = messagePayloads.slice(i, i + MSG_CHUNK)
    const { error } = await svc.from('messages').insert(slice)
    if (error) {
      warnings.push(`messages_insert_failed: chunk=${i / MSG_CHUNK} ${error.message}`)
      continue
    }
    created.messages += slice.length
  }

  // ── Insert tours in chunks of 100 ──────────────────────────────────
  const tourPayloads: Array<Record<string, unknown>> = []
  for (const il of inserted) {
    if (il.gen.tour) {
      tourPayloads.push({
        lead_id: il.id,
        venue_id: args.venueId,
        scheduled_at: il.gen.tour.scheduled_at,
        duration_minutes: il.gen.tour.duration_minutes,
        status: il.gen.tour.status,
        outcome: il.gen.tour.outcome,
      })
    }
  }
  const TOUR_CHUNK = 100
  for (let i = 0; i < tourPayloads.length; i += TOUR_CHUNK) {
    const slice = tourPayloads.slice(i, i + TOUR_CHUNK)
    const { error } = await svc.from('tours').insert(slice)
    if (error) {
      warnings.push(`tours_insert_failed: chunk=${i / TOUR_CHUNK} ${error.message}`)
      continue
    }
    created.tours += slice.length
  }

  const durationMs = Date.now() - startedAt
  reqLog.info(
    {
      profile,
      requested,
      clamped,
      created,
      reset,
      warningsCount: warnings.length,
      durationMs,
    },
    'demo.revenue_recovery_load.seed_completed'
  )

  return {
    success: true,
    venueId: args.venueId,
    profile,
    leadCountRequested: requested,
    leadCountClamped: clamped,
    created,
    distribution: dist,
    reset,
    warnings,
    durationMs,
  }
}
