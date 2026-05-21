/**
 * Phase 8AQ — Revenue OS settings.
 *
 * Per-venue thresholds powering the Revenue Leakage Watch + Speed-to-
 * Lead scoring layer. Persisted under `venues.metadata.revenue_os`
 * (jsonb, migration 023). Readers go through `parseRevenueOsSettings`
 * so a missing / malformed value never crashes the dashboard — every
 * field falls back to a defensible default and every numeric range is
 * clamped at the helper boundary.
 *
 * Pure module: no Supabase client, no React, no env reads. Safe to
 * import from server components, route handlers, and (Phase-future)
 * Inngest jobs alike.
 */

/**
 * Phase 8AV — Brand Voice escalation mode.
 *
 *   - `off`   — show the confidence chip on low-confidence drafts;
 *               Approve & send stays fully enabled. Pure visibility.
 *   - `warn`  — show the chip + a soft "Operator approval recommended"
 *               line; Approve & send stays clickable but the button
 *               carries a softer tone to encourage a pause.
 *   - `block` — show the chip + hard-disable Approve & send until the
 *               operator either saves an edit or regenerates to a
 *               higher-confidence draft. Reject stays available.
 */
export type BrandVoiceEscalationMode = 'off' | 'warn' | 'block'

/**
 * Phase GTM-ILR — Instant Lead Response training profile.
 *
 *   - `enabled` — flips the orchestrator between the new structured-
 *     output path and the legacy `generateConversationReply` path. ON
 *     by default. Turning OFF disables the safety-gated structured
 *     output and reverts to the unstructured first-reply prompt.
 *
 *   - `autoSendEnabled` — CRITICAL safety toggle. Default OFF. When
 *     ON, the safety gate computes an `auto_send_eligible` flag on
 *     the generated draft IF all of: confidence >= floor, no
 *     unsupported claims, no needs_human_review, and the response
 *     passes guardrails. The scaffolding does NOT actually send —
 *     no outbound integration is wired. The flag is logged to the
 *     `ai_actions` audit row so a future send pipeline can read it.
 *
 *   - `autoSendMinConfidence` — minimum FINAL confidence (0..100,
 *     default 85, range 70..100) required to mark a draft as
 *     auto-send-eligible. Independent of `brandVoiceConfidenceFloor`
 *     (which governs the operator-facing low-confidence chip).
 *
 *   - `voiceTone` / `voiceFormality` — preset hints injected into
 *     the system prompt to shape Claude's register.
 *
 *   - `preferredGreeting` / `preferredCta` — short strings the
 *     model is instructed to lean on (NOT enforce verbatim — the
 *     model can adapt to the lead's context).
 *
 *   - `phrasesToUse` / `phrasesToAvoid` — soft preferences; the
 *     prompt asks the model to honor them. Length-clamped so a
 *     pathological setting can't blow out the context.
 *
 *   - `sampleReplies` — operator-supplied examples of past replies.
 *     The single highest-leverage venue voice training input;
 *     capped at 5 to keep prompt cost bounded.
 *
 *   - `safetyNotes` — additional venue-specific rules the model
 *     should treat as binding (e.g. "never offer payment plans").
 */
export type InstantResponseVoiceTone =
  | 'warm_concierge'
  | 'luxury_formal'
  | 'friendly_casual'
  | 'short_direct'

export type InstantResponseFormality = 'casual' | 'polished' | 'luxury'

export interface InstantResponseSampleReply {
  label: string | null
  leadMessage: string
  idealResponse: string
}

export interface InstantResponseSettings {
  enabled: boolean
  autoSendEnabled: boolean
  autoSendMinConfidence: number
  voiceTone: InstantResponseVoiceTone
  voiceFormality: InstantResponseFormality
  preferredGreeting: string | null
  preferredCta: string | null
  phrasesToUse: string[]
  phrasesToAvoid: string[]
  sampleReplies: InstantResponseSampleReply[]
  safetyNotes: string[]
}

