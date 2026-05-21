import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import type { SourceLabel } from '@/lib/enterprise/attribution/types'

/**
 * GTM-0A — Revenue Recovery Demo seed.
 *
 * Drops a realistic, leak-shaped wedding-venue pipeline onto a single
 * venue so /dashboard and /dashboard/leads tell the Revenue OS story
 * within 30 seconds:
 *
 *   - new_inquiry leads created hours/days ago with no outbound reply →
 *     Slow-first-reply + Speed-to-Lead surfaces light up.
 *   - qualified leads with no tour row → Tour-booking surface lights up.
 *   - tour_scheduled rows in `scheduled` (unconfirmed) status → Tour
 *     Confirmation queue lights up.
 *   - lost leads with `lost_reason.reason = 'ghosted' | 'priced_out'`
 *     past the cooling window → Reactivation queue lights up.
 *   - booked leads with attribution + budget → Booked Revenue by
 *     Source card and Attribution Performance card light up.
 *
 * Every row carries `metadata.demo_seed = true` (where the table has
 * a metadata column) so `resetExistingDemoData` cleans only its own
 * data. Tables without metadata (knowledge_base, tour_availability,
 * tour_blackouts) are seeded conservatively (only when empty) and
 * never deleted by reset — see the per-section comments.
 *
 * `server-only` — bypasses RLS via service-role client. Callers MUST
 * gate access (`requireAdmin()` + tenant venueId match).
 */

// ──────────────────────────────────────────────────────────────────────
//  Public types
// ──────────────────────────────────────────────────────────────────────

export const REVENUE_RECOVERY_DEMO_VERSION = 'gtm_0a' as const

export interface SeedRevenueRecoveryDemoArgs {
  venueId: string
  actorUserId: string
  /** When true, delete every previously-seeded gtm_0a row before
   *  re-seeding. Tables without a metadata column are NOT touched —
   *  the warnings array records those skips. */
  resetExistingDemoData?: boolean
  /** Override clock for deterministic test runs. Defaults to `now`. */
  now?: Date
  requestId?: string
}

export interface RevenueRecoverySeedResult {
  success: boolean
  venueId: string
  created: Record<string, number>
  skipped: Record<string, number>
  reset: Record<string, number>
  warnings: string[]
}

// ──────────────────────────────────────────────────────────────────────
//  Tagging helpers
// ──────────────────────────────────────────────────────────────────────

function demoMetadata(args: { actorUserId: string; nowIso: string }) {
  return {
    demo_seed: true as const,
    demo_seed_version: REVENUE_RECOVERY_DEMO_VERSION,
    demo_seeded_at: args.nowIso,
    demo_seeded_by: args.actorUserId,
  }
}

const DEMO_EMAIL_DOMAIN = 'venuerise-demo.test'

function demoEmail(slug: string): string {
  return `rr-${slug}@${DEMO_EMAIL_DOMAIN}`
}

// ──────────────────────────────────────────────────────────────────────
//  Lead fixtures
//
//  24 leads in total. `created_at_offset_hours` is BACK from `now` —
//  negative numbers are older. Hand-tuned so each leakage signal has
//  at least one obvious example without overlapping every signal on
//  every row.
//
//  Realistic budgets in USD; event_date is offset_days into the
//  FUTURE so the operator sees a real upcoming-event list.
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

interface FixtureLead {
  slug: string
  name: string
  phone: string
  stage: LeadStage
  urgency: 'low' | 'medium' | 'high' | 'critical'
  lead_score: number
  ai_active: boolean
  source: string
  source_label: SourceLabel
  /** UTM-shaped attribution payload. We always set `source_label`
   *  separately above so the AttributionPerformanceCard groups
   *  rows reliably even when utm_source is missing. */
  utm: {
    source?: string | null
    medium?: string | null
    campaign?: string | null
    landing_page?: string | null
    referrer?: string | null
    gclid?: string | null
    fbclid?: string | null
    msclkid?: string | null
    ttclid?: string | null
    channel_type?: string | null
  }
  event_date_days_out: number
  guest_count: number
  budget: number
  notes: string
  created_at_offset_hours: number
  lost_reason?: LostReasonKey
  /** When true, build a conversation thread for this lead. */
  conversation?: ConversationSpec
  /** When provided, attach a tour. */
  tour?: TourSpec
}

interface MessageSpec {
  role: 'lead' | 'ai' | 'human' | 'system'
  content: string
  offset_hours: number
  channel_type?: string
  parse_review?: boolean
  parse_confidence?: number
  parse_confidence_reasons?: string[]
  manual_reply?: boolean
}

interface ConversationSpec {
  channel_type:
    | 'website'
    | 'instagram'
    | 'the_knot'
    | 'weddingwire'
    | 'meta_lead_ads'
    | 'email'
  sentiment: 'positive' | 'neutral' | 'negative' | 'urgent'
  messages: MessageSpec[]
}

interface TourSpec {
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'
  scheduled_at_days_out: number
  duration_minutes?: number
  outcome?: string
  location_notes?: string
}

/**
 * 24 leads spanning every stage + every Revenue OS signal at least
 * once. Hand-tuned hours/days offsets so the demo dashboard is
 * busy but readable.
 */
