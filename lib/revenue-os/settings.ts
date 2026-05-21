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
export function mergeRevenueOsSettings(
  metadata: unknown,
  next: Partial<RevenueOsSettings>
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
  }
  return baseRoot
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
      DEFAULT_REVENUE_OS_SETTINGS.tourBufferMinutes
  )
}

export const REVENUE_OS_CLAMP_BOUNDS = CLAMP_BOUNDS