export const DEFAULT_INSTANT_RESPONSE_SETTINGS: InstantResponseSettings = {
  enabled: true,
  // Auto-send default OFF. This is a HARD product invariant —
  // never flip the default here without an explicit phase that
  // covers an outbound send integration + per-venue compliance.
  autoSendEnabled: false,
  autoSendMinConfidence: 85,
  voiceTone: 'warm_concierge',
  voiceFormality: 'polished',
  preferredGreeting: null,
  preferredCta: null,
  phrasesToUse: [],
  phrasesToAvoid: [],
  sampleReplies: [],
  safetyNotes: [],
}

// Per-string length + per-array size caps. Keep prompt cost bounded
// without moralizing about "reasonable" values.
export const INSTANT_RESPONSE_LIMITS = {
  preferredGreetingMax: 240,
  preferredCtaMax: 240,
  phraseMax: 80,
  phrasesToUseCap: 25,
  phrasesToAvoidCap: 25,
  sampleRepliesCap: 5,
  sampleReplyLabelMax: 80,
  sampleReplyLeadMessageMax: 1000,
  sampleReplyIdealResponseMax: 2000,
  safetyNoteMax: 240,
  safetyNotesCap: 10,
  autoSendMinConfidenceMin: 70,
  autoSendMinConfidenceMax: 100,
} as const

export interface RevenueOsSettings {
  /** First-reply SLA. New inquiries older than this with no outbound
   *  message count as "Slow first reply" leakage. */
  firstReplySlaMinutes: number
  /** Lead score >= this counts a lead as "high-fit" for leakage
   *  signals and per-lead chips. */
  highFitThreshold: number
  /** Hours a high-fit lead can sit without any activity before it's
   *  surfaced as "High-fit idle". */
  staleHighFitHours: number
  /** Days without an inbound `role='lead'` message before the lead is
   *  surfaced as "Cold leads to recover". */
  coldLeadDays: number
  /** Phase 8AV — minimum confidence score (0..100) a draft variant
   *  must score to render without the low-confidence affordance.
   *  Below this floor, the drawer surfaces a "Low-confidence draft"
   *  chip + the escalation gate behaves per `brandVoiceEscalationMode`. */
  brandVoiceConfidenceFloor: number
  /** Phase 8AV — what the drawer does when a draft scores below
   *  `brandVoiceConfidenceFloor`. See `BrandVoiceEscalationMode` for
   *  per-mode behavior. */
  brandVoiceEscalationMode: BrandVoiceEscalationMode
  /** Phase 8BC — default tour duration (minutes) used when the
   *  TourReadinessPanel computes slot suggestions. Pre-fills the
   *  ScheduleTourDrawer too, but the operator can override per tour. */
  tourDurationMinutes: number
  /** Phase 8BC — buffer (minutes) added AFTER every existing tour
   *  during the conflict check so back-to-back tours aren't
   *  suggested too tightly. Zero disables the buffer. */
  tourBufferMinutes: number
  /** Phase GTM-ILR — Instant Lead Response venue voice training +
   *  safety gate config. See `InstantResponseSettings` doc for the
   *  full field-by-field behavior. Defaults are conservative —
   *  enabled but auto-send OFF. */
  instantResponse: InstantResponseSettings
}

export const DEFAULT_REVENUE_OS_SETTINGS: RevenueOsSettings = {
  firstReplySlaMinutes: 60,
  highFitThreshold: 80,
  staleHighFitHours: 24,
  coldLeadDays: 14,
  // Phase 8AV — 70/100 is "modest confidence required" — enough to
  // catch the worst cases (very short variants, hedging language,
  // missing first-name) without crying wolf on every reasonable
  // draft. Venues that want a stricter posture dial up; venues that
  // want pure visibility dial mode to 'off'.
  brandVoiceConfidenceFloor: 70,
  brandVoiceEscalationMode: 'warn',
  // Phase 8BC — 60 min is the dominant industry default. Buffer 0
  // means "no buffer" (matches the Phase 8BB behavior); venues that
  // need cleanup time between tours dial it up.
  tourDurationMinutes: 60,
  tourBufferMinutes: 0,
  // Phase GTM-ILR — Instant Lead Response. Defaults are: generate a
  // draft on every new lead, never auto-send. See the
  // InstantResponseSettings doc for the per-field rationale.
  instantResponse: { ...DEFAULT_INSTANT_RESPONSE_SETTINGS },
}