const FIXTURE_LEADS: FixtureLead[] = [
  // ── new_inquiry — slow first reply candidates ──────────────────────
  {
    slug: 'slow-reply-google-ads',
    name: 'Madison Reyes',
    phone: '+1 (415) 555-0211',
    stage: 'new_inquiry',
    urgency: 'high',
    lead_score: 78,
    ai_active: true,
    source: 'google_ads',
    source_label: 'Google Ads',
    utm: {
      source: 'google',
      medium: 'cpc',
      campaign: 'spring-2026-wedding',
      gclid: 'CjwKCAiA9demo-gclid-1',
      landing_page: '/venue/garden',
      channel_type: 'website',
    },
    event_date_days_out: 240,
    guest_count: 180,
    budget: 28_500,
    notes: 'Spring 2026 garden ceremony. Asked about open Saturdays.',
    created_at_offset_hours: -7,
    conversation: {
      channel_type: 'website',
      sentiment: 'positive',
      messages: [
        {
          role: 'lead',
          content:
            "Hi! We're looking at May 16, 2026 for ~180 guests. Are you open and what does pricing look like?",
          offset_hours: -7,
          channel_type: 'website',
        },
      ],
    },
  },
  {
    slug: 'slow-reply-instagram',
    name: 'Aisha Brooks',
    phone: '+1 (310) 555-0173',
    stage: 'new_inquiry',
    urgency: 'medium',
    lead_score: 72,
    ai_active: true,
    source: 'instagram',
    source_label: 'Instagram',
    utm: {
      source: 'instagram',
      medium: 'social',
      campaign: 'organic',
      channel_type: 'instagram',
    },
    event_date_days_out: 195,
    guest_count: 120,
    budget: 22_000,
    notes: 'DM from Instagram. Loves the rooftop. Asked about pricing tiers.',
    created_at_offset_hours: -36,
    conversation: {
      channel_type: 'instagram',
      sentiment: 'positive',
      messages: [
        {
          role: 'lead',
          content:
            'Saw your rooftop on IG — gorgeous! What does a Saturday night in March 2026 look like, all-in?',
          offset_hours: -36,
          channel_type: 'instagram',
          manual_reply: true,
        },
      ],
    },
  },
  {
    slug: 'slow-reply-meta-ads',
    name: 'Tyler Nguyen',
    phone: '+1 (646) 555-0429',
    stage: 'new_inquiry',
    urgency: 'medium',
    lead_score: 55,
    ai_active: true,
    source: 'meta_lead_ads',
    source_label: 'Meta Ads',
    utm: {
      source: 'meta',
      medium: 'paid_social',
      campaign: 'wedding-q1',
      fbclid: 'IwAR0-demo-fbclid-1',
      channel_type: 'meta_lead_ads',
    },
    event_date_days_out: 320,
    guest_count: 90,
    budget: 14_500,
    notes:
      'Meta lead ad — thin form fields. Parse needs review (budget/guest_count guessed).',
    created_at_offset_hours: -28,
    conversation: {
      channel_type: 'meta_lead_ads',
      sentiment: 'neutral',
      messages: [
        {
          role: 'lead',
          content:
            'Interested in wedding venue. October 2026, around 90 people.',
          offset_hours: -28,
          channel_type: 'meta_lead_ads',
          parse_review: true,
          parse_confidence: 0.62,
          parse_confidence_reasons: [
            'budget_guessed_from_guest_count',
            'event_date_below_threshold',
          ],
          manual_reply: true,
        },
      ],
    },
  },
  {
    slug: 'new-the-knot-saturday',
    name: 'Sophia Patel',
    phone: '+1 (212) 555-0317',
    stage: 'new_inquiry',
    urgency: 'high',
    lead_score: 83,
    ai_active: true,
    source: 'the_knot',
    source_label: 'The Knot',
    utm: {
      source: 'the_knot',
      medium: 'directory',
      campaign: 'organic',
      channel_type: 'the_knot',
    },
    event_date_days_out: 165,
    guest_count: 220,
    budget: 32_000,
    notes:
      'High-fit. Wants Saturday in March 2026. Asked specifically about open Saturdays.',
    created_at_offset_hours: -14,
    conversation: {
      channel_type: 'the_knot',
      sentiment: 'positive',
      messages: [
        {
          role: 'lead',
          content:
            "Hi — I saw your listing on The Knot. We're 220 guests, March 14, 2026 Saturday. Is that date open and can you send pricing?",
          offset_hours: -14,
          channel_type: 'the_knot',
          manual_reply: true,
        },
      ],
    },
  },
  {
    slug: 'new-weddingwire-catering',
    name: 'Olivia Chen',
    phone: '+1 (323) 555-0184',
    stage: 'new_inquiry',
    urgency: 'medium',
    lead_score: 68,
    ai_active: true,
    source: 'weddingwire',
    source_label: 'WeddingWire',
    utm: {
      source: 'weddingwire',
      medium: 'directory',
      channel_type: 'weddingwire',
    },
    event_date_days_out: 280,
    guest_count: 140,
    budget: 19_000,
    notes:
      'WeddingWire inquiry. Asked about in-house catering and vegetarian options.',
    created_at_offset_hours: -52,
    conversation: {
      channel_type: 'weddingwire',
      sentiment: 'positive',
      messages: [
        {
          role: 'lead',
          content:
            "Hi! Found you on WeddingWire. Do you cater in-house and what's the per-plate cost for ~140 guests with a vegetarian option?",
          offset_hours: -52,
          channel_type: 'weddingwire',
          manual_reply: true,
        },
      ],
    },
  },

  // ── qualified — high-fit idle / no tour booked ─────────────────────
  {
    slug: 'qualified-high-fit-no-tour',
    name: 'Emma Thompson',
    phone: '+1 (408) 555-0299',
    stage: 'qualified',
    urgency: 'high',
    lead_score: 92,
    ai_active: true,
    source: 'google_ads',
    source_label: 'Google Ads',
    utm: {
      source: 'google',
      medium: 'cpc',
      campaign: 'spring-2026-wedding',
      gclid: 'CjwKCAiA9demo-gclid-2',
      channel_type: 'website',
    },
    event_date_days_out: 175,
    guest_count: 160,
    budget: 26_000,
    notes:
      'High-fit. Said “loved the rooftop” + asked about open Saturdays + paid-search. Sitting in qualified — no tour yet.',
    created_at_offset_hours: -120,
    conversation: {
      channel_type: 'website',
      sentiment: 'positive',
      messages: [
        {
          role: 'lead',
          content:
            'Loved the rooftop photos. We have ~160 guests, budget around $26k. Can we tour soon?',
          offset_hours: -120,
          channel_type: 'website',
        },
        {
          role: 'ai',
          content:
            "Thanks Emma — we'd love to host you. I can offer Tuesday 11am or Saturday 10am next week. Which works?",
          offset_hours: -118,
          channel_type: 'website',
        },
        {
          role: 'lead',
          content: 'Saturday 10am works. Send the calendar invite!',
          offset_hours: -114,
          channel_type: 'website',
        },
      ],
    },
  },
  {
    slug: 'qualified-website-budget-question',
    name: 'James Rivera',
    phone: '+1 (646) 555-0521',
    stage: 'qualified',
    urgency: 'medium',
    lead_score: 71,
    ai_active: true,
    source: 'website',
    source_label: 'Website',
    utm: {
      source: 'direct',
      medium: 'direct',
      channel_type: 'website',
    },
    event_date_days_out: 210,
    guest_count: 110,
    budget: 17_500,
    notes:
      'Asked for packages PDF. Replied once, no follow-up scheduled — sitting on the qualified column.',
    created_at_offset_hours: -200,
    conversation: {
      channel_type: 'website',
      sentiment: 'neutral',
      messages: [
        {
          role: 'lead',
          content: 'Can you send me a packages PDF?',
          offset_hours: -200,
          channel_type: 'website',
        },
        {
          role: 'human',
          content:
            "Sent. Let me know if you have questions and we'll book a tour.",
          offset_hours: -198,
          channel_type: 'website',
        },
      ],
    },
  },
  {
    slug: 'qualified-referral-friend',
    name: 'Hannah Lewis',
    phone: '+1 (415) 555-0712',
    stage: 'qualified',
    urgency: 'medium',
    lead_score: 75,
    ai_active: true,
    source: 'referral',
    source_label: 'Referral',
    utm: {
      source: 'referral',
      medium: 'word_of_mouth',
      channel_type: 'website',
    },
    event_date_days_out: 290,
    guest_count: 130,
    budget: 21_000,
    notes:
      'Friend of a past client. Warm — schedule a tour ASAP.',
    created_at_offset_hours: -84,
    conversation: {
      channel_type: 'website',
      sentiment: 'positive',
      messages: [
        {
          role: 'lead',
          content:
            'Hi — my friend Sara had her wedding with you last fall and recommended you. October-ish 2026, ~130 guests.',
          offset_hours: -84,
          channel_type: 'website',
        },
      ],
    },
  },
  {
    slug: 'qualified-meta-cold',
    name: 'Daniel Walsh',
    phone: '+1 (917) 555-0188',
    stage: 'qualified',
    urgency: 'low',
    lead_score: 58,
    ai_active: true,
    source: 'meta_lead_ads',
    source_label: 'Meta Ads',
    utm: {
      source: 'meta',
      medium: 'paid_social',
      fbclid: 'IwAR0-demo-fbclid-2',
      channel_type: 'meta_lead_ads',
    },
    event_date_days_out: 360,
    guest_count: 75,
    budget: 11_000,
    notes:
      'Low-fit by budget. Replied once 7 days ago, no follow-up since.',
    created_at_offset_hours: -240,
    conversation: {
      channel_type: 'meta_lead_ads',
      sentiment: 'neutral',
      messages: [
        {
          role: 'lead',
          content: 'Looking at fall 2026 — small wedding, around 75 people.',
          offset_hours: -240,
          channel_type: 'meta_lead_ads',
          manual_reply: true,
        },
      ],
    },
  },
  {
    slug: 'qualified-tk-direct-saturdays',
    name: 'Ava Morgan',
    phone: '+1 (213) 555-0640',
    stage: 'qualified',
    urgency: 'high',
    lead_score: 84,
    ai_active: true,
    source: 'the_knot',
    source_label: 'The Knot',
    utm: {
      source: 'the_knot',
      medium: 'directory',
      channel_type: 'the_knot',
    },
    event_date_days_out: 200,
    guest_count: 165,
    budget: 24_500,
    notes:
      'Asked about all open Saturdays in April–May 2026.',
    created_at_offset_hours: -96,
    conversation: {
      channel_type: 'the_knot',
      sentiment: 'positive',
      messages: [
        {
          role: 'lead',
          content:
            'Hi! Which Saturdays in April and May 2026 do you still have open?',
          offset_hours: -96,
          channel_type: 'the_knot',
          manual_reply: true,
        },
      ],
    },
  },

  // ── tour_scheduled — confirmation queue + already confirmed ────────
  {
    slug: 'tour-scheduled-unconfirmed-1',
    name: 'Liam Carter',
    phone: '+1 (650) 555-0118',
    stage: 'tour_scheduled',
    urgency: 'high',
    lead_score: 80,
    ai_active: true,
    source: 'google_ads',
    source_label: 'Google Ads',
    utm: {
      source: 'google',
      medium: 'cpc',
      campaign: 'spring-2026-wedding',
      gclid: 'CjwKCAiA9demo-gclid-3',
      channel_type: 'website',
    },
    event_date_days_out: 220,
    guest_count: 150,
    budget: 23_500,
    notes:
      'Booked a tour for next week. Not yet confirmed — Tour Confirmation queue should pick this up.',
    created_at_offset_hours: -72,
    tour: {
      status: 'scheduled',
      scheduled_at_days_out: 6,
      duration_minutes: 60,
    },
  },
  {
    slug: 'tour-scheduled-unconfirmed-2',
    name: 'Grace Mitchell',
    phone: '+1 (510) 555-0364',
    stage: 'tour_scheduled',
    urgency: 'medium',
    lead_score: 76,
    ai_active: true,
    source: 'weddingwire',
    source_label: 'WeddingWire',
    utm: {
      source: 'weddingwire',
      medium: 'directory',
      channel_type: 'weddingwire',
    },
    event_date_days_out: 260,
    guest_count: 120,
    budget: 18_000,
    notes: 'Tour next Tuesday at 11am — unconfirmed.',
    created_at_offset_hours: -110,
    tour: {
      status: 'scheduled',
      scheduled_at_days_out: 9,
      duration_minutes: 60,
    },
  },
  {
    slug: 'tour-confirmed-soon',
    name: 'Noah Bennett',
    phone: '+1 (415) 555-0922',
    stage: 'tour_scheduled',
    urgency: 'high',
    lead_score: 87,
    ai_active: true,
    source: 'referral',
    source_label: 'Referral',
    utm: {
      source: 'referral',
      medium: 'word_of_mouth',
      channel_type: 'website',
    },
    event_date_days_out: 200,
    guest_count: 175,
    budget: 27_500,
    notes: 'Confirmed tour Saturday morning. High-fit.',
    created_at_offset_hours: -168,
    tour: {
      status: 'confirmed',
      scheduled_at_days_out: 4,
      duration_minutes: 75,
    },
  },
  {
    slug: 'tour-confirmed-next-week',
    name: 'Charlotte Kim',
    phone: '+1 (213) 555-0277',
    stage: 'tour_scheduled',
    urgency: 'medium',
    lead_score: 79,
    ai_active: true,
    source: 'the_knot',
    source_label: 'The Knot',
    utm: {
      source: 'the_knot',
      medium: 'directory',
      channel_type: 'the_knot',
    },
    event_date_days_out: 250,
    guest_count: 145,
    budget: 22_500,
    notes: 'Confirmed Thursday 2pm.',
    created_at_offset_hours: -144,
    tour: {
      status: 'confirmed',
      scheduled_at_days_out: 11,
      duration_minutes: 60,
    },
  },

  // ── tour_completed — one needs next step, one is moving ───────────
  {
    slug: 'tour-completed-no-next-step',
    name: 'Ethan Park',
    phone: '+1 (646) 555-0813',
    stage: 'tour_completed',
    urgency: 'medium',
    lead_score: 70,
    ai_active: true,
    source: 'website',
    source_label: 'Website',
    utm: {
      source: 'direct',
      medium: 'direct',
      channel_type: 'website',
    },
    event_date_days_out: 220,
    guest_count: 110,
    budget: 18_500,
    notes:
      'Toured Tuesday — no follow-up scheduled. Tour-booking helper should flag.',
    created_at_offset_hours: -240,
    tour: {
      status: 'completed',
      scheduled_at_days_out: -3,
      duration_minutes: 60,
      outcome: 'walked through both ceremony spaces',
    },
  },
  {
    slug: 'tour-completed-warm',
    name: 'Mia Sanders',
    phone: '+1 (323) 555-0501',
    stage: 'tour_completed',
    urgency: 'high',
    lead_score: 88,
    ai_active: true,
    source: 'instagram',
    source_label: 'Instagram',
    utm: {
      source: 'instagram',
      medium: 'social',
      channel_type: 'instagram',
    },
    event_date_days_out: 195,
    guest_count: 160,
    budget: 25_500,
    notes:
      'Toured Saturday with both partners + their parents. Requested a proposal.',
    created_at_offset_hours: -120,
    tour: {
      status: 'completed',
      scheduled_at_days_out: -5,
      duration_minutes: 90,
      outcome:
        'family present; requested proposal; favored the garden ceremony',
    },
  },

  // ── negotiation — one moving, one stale ───────────────────────────
  {
    slug: 'negotiation-stale',
    name: 'Lucas Foster',
    phone: '+1 (415) 555-0608',
    stage: 'negotiation',
    urgency: 'medium',
    lead_score: 74,
    ai_active: true,
    source: 'google_ads',
    source_label: 'Google Ads',
    utm: {
      source: 'google',
      medium: 'cpc',
      campaign: 'spring-2026-wedding',
      gclid: 'CjwKCAiA9demo-gclid-4',
      channel_type: 'website',
    },
    event_date_days_out: 180,
    guest_count: 140,
    budget: 24_000,
    notes:
      'Proposal sent two weeks ago. No reply since — stale negotiation.',
    created_at_offset_hours: -360,
    conversation: {
      channel_type: 'email',
      sentiment: 'neutral',
      messages: [
        {
          role: 'human',
          content:
            'Hi Lucas — proposal attached. Let us know if the May 16 date works and the all-in number lands.',
          offset_hours: -336,
          channel_type: 'email',
          manual_reply: true,
        },
      ],
    },
  },

  // ── booked — driving the Booked Revenue by Source card ────────────
  {
    slug: 'booked-google-ads',
    name: 'Isabella Rossi',
    phone: '+1 (415) 555-0901',
    stage: 'booked',
    urgency: 'high',
    lead_score: 95,
    ai_active: false,
    source: 'google_ads',
    source_label: 'Google Ads',
    utm: {
      source: 'google',
      medium: 'cpc',
      campaign: 'spring-2026-wedding',
      gclid: 'CjwKCAiA9demo-gclid-5',
      channel_type: 'website',
    },
    event_date_days_out: 95,
    guest_count: 200,
    budget: 33_500,
    notes:
      'Booked. Contract signed last week. Saturday in 95 days, 200 guests.',
    created_at_offset_hours: -720,
    tour: {
      status: 'completed',
      scheduled_at_days_out: -28,
      duration_minutes: 75,
      outcome: 'closed',
    },
  },
  {
    slug: 'booked-the-knot',
    name: 'Ryan O’Connor',
    phone: '+1 (212) 555-0432',
    stage: 'booked',
    urgency: 'high',
    lead_score: 93,
    ai_active: false,
    source: 'the_knot',
    source_label: 'The Knot',
    utm: {
      source: 'the_knot',
      medium: 'directory',
      channel_type: 'the_knot',
    },
    event_date_days_out: 140,
    guest_count: 165,
    budget: 27_500,
    notes: 'Booked via The Knot inquiry. May 2026.',
    created_at_offset_hours: -640,
    tour: {
      status: 'completed',
      scheduled_at_days_out: -42,
      duration_minutes: 60,
      outcome: 'closed',
    },
  },
  {
    slug: 'booked-referral',
    name: 'Zoe Anderson',
    phone: '+1 (510) 555-0117',
    stage: 'booked',
    urgency: 'high',
    lead_score: 90,
    ai_active: false,
    source: 'referral',
    source_label: 'Referral',
    utm: {
      source: 'referral',
      medium: 'word_of_mouth',
      channel_type: 'website',
    },
    event_date_days_out: 60,
    guest_count: 135,
    budget: 21_500,
    notes:
      'Referral booking — past-client recommendation. Short timeline.',
    created_at_offset_hours: -480,
    tour: {
      status: 'completed',
      scheduled_at_days_out: -21,
      duration_minutes: 60,
      outcome: 'closed',
    },
  },

  // ── lost — reactivation candidates + non-candidates ───────────────
  {
    slug: 'lost-ghosted-reactivation',
    name: 'Ben Carter',
    phone: '+1 (646) 555-0119',
    stage: 'lost',
    urgency: 'medium',
    lead_score: 65,
    ai_active: false,
    source: 'meta_lead_ads',
    source_label: 'Meta Ads',
    utm: {
      source: 'meta',
      medium: 'paid_social',
      fbclid: 'IwAR0-demo-fbclid-3',
      channel_type: 'meta_lead_ads',
    },
    event_date_days_out: 310,
    guest_count: 105,
    budget: 16_000,
    notes:
      'Ghosted ~70 days ago after we sent pricing. Reactivation candidate.',
    created_at_offset_hours: -2_400,
    lost_reason: 'ghosted',
    conversation: {
      channel_type: 'meta_lead_ads',
      sentiment: 'neutral',
      messages: [
        {
          role: 'lead',
          content: 'Interested in pricing for fall 2026, ~105 guests.',
          offset_hours: -2_400,
          channel_type: 'meta_lead_ads',
          manual_reply: true,
        },
        {
          role: 'human',
          content:
            'Hi Ben — sent over pricing + a one-pager. Let me know when works for a tour.',
          offset_hours: -2_300,
          channel_type: 'email',
          manual_reply: true,
        },
      ],
    },
  },
  {
    slug: 'lost-priced-out',
    name: 'Natalie Brooks',
    phone: '+1 (415) 555-0688',
    stage: 'lost',
    urgency: 'low',
    lead_score: 50,
    ai_active: false,
    source: 'website',
    source_label: 'Website',
    utm: {
      source: 'direct',
      medium: 'direct',
      channel_type: 'website',
    },
    event_date_days_out: 270,
    guest_count: 80,
    budget: 9_500,
    notes:
      'Priced out — budget was $9.5k for a Saturday. Possible reactivation if we offer a Friday.',
    created_at_offset_hours: -1_900,
    lost_reason: 'priced_out',
  },
  {
    slug: 'lost-picked-competitor',
    name: 'Jacob Reilly',
    phone: '+1 (213) 555-0734',
    stage: 'lost',
    urgency: 'medium',
    lead_score: 60,
    ai_active: false,
    source: 'weddingwire',
    source_label: 'WeddingWire',
    utm: {
      source: 'weddingwire',
      medium: 'directory',
      channel_type: 'weddingwire',
    },
    event_date_days_out: 150,
    guest_count: 200,
    budget: 24_500,
    notes:
      'Picked a competitor venue. Not a reactivation candidate.',
    created_at_offset_hours: -2_100,
    lost_reason: 'picked_competitor',
  },
]

