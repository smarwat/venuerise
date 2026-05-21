import 'server-only'
import { anthropic, MODEL, AnthropicNotConfiguredError } from '@/lib/anthropic'
import { withAnthropicRetry } from '@/lib/anthropic-retry'
import { computeFinalConfidence } from '@/lib/revenue-os/brand-voice-calibration'
import {
  computeAutopilotDecision,
  detectDraftRiskFlags,
  type DraftRiskFlags,
} from '@/lib/revenue-os/autopilot-guardrails'
import type {
  InstantResponseSettings,
  InstantResponseSampleReply,
} from '@/lib/revenue-os/settings'
import { log } from '@/lib/log'

/**
 * Phase GTM-ILR — Instant Lead Response helper.
 *
 * Pure server-side wrapper around the Anthropic client. Reuses
 * existing brand-voice-calibration + autopilot-guardrails helpers
 * rather than duplicating the safety math.
 *
 * Contract (callers — currently `lib/agents/orchestrator.ts`):
 *
 *   - Caller has already loaded venue, lead, KB, settings.
 *   - Caller is responsible for idempotency (e.g. orchestrator's
 *     "skip if AI message already exists for this conversation").
 *   - Caller persists the result + writes the ai_actions audit row.
 *   - This helper does NOT touch Supabase. It just produces the
 *     structured response or a safe fallback.
 *
 * Failure posture:
 *   - Anthropic SDK not configured → returns `{fallbackUsed: true}` with the
 *     deterministic warm fallback. NEVER throws so lead intake never fails.
 *   - Anthropic call throws → same fallback path.
 *   - Malformed JSON from the model → strip the JSON fence and try
 *     again; if still bad, extract a plain-text response and tag
 *     `needs_human_review=true`, `confidence=55`.
 *
 * Safety contract:
 *   - `auto_send_eligible=true` REQUIRES every one of:
 *       1. settings.autoSendEnabled === true
 *       2. finalConfidence >= settings.autoSendMinConfidence
 *       3. needs_human_review === false
 *       4. unsupported_claims.length === 0
 *       5. autopilot decision === 'eligible'
 *       6. fallbackUsed === false
 *     ANY false → eligible flag is false + reason recorded.
 *   - The helper NEVER actually sends. The caller is responsible
 *     for any outbound integration; this phase ships scaffolding
 *     only.
 */

// ──────────────────────────────────────────────────────────────────────
//  Public types
// ──────────────────────────────────────────────────────────────────────

export const INSTANT_LEAD_RESPONSE_SOURCE = 'instant_lead_response' as const

export type SuggestedNextStep =
  | 'schedule_tour'
  | 'ask_clarifying_question'
  | 'team_follow_up'
  | 'send_pricing_overview'

export interface InstantLeadResponseLead {
  name: string
  email: string | null
  phone: string | null
  event_date: string | null
  guest_count: number | null
  budget: number | null
  notes: string | null
  source: string | null
  lead_score: number | null
  stage: string | null
  /** Lead's most recent inbound message text, if any. Used by the
   *  model to ground the reply in their actual question. When absent,
   *  the helper falls back to `notes` (initial inquiry). */
  most_recent_inbound_message?: string | null
}

export interface InstantLeadResponseVenue {
  name: string
  description: string | null
  capacity_min: number | null
  capacity_max: number | null
  base_price: number | null
  style_tags: string[]
  ai_persona_name: string
  ai_tone: string | null
}

export interface InstantLeadResponseKbEntry {
  category: string
  title: string
  content: string
  priority?: number | null
}

export interface InstantLeadResponseArgs {
  venue: InstantLeadResponseVenue
  lead: InstantLeadResponseLead
  knowledgeBase: InstantLeadResponseKbEntry[]
  training: InstantResponseSettings
  /** Confidence floor for the operator-facing low-confidence chip.
   *  Independent of `training.autoSendMinConfidence`. Defaults to 70. */
  brandVoiceConfidenceFloor?: number
  requestId?: string
}