// Clamp ranges. Pick generous boundaries so a venue can tune up or
// down without us moralizing about "reasonable" values, but tight
// enough that a junk payload (e.g. SLA = 9999999) can't poison the
// dashboard math.
const CLAMP_BOUNDS = {
  firstReplySlaMinutes: { min: 5, max: 240 },
  highFitThreshold: { min: 50, max: 100 },
  staleHighFitHours: { min: 1, max: 168 },
  coldLeadDays: { min: 3, max: 60 },
  // Phase 8AV — 0/100 = "never warn" / "always warn" are both
  // legal but unhelpful; we leave the full 0..100 range available
  // so a venue can dial all the way to either extreme intentionally.
  brandVoiceConfidenceFloor: { min: 0, max: 100 },
  // Phase 8BC — 15 minutes is the floor a real venue would ever
  // book (anything shorter is a walkthrough); 240 (4h) is the
  // ceiling for full venue tours including catering tasting etc.
  tourDurationMinutes: { min: 15, max: 240 },
  // Phase 8BC — 0 disables; 120 (2h) is plenty for cleanup +
  // turnover between events that share the venue same day.
  tourBufferMinutes: { min: 0, max: 120 },
} as const

const ESCALATION_MODE_VALUES = new Set<BrandVoiceEscalationMode>([
  'off',
  'warn',
  'block',
])

function clampInt(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  if (rounded < bounds.min) return bounds.min
  if (rounded > bounds.max) return bounds.max
  return rounded
}

/**
 * Read settings out of a venue's `metadata` jsonb column.
 *
 * Accepts any shape — we tolerate `null`, the entire metadata object,
 * just the `revenue_os` sub-block, or an arbitrary unknown — and
 * always return a fully-populated, clamped `RevenueOsSettings`.
 *
 * If the input is `null` / not an object / missing `revenue_os`, we
 * return the defaults verbatim (no allocation surprises).
 */
export function parseRevenueOsSettings(metadata: unknown): RevenueOsSettings {
  if (!metadata || typeof metadata !== 'object') {
    return { ...DEFAULT_REVENUE_OS_SETTINGS }
  }
  // Tolerate both "full metadata" and "just the revenue_os sub-object"
  // — callers reading directly from a row should pass the whole jsonb;
  // callers receiving a parsed sub-tree (e.g. a settings card prefill)
  // shouldn't have to wrap.
  const root = metadata as Record<string, unknown>
  const sub =
    root.revenue_os && typeof root.revenue_os === 'object'
      ? (root.revenue_os as Record<string, unknown>)
      : root
  return {
    firstReplySlaMinutes: clampInt(
      // Accept both camelCase (in-code shape) and snake_case (storage
      // shape) so a hand-crafted curl can write either successfully.
      sub.first_reply_sla_minutes ?? sub.firstReplySlaMinutes,
      DEFAULT_REVENUE_OS_SETTINGS.firstReplySlaMinutes,
      CLAMP_BOUNDS.firstReplySlaMinutes
    ),
    highFitThreshold: clampInt(
      sub.high_fit_threshold ?? sub.highFitThreshold,
      DEFAULT_REVENUE_OS_SETTINGS.highFitThreshold,
      CLAMP_BOUNDS.highFitThreshold
    ),
    staleHighFitHours: clampInt(
      sub.stale_high_fit_hours ?? sub.staleHighFitHours,
      DEFAULT_REVENUE_OS_SETTINGS.staleHighFitHours,
      CLAMP_BOUNDS.staleHighFitHours
    ),
    coldLeadDays: clampInt(
      sub.cold_lead_days ?? sub.coldLeadDays,
      DEFAULT_REVENUE_OS_SETTINGS.coldLeadDays,
      CLAMP_BOUNDS.coldLeadDays
    ),
    brandVoiceConfidenceFloor: clampInt(
      sub.brand_voice_confidence_floor ?? sub.brandVoiceConfidenceFloor,
      DEFAULT_REVENUE_OS_SETTINGS.brandVoiceConfidenceFloor,
      CLAMP_BOUNDS.brandVoiceConfidenceFloor
    ),
    brandVoiceEscalationMode: coerceEscalationMode(
      sub.brand_voice_escalation_mode ?? sub.brandVoiceEscalationMode
    ),
    tourDurationMinutes: clampInt(
      sub.tour_duration_minutes ?? sub.tourDurationMinutes,
      DEFAULT_REVENUE_OS_SETTINGS.tourDurationMinutes,
      CLAMP_BOUNDS.tourDurationMinutes
    ),
    tourBufferMinutes: clampInt(
      sub.tour_buffer_minutes ?? sub.tourBufferMinutes,
      DEFAULT_REVENUE_OS_SETTINGS.tourBufferMinutes,
      CLAMP_BOUNDS.tourBufferMinutes
    ),
    instantResponse: parseInstantResponseSettings(
      sub.instant_response ?? sub.instantResponse
    ),
  }
}