// ──────────────────────────────────────────────────────────────────────
//  Knowledge base fixtures (only when table is empty for this venue)
// ──────────────────────────────────────────────────────────────────────

const FIXTURE_KB: ReadonlyArray<{
  category: string
  title: string
  content: string
  priority: number
}> = [
  {
    category: 'Pricing',
    title: 'Pricing overview',
    content:
      'Saturday packages start at $18,000 for up to 100 guests and scale to $35,000 for 200+. Fridays + Sundays are 30% off the Saturday rate. Includes 8 hours of venue use, tables/chairs/linens, and on-site coordinator.',
    priority: 95,
  },
  {
    category: 'Policies',
    title: 'Tour availability policy',
    content:
      'Tours run Tuesday + Thursday 10am–6pm and Saturday 9am–2pm. Each tour is ~60 minutes. We hold the date for 5 business days after the tour — after that the date releases.',
    priority: 90,
  },
  {
    category: 'Catering',
    title: 'In-house catering policy',
    content:
      'We cater in-house. Plated dinners start at $95/person, buffet at $75/person. Vegetarian, vegan, and gluten-free options included. Outside caterers permitted with a $1,500 fee and proof of insurance.',
    priority: 85,
  },
  {
    category: 'Policies',
    title: 'Alcohol + outside vendor policy',
    content:
      'Bar packages start at $42/person for 4 hours. We are the only licensed bar service on-site. Outside florists, photographers, and DJs are welcome from our preferred-vendor list.',
    priority: 80,
  },
  {
    category: 'Amenities',
    title: 'Parking + location',
    content:
      '120 on-site parking spaces. Free valet for events over 150 guests. 5 minutes from downtown, 25 minutes from the airport. Hotel block discounts available at three nearby properties.',
    priority: 75,
  },
  {
    category: 'Policies',
    title: 'Outdoor ceremony rain plan',
    content:
      'Outdoor ceremonies move under the covered patio (capacity 220) at the operator’s call by 10am day-of. No charge for the rain-plan switch. The reception space is unaffected.',
    priority: 70,
  },
]