export interface InstantLeadResponseResult {
  /** The drafted reply text. Always populated — fallback when needed. */
  response: string
  /** Final 0–100 confidence after brand-voice calibration. */
  confidence: number
  /** Model's self-rated confidence pre-calibration. Null if missing. */
  modelConfidence: number | null
  /** Heuristic confidence (length/greeting/etc.) from calibration helper. */
  heuristicConfidence: number | null
  /** True if the response needs operator review before sending. */
  needsHumanReview: boolean
  /** Pricing/policy/availability claims the response made that the
   *  KB doesn't support. Empty if grounded. */
  unsupportedClaims: string[]
  /** Questions the model detected the lead asking. Helps drawer
   *  surfaces "answered X, missed Y". */
  detectedQuestions: string[]
  /** Single suggested next step the dashboard can render as a CTA. */
  suggestedNextStep: SuggestedNextStep
  /** Free-form short reasons explaining the safety gate decision. */
  reasons: string[]
  /** Soft venue-context health hint from the model. */
  venueContextSignal: 'healthy' | 'needs_more_context' | null
  /** True iff the response was the deterministic safe fallback. */
  fallbackUsed: boolean
  /** True iff every safety check passed AND autoSendEnabled is ON.
   *  The caller MAY mark the draft as ready-to-send but the helper
   *  itself never sends. */
  autoSendEligible: boolean
  /** The risk flags from the autopilot-guardrails helper. */
  riskFlags: DraftRiskFlags
  /** Decision mode from the autopilot-guardrails helper. */
  autopilotMode: 'eligible' | 'review_required' | 'blocked'
  /** Wall-clock ms from helper entry to result construction. */
  latencyMs: number
  /** Model identifier. Null when the fallback path runs without ever
   *  reaching Anthropic. */
  model: string | null
  /** Total input+output tokens, or null when no model call was made. */
  tokensUsed: number | null
}

// ──────────────────────────────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────────────────────────────

const MAX_KB_ENTRIES = 8 // bound prompt size
const MAX_KB_ENTRY_CHARS = 600
const MODEL_MAX_TOKENS = 700
const MODEL_TIMEOUT_MS = 12_000

const TONE_HINTS: Record<InstantResponseSettings['voiceTone'], string> = {
  warm_concierge:
    'Warm, attentive, like a trusted concierge who knows the venue intimately. Personal touches over scripted lines.',
  luxury_formal:
    'Polished, refined, and confident. Avoid slang or contractions. Lean into the venue\'s prestige without being cold.',
  friendly_casual:
    'Conversational and friendly. Use the lead\'s first name. Light, approachable language.',
  short_direct:
    'Concise and to the point. Answer the lead\'s question first, then offer a single next step.',
}

const FORMALITY_HINTS: Record<InstantResponseSettings['voiceFormality'], string> = {
  casual: 'Casual register. Contractions are fine.',
  polished: 'Polished register. Professional but warm.',
  luxury: 'Luxury register. Elevated word choice; no slang.',
}

const SUGGESTED_NEXT_STEP_VALUES = new Set<SuggestedNextStep>([
  'schedule_tour',
  'ask_clarifying_question',
  'team_follow_up',
  'send_pricing_overview',
])

// ──────────────────────────────────────────────────────────────────────
//  KB selection — keyword-driven, bounded
// ──────────────────────────────────────────────────────────────────────

const KB_KEYWORDS: Record<string, string[]> = {
  pricing: ['price', 'pricing', 'cost', 'package', 'budget', '$', 'deposit', 'fee'],
  capacity: ['guest', 'people', 'capacity', 'attendee'],
  availability: ['date', 'available', 'saturday', 'sunday', 'weekend', 'month'],
  catering: ['cater', 'food', 'menu', 'dinner', 'plated', 'buffet', 'vegan', 'vegetarian', 'allergy'],
  alcohol: ['bar', 'alcohol', 'wine', 'beer', 'liquor', 'champagne'],
  vendors: ['vendor', 'florist', 'photographer', 'dj', 'band'],
  parking: ['park', 'parking', 'valet', 'transport'],
  tour: ['tour', 'visit', 'walkthrough', 'see the venue'],
}