// ──────────────────────────────────────────────────────────────────────
//  Phase GTM-ILR — Instant Response parsing helpers
// ──────────────────────────────────────────────────────────────────────

const VOICE_TONE_VALUES = new Set<InstantResponseVoiceTone>([
  'warm_concierge',
  'luxury_formal',
  'friendly_casual',
  'short_direct',
])

const VOICE_FORMALITY_VALUES = new Set<InstantResponseFormality>([
  'casual',
  'polished',
  'luxury',
])

function coerceBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1) return true
  if (value === 'false' || value === 0) return false
  return fallback
}

function coerceString(
  value: unknown,
  max: number,
  fallback: string | null
): string | null {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.slice(0, max)
}

function coerceStringArray(
  value: unknown,
  itemMax: number,
  cap: number
): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length === 0) continue
    out.push(trimmed.slice(0, itemMax))
    if (out.length >= cap) break
  }
  return out
}

function coerceSampleReplies(value: unknown): InstantResponseSampleReply[] {
  if (!Array.isArray(value)) return []
  const out: InstantResponseSampleReply[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const leadMessage =
      typeof r.lead_message === 'string'
        ? r.lead_message
        : typeof r.leadMessage === 'string'
          ? r.leadMessage
          : ''
    const idealResponse =
      typeof r.ideal_response === 'string'
        ? r.ideal_response
        : typeof r.idealResponse === 'string'
          ? r.idealResponse
          : ''
    if (leadMessage.trim().length === 0 || idealResponse.trim().length === 0)
      continue
    const label =
      typeof r.label === 'string'
        ? r.label.trim().slice(0, INSTANT_RESPONSE_LIMITS.sampleReplyLabelMax)
        : null
    out.push({
      label: label && label.length > 0 ? label : null,
      leadMessage: leadMessage
        .trim()
        .slice(0, INSTANT_RESPONSE_LIMITS.sampleReplyLeadMessageMax),
      idealResponse: idealResponse
        .trim()
        .slice(0, INSTANT_RESPONSE_LIMITS.sampleReplyIdealResponseMax),
    })
    if (out.length >= INSTANT_RESPONSE_LIMITS.sampleRepliesCap) break
  }
  return out
}

function coerceVoiceTone(value: unknown): InstantResponseVoiceTone {
  if (
    typeof value === 'string' &&
    VOICE_TONE_VALUES.has(value as InstantResponseVoiceTone)
  ) {
    return value as InstantResponseVoiceTone
  }
  return DEFAULT_INSTANT_RESPONSE_SETTINGS.voiceTone
}

function coerceVoiceFormality(value: unknown): InstantResponseFormality {
  if (
    typeof value === 'string' &&
    VOICE_FORMALITY_VALUES.has(value as InstantResponseFormality)
  ) {
    return value as InstantResponseFormality
  }
  return DEFAULT_INSTANT_RESPONSE_SETTINGS.voiceFormality
}