// ──────────────────────────────────────────────────────────────────────
//  Channel connection fixtures
// ──────────────────────────────────────────────────────────────────────

const FIXTURE_CHANNELS: ReadonlyArray<{
  channel_type:
    | 'website'
    | 'instagram'
    | 'the_knot'
    | 'weddingwire'
    | 'meta_lead_ads'
  status: 'connected' | 'manual_only'
  external_account_label: string
}> = [
  {
    channel_type: 'website',
    status: 'connected',
    external_account_label: 'Website widget',
  },
  {
    channel_type: 'instagram',
    status: 'manual_only',
    external_account_label: 'Instagram DMs',
  },
  {
    channel_type: 'the_knot',
    status: 'manual_only',
    external_account_label: 'The Knot listing',
  },
  {
    channel_type: 'weddingwire',
    status: 'manual_only',
    external_account_label: 'WeddingWire listing',
  },
  {
    channel_type: 'meta_lead_ads',
    status: 'manual_only',
    external_account_label: 'Meta Lead Ads',
  },
]

// ──────────────────────────────────────────────────────────────────────
//  Main entry point
// ──────────────────────────────────────────────────────────────────────

export async function seedRevenueRecoveryDemo(
  args: SeedRevenueRecoveryDemoArgs
): Promise<RevenueRecoverySeedResult> {
  const now = args.now ?? new Date()
  const nowIso = now.toISOString()
  const tag = demoMetadata({ actorUserId: args.actorUserId, nowIso })
  const svc = createServiceClient()
  const reqLog = log.child({
    requestId: args.requestId,
    venueId: args.venueId,
    op: 'demo.revenue_recovery.seed',
  })

  const created: Record<string, number> = {
    leads: 0,
    conversations: 0,
    messages: 0,
    tours: 0,
    channel_connections: 0,
    knowledge_base: 0,
    tour_availability: 0,
    tour_blackouts: 0,
  }
  const skipped: Record<string, number> = {
    knowledge_base: 0,
    tour_availability: 0,
    tour_blackouts: 0,
  }
  const reset: Record<string, number> = {
    leads: 0,
    channel_connections: 0,
  }
  const warnings: string[] = []

  // ── Step 1 — reset existing demo rows when requested ──────────────
  if (args.resetExistingDemoData) {
    try {
      const { data: leadIds } = await svc
        .from('leads')
        .select('id')
        .eq('venue_id', args.venueId)
        .eq('metadata->>demo_seed', 'true')
      const ids = (leadIds ?? []).map((r) => (r as { id: string }).id)
      if (ids.length > 0) {
        // Cascades from leads handle conversations / messages / tours
        // (all `on delete cascade lead_id` per migration 001).
        const { error } = await svc
          .from('leads')
          .delete()
          .in('id', ids)
        if (error) throw error
        reset.leads = ids.length
      }
    } catch (err) {
      reqLog.error({ err }, 'demo.revenue_recovery.reset_leads_failed')
      warnings.push(
        `reset_leads_failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    try {
      const { data: connIds } = await svc
        .from('venue_channel_connections')
        .select('id')
        .eq('venue_id', args.venueId)
        .eq('metadata->>demo_seed', 'true')
      const ids = (connIds ?? []).map((r) => (r as { id: string }).id)
      if (ids.length > 0) {
        const { error } = await svc
          .from('venue_channel_connections')
          .delete()
          .in('id', ids)
        if (error) throw error
        reset.channel_connections = ids.length
      }
    } catch (err) {
      // Channel table is post-migration 037; if it doesn't exist on
      // this deploy, skip silently and warn.
      reqLog.warn({ err }, 'demo.revenue_recovery.reset_channels_failed')
      warnings.push(
        `reset_channel_connections_failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // Knowledge base, tour_availability, tour_blackouts intentionally
    // not reset — they have no metadata column to identify demo rows
    // safely. Document the limitation in warnings.
    warnings.push(
      'reset_skipped: knowledge_base, tour_availability, tour_blackouts (no metadata column to tag demo rows safely)'
    )
  }

  // ── Step 2 — insert leads + per-lead artifacts ────────────────────
  for (const fx of FIXTURE_LEADS) {
    try {
      const leadCreatedAt = new Date(
        now.getTime() + fx.created_at_offset_hours * 3_600_000
      ).toISOString()
      const eventDate = new Date(
        now.getTime() + fx.event_date_days_out * 86_400_000
      )
        .toISOString()
        .slice(0, 10)
      const attribution = {
        source: fx.utm.source ?? null,
        medium: fx.utm.medium ?? null,
        campaign: fx.utm.campaign ?? null,
        term: null,
        content: null,
        landing_page: fx.utm.landing_page ?? null,
        referrer: fx.utm.referrer ?? null,
        gclid: fx.utm.gclid ?? null,
        fbclid: fx.utm.fbclid ?? null,
        msclkid: fx.utm.msclkid ?? null,
        ttclid: fx.utm.ttclid ?? null,
        channel_type: fx.utm.channel_type ?? null,
        source_label: fx.source_label,
        captured_at: leadCreatedAt,
      }
      const leadMetadata: Record<string, unknown> = {
        ...tag,
        attribution,
      }
      if (fx.lost_reason) {
        leadMetadata.lost_reason = {
          reason: fx.lost_reason,
          recorded_at: leadCreatedAt,
        }
      }

      const { data: leadRow, error: leadErr } = await svc
        .from('leads')
        .insert({
          venue_id: args.venueId,
          name: fx.name,
          email: demoEmail(fx.slug),
          phone: fx.phone,
          stage: fx.stage,
          lead_score: fx.lead_score,
          urgency: fx.urgency,
          event_date: eventDate,
          guest_count: fx.guest_count,
          budget: fx.budget,
          source: fx.source,
          ai_active: fx.ai_active,
          notes: fx.notes,
          metadata: leadMetadata,
          created_at: leadCreatedAt,
          updated_at: leadCreatedAt,
        })
        .select('id')
        .single()
      if (leadErr) {
        warnings.push(
          `lead_insert_failed:${fx.slug}: ${leadErr.message}`
        )
        continue
      }
      const leadId = (leadRow as { id: string }).id
      created.leads += 1

      // Conversation + messages.
      if (fx.conversation) {
        const lastMsgOffset =
          fx.conversation.messages[fx.conversation.messages.length - 1]
            ?.offset_hours ?? fx.created_at_offset_hours
        const lastMsgAt = new Date(
          now.getTime() + lastMsgOffset * 3_600_000
        ).toISOString()
        const { data: convRow, error: convErr } = await svc
          .from('conversations')
          .insert({
            lead_id: leadId,
            venue_id: args.venueId,
            sentiment: fx.conversation.sentiment,
            unread_count: 0,
            last_message_at: lastMsgAt,
            created_at: leadCreatedAt,
            updated_at: lastMsgAt,
          })
          .select('id')
          .single()
        if (convErr) {
          warnings.push(
            `conversation_insert_failed:${fx.slug}: ${convErr.message}`
          )
        } else {
          const convId = (convRow as { id: string }).id
          created.conversations += 1
          for (const msg of fx.conversation.messages) {
            const msgAt = new Date(
              now.getTime() + msg.offset_hours * 3_600_000
            ).toISOString()
            const msgMetadata: Record<string, unknown> = { ...tag }
            if (msg.channel_type) msgMetadata.channel_type = msg.channel_type
            if (msg.parse_review) {
              msgMetadata.parse_needs_review = true
              msgMetadata.parse_confidence = msg.parse_confidence ?? 0.65
              msgMetadata.parse_confidence_reasons =
                msg.parse_confidence_reasons ?? []
            }
            if (msg.manual_reply) {
              msgMetadata.source = 'manual_required'
              msgMetadata.manual_reply_marked_at = msgAt
              msgMetadata.manual_reply_marked_by = args.actorUserId
            }
            const { error: msgErr } = await svc.from('messages').insert({
              conversation_id: convId,
              lead_id: leadId,
              venue_id: args.venueId,
              role: msg.role,
              content: msg.content,
              metadata: msgMetadata,
              created_at: msgAt,
            })
            if (msgErr) {
              warnings.push(
                `message_insert_failed:${fx.slug}: ${msgErr.message}`
              )
            } else {
              created.messages += 1
            }
          }
        }
      }

      // Tour row.
      if (fx.tour) {
        const tourAt = new Date(
          now.getTime() + fx.tour.scheduled_at_days_out * 86_400_000
        ).toISOString()
        const { error: tourErr } = await svc.from('tours').insert({
          lead_id: leadId,
          venue_id: args.venueId,
          scheduled_at: tourAt,
          duration_minutes: fx.tour.duration_minutes ?? 60,
          status: fx.tour.status,
          location_notes: fx.tour.location_notes ?? null,
          outcome: fx.tour.outcome ?? null,
        })
        if (tourErr) {
          warnings.push(
            `tour_insert_failed:${fx.slug}: ${tourErr.message}`
          )
        } else {
          created.tours += 1
        }
      }
    } catch (err) {
      reqLog.error({ err, slug: fx.slug }, 'demo.revenue_recovery.lead_unexpected')
      captureApiError(err, {
        requestId: args.requestId,
        route: 'demo.revenueRecoverySeed',
        venueId: args.venueId,
      })
      warnings.push(
        `lead_unexpected:${fx.slug}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // ── Step 3 — channel connections ──────────────────────────────────
  try {
    const { data: existingConns } = await svc
      .from('venue_channel_connections')
      .select('channel_type, external_account_label')
      .eq('venue_id', args.venueId)
    const existing = new Set(
      ((existingConns ?? []) as Array<{
        channel_type: string
        external_account_label: string | null
      }>).map((r) => `${r.channel_type}::${r.external_account_label ?? ''}`)
    )
    for (const ch of FIXTURE_CHANNELS) {
      const key = `${ch.channel_type}::${ch.external_account_label}`
      if (existing.has(key)) continue
      const { error } = await svc.from('venue_channel_connections').insert({
        venue_id: args.venueId,
        channel_type: ch.channel_type,
        status: ch.status,
        external_account_label: ch.external_account_label,
        metadata: { ...tag, demo_kind: 'channel_connection' },
      })
      if (error) {
        warnings.push(
          `channel_connection_insert_failed:${ch.channel_type}: ${error.message}`
        )
      } else {
        created.channel_connections += 1
      }
    }
  } catch (err) {
    reqLog.warn({ err }, 'demo.revenue_recovery.channel_connections_skipped')
    warnings.push(
      `channel_connections_skipped: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // ── Step 4 — knowledge base (only when empty) ─────────────────────
  try {
    const { data: existingKb } = await svc
      .from('knowledge_base')
      .select('id')
      .eq('venue_id', args.venueId)
      .limit(1)
    if (!existingKb || existingKb.length === 0) {
      for (const kb of FIXTURE_KB) {
        const { error } = await svc.from('knowledge_base').insert({
          venue_id: args.venueId,
          category: kb.category,
          title: kb.title,
          content: kb.content,
          priority: kb.priority,
          is_active: true,
        })
        if (error) {
          warnings.push(`kb_insert_failed:${kb.title}: ${error.message}`)
        } else {
          created.knowledge_base += 1
        }
      }
    } else {
      skipped.knowledge_base = FIXTURE_KB.length
      warnings.push(
        'kb_skipped: existing knowledge_base rows present; not overwritten (no metadata column to tag demo rows)'
      )
    }
  } catch (err) {
    reqLog.warn({ err }, 'demo.revenue_recovery.kb_skipped')
    warnings.push(
      `kb_skipped: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // ── Step 5 — tour availability (only when empty) ──────────────────
  try {
    const { data: existingAv } = await svc
      .from('tour_availability')
      .select('id')
      .eq('venue_id', args.venueId)
      .limit(1)
    if (!existingAv || existingAv.length === 0) {
      const slots = [
        { day_of_week: 2, start_time: '10:00', end_time: '16:00' }, // Tuesday
        { day_of_week: 4, start_time: '10:00', end_time: '18:00' }, // Thursday
        { day_of_week: 6, start_time: '09:00', end_time: '14:00' }, // Saturday
      ]
      for (const s of slots) {
        const { error } = await svc.from('tour_availability').insert({
          venue_id: args.venueId,
          day_of_week: s.day_of_week,
          start_time: s.start_time,
          end_time: s.end_time,
          is_active: true,
        })
        if (error) {
          warnings.push(`tour_availability_insert_failed: ${error.message}`)
        } else {
          created.tour_availability += 1
        }
      }
    } else {
      skipped.tour_availability = 3
    }
  } catch (err) {
    warnings.push(
      `tour_availability_skipped: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // ── Step 6 — one demo blackout (only when none exist) ─────────────
  try {
    const { data: existingBl } = await svc
      .from('tour_blackouts')
      .select('id')
      .eq('venue_id', args.venueId)
      .limit(1)
    if (!existingBl || existingBl.length === 0) {
      const date = new Date(now.getTime() + 60 * 86_400_000)
        .toISOString()
        .slice(0, 10)
      const { error } = await svc.from('tour_blackouts').insert({
        venue_id: args.venueId,
        date,
        reason: 'Private event (demo seed)',
      })
      if (error) {
        warnings.push(`tour_blackout_insert_failed: ${error.message}`)
      } else {
        created.tour_blackouts += 1
      }
    } else {
      skipped.tour_blackouts = 1
    }
  } catch (err) {
    warnings.push(
      `tour_blackouts_skipped: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  reqLog.info({ created, skipped, reset, warningsCount: warnings.length }, 'demo.revenue_recovery.seed_completed')

  return {
    success: true,
    venueId: args.venueId,
    created,
    skipped,
    reset,
    warnings,
  }
}