function selectKbEntries(
  kb: InstantLeadResponseKbEntry[],
  leadText: string
): InstantLeadResponseKbEntry[] {
  if (kb.length === 0) return []
  const lower = (leadText ?? '').toLowerCase()
  // Score each entry by (keyword hits in lead text) + priority.
  const scored = kb.map((entry) => {
    let score = (entry.priority ?? 0) / 100
    const haystack = `${entry.category} ${entry.title}`.toLowerCase()
    for (const [topic, words] of Object.entries(KB_KEYWORDS)) {
      const leadMentions = words.some((w) => lower.includes(w))
      if (!leadMentions) continue
      if (haystack.includes(topic) || words.some((w) => haystack.includes(w))) {
        score += 5
      }
    }
    return { entry, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, MAX_KB_ENTRIES).map((s) => ({
    ...s.entry,
    content: s.entry.content.slice(0, MAX_KB_ENTRY_CHARS),
  }))
}

// ──────────────────────────────────────────────────────────────────────
//  Prompt construction
// ──────────────────────────────────────────────────────────────────────

function buildSystemPrompt(args: {
  venue: InstantLeadResponseVenue
  training: InstantResponseSettings
  kb: InstantLeadResponseKbEntry[]
}): string {
  const { venue, training, kb } = args
  const persona = venue.ai_persona_name?.trim() || 'the event coordinator'
  const voiceLine = TONE_HINTS[training.voiceTone]
  const formalityLine = FORMALITY_HINTS[training.voiceFormality]

  const greeting =
    training.preferredGreeting && training.preferredGreeting.trim().length > 0
      ? `Preferred greeting style: ${training.preferredGreeting.trim()}.`
      : ''
  const cta =
    training.preferredCta && training.preferredCta.trim().length > 0
      ? `Preferred next-step phrasing: ${training.preferredCta.trim()}. Adapt to the lead's context — do not paste verbatim.`
      : ''

  const phrasesToUse =
    training.phrasesToUse.length > 0
      ? `Prefer these phrases when relevant: ${training.phrasesToUse.map((p) => `"${p}"`).join(', ')}.`
      : ''
  const phrasesToAvoid =
    training.phrasesToAvoid.length > 0
      ? `Never use: ${training.phrasesToAvoid.map((p) => `"${p}"`).join(', ')}.`
      : ''

  const sampleBlock =
    training.sampleReplies.length > 0
      ? `\nSAMPLE PAST REPLIES from this venue's team — match their voice and structure:\n${training.sampleReplies
          .map(
            (r, i) =>
              `Example ${i + 1}${r.label ? ` (${r.label})` : ''}:\nLead said: "${r.leadMessage.slice(0, 400)}"\nTeam replied: "${r.idealResponse.slice(0, 600)}"`
          )
          .join('\n\n')}`
      : ''

  const safetyNotes =
    training.safetyNotes.length > 0
      ? `\nADDITIONAL VENUE RULES (binding):\n${training.safetyNotes.map((n) => `- ${n}`).join('\n')}`
      : ''

  const kbBlock =
    kb.length > 0
      ? `\nKNOWLEDGE BASE — only facts here are safe to state as venue facts:\n${kb
          .map((e) => `[${e.category}] ${e.title}: ${e.content}`)
          .join('\n\n')}`
      : `\nKNOWLEDGE BASE: (empty — be especially careful not to assert specific pricing, availability, or policies)`

  return [
    `You are ${persona} at ${venue.name}, replying to a new inbound wedding-venue lead.`,
    `Voice: ${voiceLine} ${formalityLine}`,
    greeting,
    cta,
    phrasesToUse,
    phrasesToAvoid,
    ``,
    `VENUE PROFILE:`,
    `- Name: ${venue.name}`,
    `- Description: ${venue.description ?? `an elegant wedding venue`}`,
    `- Capacity: ${venue.capacity_min ?? 'flexible'}–${venue.capacity_max ?? 'flexible'} guests`,
    `- Pricing guidance: ${venue.base_price ? `starting around $${venue.base_price}` : 'no exact pricing on file'}`,
    `- Style: ${venue.style_tags.length > 0 ? venue.style_tags.join(', ') : 'timeless'}`,
    sampleBlock,
    safetyNotes,
    kbBlock,
    ``,
    `HARD RULES — never violate:`,
    `1. Never say you are AI, a bot, an assistant, or automated. You are part of the venue's team.`,
    `2. Never quote exact prices unless the KB explicitly lists that exact price. Use "starting around" or invite a conversation.`,
    `3. Never guarantee a date is available unless the KB explicitly confirms availability.`,
    `4. Never promise discounts or contract terms.`,
    `5. If a policy / pricing / availability question can't be answered from the KB, say the team will confirm.`,
    `6. Always end with ONE clear next step (usually: schedule a tour).`,
    `7. Address the lead by first name.`,
    `8. 3–6 sentences. No greeting like "I hope this finds you well" — get to the point warmly.`,
    ``,
    `OUTPUT FORMAT — respond with ONLY a single JSON object, no preamble, no markdown fences, no trailing text. Keys (all required):`,
    `{`,
    `  "response": "<the drafted reply, plain text, no markdown, no quotes inside>",`,
    `  "confidence": <integer 0-100, honest self-rating of how well this reply matches venue voice + has enough context>,`,
    `  "needs_human_review": <true|false — true if pricing/availability/policy was discussed without KB grounding, OR if the lead asked something the KB doesn't cover>,`,
    `  "detected_questions": ["<question 1>", ...],`,
    `  "unsupported_claims": ["<phrase from response that lacks KB support>", ...],`,
    `  "suggested_next_step": "schedule_tour" | "ask_clarifying_question" | "team_follow_up" | "send_pricing_overview",`,
    `  "venue_context_signal": "healthy" | "needs_more_context"`,
    `}`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function buildUserPrompt(lead: InstantLeadResponseLead): string {
  const firstName = lead.name.split(/\s+/)[0] ?? lead.name
  const leadText =
    lead.most_recent_inbound_message?.trim() ||
    lead.notes?.trim() ||
    `(no message provided — they submitted a form inquiry)`
  return [
    `LEAD:`,
    `- Name: ${lead.name} (first name: ${firstName})`,
    `- Event date: ${lead.event_date ?? 'not specified'}`,
    `- Guest count: ${lead.guest_count ?? 'not specified'}`,
    `- Budget: ${lead.budget ? `$${lead.budget}` : 'not specified'}`,
    `- Source: ${lead.source ?? 'unknown'}`,
    `- Stage: ${lead.stage ?? 'new_inquiry'}`,
    `- Fit score: ${lead.lead_score ?? 'not scored'}/100`,
    ``,
    `LEAD'S MESSAGE:`,
    leadText,
    ``,
    `Draft the reply now. Return ONLY the JSON object specified above.`,
  ].join('\n')
}

// ──────────────────────────────────────────────────────────────────────
//  Defensive JSON parsing
// ──────────────────────────────────────────────────────────────────────

interface ParsedModelOutput {
  response: string
  confidence: number | null
  needs_human_review: boolean | null
  detected_questions: string[]
  unsupported_claims: string[]
  suggested_next_step: SuggestedNextStep | null
  venue_context_signal: 'healthy' | 'needs_more_context' | null
}

function tryParseModelJson(raw: string): ParsedModelOutput | null {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  // Strip code fences if present (```json ... ```).
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  }
  // Find the first { and last } — model can occasionally leak prose.
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first === -1 || last === -1 || last < first) return null
  const slice = text.slice(first, last + 1)
  let obj: unknown
  try {
    obj = JSON.parse(slice)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const r = obj as Record<string, unknown>
  const response = typeof r.response === 'string' ? r.response.trim() : ''
  if (response.length === 0) return null
  return {
    response,
    confidence: clampOptionalInt(r.confidence, 0, 100),
    needs_human_review:
      typeof r.needs_human_review === 'boolean' ? r.needs_human_review : null,
    detected_questions: coerceStrArr(r.detected_questions, 8, 240),
    unsupported_claims: coerceStrArr(r.unsupported_claims, 8, 240),
    suggested_next_step:
      typeof r.suggested_next_step === 'string' &&
      SUGGESTED_NEXT_STEP_VALUES.has(r.suggested_next_step as SuggestedNextStep)
        ? (r.suggested_next_step as SuggestedNextStep)
        : null,
    venue_context_signal:
      r.venue_context_signal === 'healthy' ||
      r.venue_context_signal === 'needs_more_context'
        ? r.venue_context_signal
        : null,
  }
}

function clampOptionalInt(
  value: unknown,
  min: number,
  max: number
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function coerceStrArr(value: unknown, cap: number, itemMax: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string') continue
    const trimmed = v.trim()
    if (trimmed.length === 0) continue
    out.push(trimmed.slice(0, itemMax))
    if (out.length >= cap) break
  }
  return out
}

// ──────────────────────────────────────────────────────────────────────
//  Fallback draft
// ──────────────────────────────────────────────────────────────────────

/**
 * Deterministic text-feature score for a draft reply, 0–100.
 *
 * Intentionally simple — mirrors the heuristic used in
 * `/api/ai/draft/route.ts` so the two paths score similarly.
 * Penalizes: hedging language, very short or very long replies,
 * missing first-name greeting, missing call-to-action. The model
 * confidence can lift this by up to +10 via `computeFinalConfidence`.
 */
function computeHeuristicConfidence(text: string): number {
  if (!text || text.trim().length === 0) return 0
  const t = text.trim()
  let score = 75
  if (t.length >= 100 && t.length <= 350) score += 5
  if (t.length < 50) score -= 10
  if (t.length > 700) score -= 10
  let hedgeHits = 0
  for (const rx of HEDGE_PATTERNS) {
    if (rx.test(t)) hedgeHits += 1
    if (hedgeHits >= 2) break
  }
  score -= hedgeHits * 15
  const opener = t.slice(0, 80)
  const hasName = /\b[A-Z][a-z]{2,}\b/.test(opener)
  if (!hasName) score -= 5
  const hasCta = CTA_PATTERNS.some((rx) => rx.test(t))
  if (!hasCta) score -= 5
  return Math.max(0, Math.min(100, score))
}

const HEDGE_PATTERNS: RegExp[] = [
  /\bi (?:think|believe|guess|suppose)\b/i,
  /\bmaybe\b/i,
  /\bperhaps\b/i,
  /\bnot sure\b/i,
  /\bsort of\b/i,
  /\bkind of\b/i,
]

const CTA_PATTERNS: RegExp[] = [
  /\btour\b/i,
  /\bschedule\b/i,
  /\bbook\b/i,
  /\bvisit\b/i,
  /\bwalk through\b/i,
  /\bcalendar\b/i,
  /\bavailability\b/i,
  /\?$/,
]

function buildFallbackResponse(
  lead: InstantLeadResponseLead,
  venue: InstantLeadResponseVenue
): string {
  const firstName = lead.name.split(/\s+/)[0] ?? lead.name
  return [
    `Hi ${firstName}, congratulations on your engagement — thank you so much for reaching out about ${venue.name}.`,
    `We'd love to learn more about your wedding and help you see if ${venue.name} is the right fit.`,
    `A member of our team will review your details and follow up shortly with availability and next steps.`,
  ].join(' ')
}

// ──────────────────────────────────────────────────────────────────────
//  Main entry point
// ──────────────────────────────────────────────────────────────────────

export async function generateInstantLeadResponse(
  args: InstantLeadResponseArgs
): Promise<InstantLeadResponseResult> {
  const startedAt = Date.now()
  const reqLog = log.child({
    requestId: args.requestId,
    op: 'ai.instant_lead_response',
    venue: args.venue.name,
  })

  const leadText =
    args.lead.most_recent_inbound_message?.trim() ||
    args.lead.notes?.trim() ||
    ''
  const kb = selectKbEntries(args.knowledgeBase ?? [], leadText)

  // Always compute fallback up front — if the model path fails at any
  // point, the response stays warm and safe.
  const fallback = buildFallbackResponse(args.lead, args.venue)

  let rawText = ''
  let model: string | null = null
  let tokensUsed: number | null = null
  let parsed: ParsedModelOutput | null = null
  let fallbackUsed = false

  try {
    const systemPrompt = buildSystemPrompt({
      venue: args.venue,
      training: args.training,
      kb,
    })
    const userPrompt = buildUserPrompt(args.lead)

    const response = await withAnthropicRetry(
      (signal) =>
        anthropic.messages.create(
          {
            model: MODEL,
            max_tokens: MODEL_MAX_TOKENS,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          },
          { signal }
        ),
      {
        agent: 'instant_lead_response',
        requestId: args.requestId,
        model: MODEL,
        timeoutMs: MODEL_TIMEOUT_MS,
      }
    )
    model = MODEL
    tokensUsed = response.usage.input_tokens + response.usage.output_tokens
    rawText = response.content[0]?.type === 'text' ? response.content[0].text : ''
    parsed = tryParseModelJson(rawText)
  } catch (err) {
    if (err instanceof AnthropicNotConfiguredError) {
      reqLog.warn(
        { fallbackUsed: true },
        'ai.instant_lead_response.anthropic_not_configured'
      )
    } else {
      reqLog.error({ err }, 'ai.instant_lead_response.model_call_failed')
    }
    fallbackUsed = true
  }

  // If the model returned text but we couldn't extract structured
  // JSON, salvage the text as the response with low confidence + force
  // human review. Better than throwing away a usable draft.
  if (!fallbackUsed && !parsed && rawText.trim().length > 0) {
    parsed = {
      response: rawText.trim().slice(0, 4000),
      confidence: 55,
      needs_human_review: true,
      detected_questions: [],
      unsupported_claims: [],
      suggested_next_step: null,
      venue_context_signal: 'needs_more_context',
    }
    reqLog.warn(
      { confidence: 55 },
      'ai.instant_lead_response.malformed_json_salvaged'
    )
  }

  // Final fallback: build the deterministic warm draft.
  const responseText = fallbackUsed || !parsed ? fallback : parsed.response
  if (!parsed) fallbackUsed = true

  // ── Confidence calibration via brand-voice-calibration helper ──────
  const modelConfidence = parsed?.confidence ?? null
  // `computeFinalConfidence(modelScore, heuristicScore)` returns a
  // single number — model is capped to heuristic+10 so a model that
  // self-rates 100 on a short hedging reply can't override the
  // deterministic floor.
  const heuristicScore = computeHeuristicConfidence(responseText)
  const finalConfidence = computeFinalConfidence(modelConfidence, heuristicScore)
  // `computeHeuristicConfidence` always returns a number (0..100), so
  // the result type is `number`, not `number | null`. The original
  // annotation was misleading — fixed during the hardening pass.
  const heuristicConfidence: number = heuristicScore

  // ── Risk flags + autopilot decision ────────────────────────────────
  const riskFlags = detectDraftRiskFlags(responseText)
  const venueContextSignal = parsed?.venue_context_signal ?? null
  const autopilotDecision = computeAutopilotDecision({
    finalConfidence,
    modelConfidence,
    heuristicConfidence,
    leadStage: args.lead.stage,
    leadScore: args.lead.lead_score,
    hasPricingQuestion: riskFlags.hasPricingQuestion,
    hasPolicyQuestion: riskFlags.hasPolicyQuestion,
    hasAvailabilityClaim: riskFlags.hasAvailabilityClaim,
    venueContextSignal,
  })

  // ── Compose needsHumanReview ───────────────────────────────────────
  const unsupportedClaims = parsed?.unsupported_claims ?? []
  const detectedQuestions = parsed?.detected_questions ?? []
  // Empty KB + risk flag fired = needs review even if model said no.
  const kbEmpty = kb.length === 0
  const modelSaysReview = parsed?.needs_human_review === true
  const guardrailsBlocked = autopilotDecision.mode === 'blocked'
  const hasUnsupported = unsupportedClaims.length > 0
  const lowConfidence =
    finalConfidence !== null &&
    finalConfidence < (args.brandVoiceConfidenceFloor ?? 70)
  const needsHumanReview =
    fallbackUsed ||
    modelSaysReview ||
    guardrailsBlocked ||
    hasUnsupported ||
    (riskFlags.hasPricingQuestion && kbEmpty) ||
    (riskFlags.hasAvailabilityClaim && kbEmpty) ||
    lowConfidence

  // ── Safety gate for auto_send_eligible ────────────────────────────
  const reasons: string[] = []
  if (fallbackUsed) reasons.push('fallback_used')
  if (modelSaysReview) reasons.push('model_flagged_review')
  if (hasUnsupported) reasons.push('unsupported_claims_present')
  if (guardrailsBlocked) reasons.push('autopilot_blocked')
  if (riskFlags.hasPricingQuestion && kbEmpty)
    reasons.push('pricing_discussed_without_kb')
  if (riskFlags.hasAvailabilityClaim && kbEmpty)
    reasons.push('availability_claimed_without_kb')
  if (lowConfidence) reasons.push('low_confidence')
  if (!args.training.autoSendEnabled) reasons.push('auto_send_disabled_setting')
  if (
    args.training.autoSendEnabled &&
    finalConfidence !== null &&
    finalConfidence < args.training.autoSendMinConfidence
  ) {
    reasons.push(
      `confidence_below_auto_send_floor:${finalConfidence}<${args.training.autoSendMinConfidence}`
    )
  }

  const autoSendEligible =
    args.training.autoSendEnabled &&
    !fallbackUsed &&
    !needsHumanReview &&
    !hasUnsupported &&
    autopilotDecision.mode === 'eligible' &&
    finalConfidence !== null &&
    finalConfidence >= args.training.autoSendMinConfidence

  const suggestedNextStep: SuggestedNextStep =
    parsed?.suggested_next_step ??
    (kbEmpty || needsHumanReview ? 'team_follow_up' : 'schedule_tour')

  const result: InstantLeadResponseResult = {
    response: responseText,
    confidence: finalConfidence ?? 50,
    modelConfidence,
    heuristicConfidence,
    needsHumanReview,
    unsupportedClaims,
    detectedQuestions,
    suggestedNextStep,
    reasons,
    venueContextSignal,
    fallbackUsed,
    autoSendEligible,
    riskFlags,
    autopilotMode: autopilotDecision.mode,
    latencyMs: Date.now() - startedAt,
    model,
    tokensUsed,
  }

  reqLog.info(
    {
      confidence: result.confidence,
      needsHumanReview: result.needsHumanReview,
      autoSendEligible: result.autoSendEligible,
      fallbackUsed: result.fallbackUsed,
      autopilotMode: result.autopilotMode,
      latencyMs: result.latencyMs,
    },
    'ai.instant_lead_response.completed'
  )

  return result
}