export function parseInstantResponseSettings(
  raw: unknown
): InstantResponseSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_INSTANT_RESPONSE_SETTINGS }
  }
  const r = raw as Record<string, unknown>
  return {
    enabled: coerceBool(r.enabled, DEFAULT_INSTANT_RESPONSE_SETTINGS.enabled),
    autoSendEnabled: coerceBool(
      r.auto_send_enabled ?? r.autoSendEnabled,
      DEFAULT_INSTANT_RESPONSE_SETTINGS.autoSendEnabled
    ),
    autoSendMinConfidence: clampInt(
      r.auto_send_min_confidence ?? r.autoSendMinConfidence,
      DEFAULT_INSTANT_RESPONSE_SETTINGS.autoSendMinConfidence,
      {
        min: INSTANT_RESPONSE_LIMITS.autoSendMinConfidenceMin,
        max: INSTANT_RESPONSE_LIMITS.autoSendMinConfidenceMax,
      }
    ),
    voiceTone: coerceVoiceTone(r.voice_tone ?? r.voiceTone),
    voiceFormality: coerceVoiceFormality(r.voice_formality ?? r.voiceFormality),
    preferredGreeting: coerceString(
      r.preferred_greeting ?? r.preferredGreeting,
      INSTANT_RESPONSE_LIMITS.preferredGreetingMax,
      DEFAULT_INSTANT_RESPONSE_SETTINGS.preferredGreeting
    ),
    preferredCta: coerceString(
      r.preferred_cta ?? r.preferredCta,
      INSTANT_RESPONSE_LIMITS.preferredCtaMax,
      DEFAULT_INSTANT_RESPONSE_SETTINGS.preferredCta
    ),
    phrasesToUse: coerceStringArray(
      r.phrases_to_use ?? r.phrasesToUse,
      INSTANT_RESPONSE_LIMITS.phraseMax,
      INSTANT_RESPONSE_LIMITS.phrasesToUseCap
    ),
    phrasesToAvoid: coerceStringArray(
      r.phrases_to_avoid ?? r.phrasesToAvoid,
      INSTANT_RESPONSE_LIMITS.phraseMax,
      INSTANT_RESPONSE_LIMITS.phrasesToAvoidCap
    ),
    sampleReplies: coerceSampleReplies(r.sample_replies ?? r.sampleReplies),
    safetyNotes: coerceStringArray(
      r.safety_notes ?? r.safetyNotes,
      INSTANT_RESPONSE_LIMITS.safetyNoteMax,
      INSTANT_RESPONSE_LIMITS.safetyNotesCap
    ),
  }
}

function serializeInstantResponseSettings(
  s: InstantResponseSettings
): Record<string, unknown> {
  return {
    enabled: s.enabled,
    auto_send_enabled: s.autoSendEnabled,
    auto_send_min_confidence: s.autoSendMinConfidence,
    voice_tone: s.voiceTone,
    voice_formality: s.voiceFormality,
    preferred_greeting: s.preferredGreeting,
    preferred_cta: s.preferredCta,
    phrases_to_use: s.phrasesToUse,
    phrases_to_avoid: s.phrasesToAvoid,
    sample_replies: s.sampleReplies.map((r) => ({
      label: r.label,
      lead_message: r.leadMessage,
      ideal_response: r.idealResponse,
    })),
    safety_notes: s.safetyNotes,
  }
}

function coerceEscalationMode(value: unknown): BrandVoiceEscalationMode {
  if (
    typeof value === 'string' &&
    ESCALATION_MODE_VALUES.has(value as BrandVoiceEscalationMode)
  ) {
    return value as BrandVoiceEscalationMode
  }
  return DEFAULT_REVENUE_OS_SETTINGS.brandVoiceEscalationMode
}

/**
 * Merge a partial settings update into an existing `metadata` jsonb.
 *
 * Returns the FULL `metadata` object (not just `revenue_os`) so the
 * caller can write it back to `venues.metadata` without losing any
 * unrelated keys (e.g. a future `branding` or `feature_flags` block).
 *
 * Storage format is snake_case so the row is readable from raw SQL.
 * The in-code shape stays camelCase via `parseRevenueOsSettings`.
 *
 * Defensive: if `metadata` isn't an object, we start from an empty one.
 * Numeric values pass through the same clamp as the parser so a POST
 * with `firstReplySlaMinutes: 9999` can't smuggle a junk value past
 * the read path.
 */
/**
 * Partial update shape. Top-level fields are individually optional;
 * the nested `instantResponse` block is itself partial so a POST that
 * touches only `autoSendEnabled` doesn't have to echo every other
 * training field.
 */
export type PartialRevenueOsSettingsUpdate = Omit<
  Partial<RevenueOsSettings>,
  'instantResponse'
> & {
  instantResponse?: Partial<InstantResponseSettings>
}

export function mergeRevenueOsSettings(
  metadata: unknown,
  next: PartialRevenueOsSettingsUpdate
): Record<string, unknown> {
  const baseRoot: Record<string, unknown> =
    metadata && typeof metadata === 'object'
      ? { ...(metadata as Record<string, unknown>) }
      : {}
  // Read current to merge cleanly — we don't want a partial write to
  // wipe untouched fields back to default.
  const current = parseRevenueOsSettings(metadata)
  const merged: RevenueOsSettings = {
    firstReplySlaMinutes:
      next.firstReplySlaMinutes !== undefined
        ? clampInt(
            next.firstReplySlaMinutes,
            current.firstReplySlaMinutes,
            CLAMP_BOUNDS.firstReplySlaMinutes
          )
        : current.firstReplySlaMinutes,
    highFitThreshold:
      next.highFitThreshold !== undefined
        ? clampInt(
            next.highFitThreshold,
            current.highFitThreshold,
            CLAMP_BOUNDS.highFitThreshold
          )
        : current.highFitThreshold,
    staleHighFitHours:
      next.staleHighFitHours !== undefined
        ? clampInt(
            next.staleHighFitHours,
            current.staleHighFitHours,
            CLAMP_BOUNDS.staleHighFitHours
          )
        : current.staleHighFitHours,
    coldLeadDays:
      next.coldLeadDays !== undefined
        ? clampInt(
            next.coldLeadDays,
            current.coldLeadDays,
            CLAMP_BOUNDS.coldLeadDays
          )
        : current.coldLeadDays,
    brandVoiceConfidenceFloor:
      next.brandVoiceConfidenceFloor !== undefined
        ? clampInt(
            next.brandVoiceConfidenceFloor,
            current.brandVoiceConfidenceFloor,
            CLAMP_BOUNDS.brandVoiceConfidenceFloor
          )
        : current.brandVoiceConfidenceFloor,
    brandVoiceEscalationMode:
      next.brandVoiceEscalationMode !== undefined
        ? coerceEscalationMode(next.brandVoiceEscalationMode)
        : current.brandVoiceEscalationMode,
    tourDurationMinutes:
      next.tourDurationMinutes !== undefined
        ? clampInt(
            next.tourDurationMinutes,
            current.tourDurationMinutes,
            CLAMP_BOUNDS.tourDurationMinutes
          )
        : current.tourDurationMinutes,
    tourBufferMinutes:
      next.tourBufferMinutes !== undefined
        ? clampInt(
            next.tourBufferMinutes,
            current.tourBufferMinutes,
            CLAMP_BOUNDS.tourBufferMinutes
          )
        : current.tourBufferMinutes,
    instantResponse: mergeInstantResponseSettings(
      current.instantResponse,
      next.instantResponse
    ),
  }
  baseRoot.revenue_os = {
    first_reply_sla_minutes: merged.firstReplySlaMinutes,
    high_fit_threshold: merged.highFitThreshold,
    stale_high_fit_hours: merged.staleHighFitHours,
    cold_lead_days: merged.coldLeadDays,
    brand_voice_confidence_floor: merged.brandVoiceConfidenceFloor,
    brand_voice_escalation_mode: merged.brandVoiceEscalationMode,
    tour_duration_minutes: merged.tourDurationMinutes,
    tour_buffer_minutes: merged.tourBufferMinutes,
    instant_response: serializeInstantResponseSettings(merged.instantResponse),
  }
  return baseRoot
}

function mergeInstantResponseSettings(
  current: InstantResponseSettings,
  next: Partial<InstantResponseSettings> | undefined
): InstantResponseSettings {
  if (!next) return current
  // Each field re-runs through the same coercion/clamp the parser
  // uses, so a partial POST with junk values can't smuggle them past
  // the write boundary.
  const merged: InstantResponseSettings = {
    enabled:
      next.enabled !== undefined ? coerceBool(next.enabled, current.enabled) : current.enabled,
    autoSendEnabled:
      next.autoSendEnabled !== undefined
        ? coerceBool(next.autoSendEnabled, current.autoSendEnabled)
        : current.autoSendEnabled,
    autoSendMinConfidence:
      next.autoSendMinConfidence !== undefined
        ? clampInt(next.autoSendMinConfidence, current.autoSendMinConfidence, {
            min: INSTANT_RESPONSE_LIMITS.autoSendMinConfidenceMin,
            max: INSTANT_RESPONSE_LIMITS.autoSendMinConfidenceMax,
          })
        : current.autoSendMinConfidence,
    voiceTone:
      next.voiceTone !== undefined ? coerceVoiceTone(next.voiceTone) : current.voiceTone,
    voiceFormality:
      next.voiceFormality !== undefined
        ? coerceVoiceFormality(next.voiceFormality)
        : current.voiceFormality,
    preferredGreeting:
      next.preferredGreeting !== undefined
        ? coerceString(
            next.preferredGreeting,
            INSTANT_RESPONSE_LIMITS.preferredGreetingMax,
            current.preferredGreeting
          )
        : current.preferredGreeting,
    preferredCta:
      next.preferredCta !== undefined
        ? coerceString(
            next.preferredCta,
            INSTANT_RESPONSE_LIMITS.preferredCtaMax,
            current.preferredCta
          )
        : current.preferredCta,
    phrasesToUse:
      next.phrasesToUse !== undefined
        ? coerceStringArray(
            next.phrasesToUse,
            INSTANT_RESPONSE_LIMITS.phraseMax,
            INSTANT_RESPONSE_LIMITS.phrasesToUseCap
          )
        : current.phrasesToUse,
    phrasesToAvoid:
      next.phrasesToAvoid !== undefined
        ? coerceStringArray(
            next.phrasesToAvoid,
            INSTANT_RESPONSE_LIMITS.phraseMax,
            INSTANT_RESPONSE_LIMITS.phrasesToAvoidCap
          )
        : current.phrasesToAvoid,
    sampleReplies:
      next.sampleReplies !== undefined
        ? coerceSampleReplies(next.sampleReplies)
        : current.sampleReplies,
    safetyNotes:
      next.safetyNotes !== undefined
        ? coerceStringArray(
            next.safetyNotes,
            INSTANT_RESPONSE_LIMITS.safetyNoteMax,
            INSTANT_RESPONSE_LIMITS.safetyNotesCap
          )
        : current.safetyNotes,
  }
  return merged
}

/**
 * True iff the parsed settings exactly match the defaults. Used by
 * the admin route to report `source: 'default'` so the settings card
 * can render the "Using default" badge.
 */
export function isDefaultRevenueOsSettings(
  settings: RevenueOsSettings
): boolean {
  return (
    settings.firstReplySlaMinutes ===
      DEFAULT_REVENUE_OS_SETTINGS.firstReplySlaMinutes &&
    settings.highFitThreshold ===
      DEFAULT_REVENUE_OS_SETTINGS.highFitThreshold &&
    settings.staleHighFitHours ===
      DEFAULT_REVENUE_OS_SETTINGS.staleHighFitHours &&
    settings.coldLeadDays === DEFAULT_REVENUE_OS_SETTINGS.coldLeadDays &&
    settings.brandVoiceConfidenceFloor ===
      DEFAULT_REVENUE_OS_SETTINGS.brandVoiceConfidenceFloor &&
    settings.brandVoiceEscalationMode ===
      DEFAULT_REVENUE_OS_SETTINGS.brandVoiceEscalationMode &&
    settings.tourDurationMinutes ===
      DEFAULT_REVENUE_OS_SETTINGS.tourDurationMinutes &&
    settings.tourBufferMinutes ===
      DEFAULT_REVENUE_OS_SETTINGS.tourBufferMinutes &&
    isDefaultInstantResponseSettings(settings.instantResponse)
  )
}

function isDefaultInstantResponseSettings(s: InstantResponseSettings): boolean {
  const d = DEFAULT_INSTANT_RESPONSE_SETTINGS
  return (
    s.enabled === d.enabled &&
    s.autoSendEnabled === d.autoSendEnabled &&
    s.autoSendMinConfidence === d.autoSendMinConfidence &&
    s.voiceTone === d.voiceTone &&
    s.voiceFormality === d.voiceFormality &&
    s.preferredGreeting === d.preferredGreeting &&
    s.preferredCta === d.preferredCta &&
    s.phrasesToUse.length === 0 &&
    s.phrasesToAvoid.length === 0 &&
    s.sampleReplies.length === 0 &&
    s.safetyNotes.length === 0
  )
}

export const REVENUE_OS_CLAMP_BOUNDS = CLAMP_BOUNDS
