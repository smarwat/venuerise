/**
 * Phase 8BG — WeddingWire / The Knot lead-forwarding parser.
 *
 * Deterministic, regex-first parser that accepts either:
 *   1. a structured JSON payload (`payload: Record<string, unknown>`)
 *      already cleaned by an upstream forwarding pipe
 *      (Zapier, Make, custom forwarder), OR
 *   2. a raw forwarded-text/email body (`body: string`) plus an
 *      optional `subject` line.
 *
 * Returns a normalized ParsedForwardedLead with a confidence
 * score so the operator UI can flag low-confidence rows for
 * review before the lead enters the active pipeline.
 *
 * ── Honesty contract ──────────────────────────────────────────────
 *   - NO model call. NO autonomous "AI extracts the lead" claim.
 *   - NO logging of the raw body (the caller is responsible for
 *     keeping the body out of audit / pino payloads).
 *   - Confidence reflects which fields were extracted, NOT
 *     whether the venue should accept the inquiry. A
 *     high-confidence parse can still be spam.
 *   - `parser_version` is stamped onto metadata so future parser
 *     iterations can be backfilled / reviewed.
 */

import 'server-only'

export const PARSER_VERSION = '8BG_v1'

export type ForwardingChannel = 'the_knot' | 'weddingwire'

export interface ParsedForwardedLead {
  channelType: ForwardingChannel
  externalLeadId: string | null
  name: string | null
  email: string | null
  phone: string | null
  eventDate: string | null
  guestCount: number | null
  budget: number | null
  message: string
  confidence: number
  confidenceReasons: string[]
  needsReview: boolean
  rawSubject: string | null
}

export interface ParseInput {
  channelType: ForwardingChannel
  subject?: string | null
  body?: string | null
  payload?: Record<string, unknown> | null
  externalLeadId?: string | null
}

const REVIEW_THRESHOLD = 75

const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i
const GUEST_RE =
  /\b(\d{2,4})\s*(?:guests?|attendees?|people|pax|ppl|head\s*count)\b/i
const GUEST_LABELED_RE =
  /\b(?:guest\s*count|guests?|head\s*count|attendees?)\s*[:\-]?\s*(\d{2,4})/i
const BUDGET_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d{3,8})(?:\s*(?:k|K))?/
const BUDGET_LABELED_RE =
  /\b(?:budget|spend|total\s*budget|investment)\s*[:\-]?\s*\$?\s?(\d{1,3}(?:,\d{3})+|\d{2,8})(?:\s*(?:k|K))?/i
// ISO + common US/EU human date forms.
const DATE_ISO_RE = /\b(20\d{2}-\d{2}-\d{2})\b/
const DATE_US_RE = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/
const DATE_HUMAN_RE =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?\b/i
const NAME_LABEL_RE =
  /\b(?:name|bride|groom|couple|client|customer|from)\s*[:\-]\s*([A-Z][A-Za-z'’\-]+(?:\s+[A-Z][A-Za-z'’\-]+){0,3})/

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function cleanNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,\s]/g, '')
    const n = Number(cleaned)
    if (!Number.isNaN(n) && Number.isFinite(n)) return n
  }
  return null
}

function pickFirst<T>(obj: Record<string, unknown>, keys: string[]): T | null {
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null && v !== '') return v as T
  }
  return null
}

function parseBudgetExpression(raw: string): number | null {
  // "$15K" / "15k" → 15000. "$25,000" → 25000.
  const trimmed = raw.trim()
  const k = /^(\d+(?:\.\d+)?)\s*(?:k|K)$/.exec(trimmed)
  if (k) return Math.round(parseFloat(k[1]) * 1000)
  const cleaned = trimmed.replace(/[$,\s]/g, '')
  const n = Number(cleaned)
  if (Number.isNaN(n) || !Number.isFinite(n)) return null
  return n
}

function toISODate(raw: string): string | null {
  const iso = DATE_ISO_RE.exec(raw)
  if (iso) return iso[1]
  const us = DATE_US_RE.exec(raw)
  if (us) {
    const [m, d, y] = us[1].split('/').map((p) => parseInt(p, 10))
    if (!m || !d || !y) return null
    const yr = y < 100 ? 2000 + y : y
    const dt = new Date(Date.UTC(yr, m - 1, d))
    if (Number.isNaN(dt.getTime())) return null
    return dt.toISOString().slice(0, 10)
  }
  const human = DATE_HUMAN_RE.exec(raw)
  if (human) {
    const candidate = human[0]
    const parsed = Date.parse(
      // Append a year fallback if absent so Date.parse doesn't
      // throw on "October 12".
      /\d{4}/.test(candidate) ? candidate : `${candidate}, ${new Date().getFullYear() + 1}`
    )
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString().slice(0, 10)
    }
  }
  return null
}

function extractName(body: string): string | null {
  const labeled = NAME_LABEL_RE.exec(body)
  if (labeled) return labeled[1].trim()
  return null
}

function extractEventDate(body: string): string | null {
  return toISODate(body)
}

function extractGuestCount(body: string): number | null {
  const labeled = GUEST_LABELED_RE.exec(body)
  if (labeled) {
    const n = parseInt(labeled[1], 10)
    if (!Number.isNaN(n) && n > 0 && n < 5000) return n
  }
  const inline = GUEST_RE.exec(body)
  if (inline) {
    const n = parseInt(inline[1], 10)
    if (!Number.isNaN(n) && n > 0 && n < 5000) return n
  }
  return null
}

function extractBudget(body: string): number | null {
  const labeled = BUDGET_LABELED_RE.exec(body)
  if (labeled) {
    // Re-run parseBudgetExpression on the full match so the
    // trailing `k` is honoured.
    const full = labeled[0].replace(
      /^[^$0-9]+/,
      ''
    )
    const parsed = parseBudgetExpression(full)
    if (parsed !== null && parsed >= 100) return parsed
  }
  const inline = BUDGET_RE.exec(body)
  if (inline) {
    const parsed = parseBudgetExpression(inline[0])
    if (parsed !== null && parsed >= 100) return parsed
  }
  return null
}

function extractEmail(body: string): string | null {
  const m = EMAIL_RE.exec(body)
  return m ? m[0].toLowerCase() : null
}

function extractPhone(body: string): string | null {
  const m = PHONE_RE.exec(body)
  if (!m) return null
  const digits = m[1].replace(/[^\d+]/g, '')
  if (digits.replace('+', '').length < 7) return null
  return digits
}

/**
 * Strip common forwarded-email noise from the body so the
 * regex extractors don't latch onto headers / signatures.
 */
function trimNoise(body: string): string {
  return body
    .replace(/^[>\s]+/gm, '')
    .replace(/^On .{0,80}wrote:$/gm, '')
    .replace(/-{2,}\s*Original Message\s*-{2,}/gi, '')
    .replace(/\bUnsubscribe\b.*$/i, '')
    .trim()
}

function computeConfidence(p: {
  name: string | null
  email: string | null
  phone: string | null
  eventDate: string | null
  guestCount: number | null
  budget: number | null
  message: string
}): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0
  if (p.email) {
    score += 35
    reasons.push('email_extracted')
  } else {
    reasons.push('email_missing')
  }
  if (p.message && p.message.trim().length >= 40) {
    score += 25
    reasons.push('message_body_substantive')
  } else if (p.message && p.message.trim().length > 0) {
    score += 10
    reasons.push('message_body_thin')
  } else {
    reasons.push('message_body_missing')
  }
  if (p.name) {
    score += 15
    reasons.push('name_extracted')
  } else {
    reasons.push('name_missing')
  }
  if (p.phone) {
    score += 10
    reasons.push('phone_extracted')
  }
  if (p.eventDate) {
    score += 8
    reasons.push('event_date_extracted')
  } else {
    reasons.push('event_date_missing')
  }
  if (p.guestCount) {
    score += 4
    reasons.push('guest_count_extracted')
  }
  if (p.budget) {
    score += 3
    reasons.push('budget_extracted')
  }
  if (score > 100) score = 100
  return { score, reasons }
}

/**
 * Pure parser. Accepts a structured payload (preferred) and/or
 * a raw body. Returns the normalized + scored shape. NEVER
 * throws — invalid input returns a low-confidence result with
 * `needsReview = true`.
 */
export function parseForwardedLead(input: ParseInput): ParsedForwardedLead {
  const rawSubject = cleanString(input.subject)
  const rawBody = cleanString(input.body)
  const payload = input.payload ?? null

  // 1. Pull structured fields from payload first.
  let name: string | null = null
  let email: string | null = null
  let phone: string | null = null
  let eventDate: string | null = null
  let guestCount: number | null = null
  let budget: number | null = null
  let message = ''
  let externalLeadId = cleanString(input.externalLeadId)

  if (payload) {
    name = cleanString(
      pickFirst(payload, ['name', 'full_name', 'fullname', 'contact_name', 'bride', 'couple'])
    )
    email = cleanString(
      pickFirst(payload, ['email', 'email_address', 'contact_email'])
    )?.toLowerCase() ?? null
    phone = cleanString(
      pickFirst(payload, ['phone', 'phone_number', 'contact_phone'])
    )
    const ed = pickFirst<string>(payload, ['event_date', 'wedding_date', 'date'])
    eventDate = ed ? toISODate(String(ed)) ?? cleanString(ed) : null
    const gc = pickFirst(payload, ['guest_count', 'guests', 'guestCount', 'attendees'])
    guestCount = cleanNumber(gc) ?? null
    const bg = pickFirst(payload, ['budget', 'estimated_budget', 'spend'])
    budget = cleanNumber(bg) ?? null
    const msg = pickFirst<string>(payload, ['message', 'body', 'inquiry', 'notes'])
    message = cleanString(msg) ?? ''
    externalLeadId =
      externalLeadId ??
      cleanString(
        pickFirst(payload, ['external_lead_id', 'lead_id', 'id', 'reference'])
      )
  }

  // 2. Fall back to raw-body extraction for anything missing.
  const cleanedBody = rawBody ? trimNoise(rawBody) : ''
  const haystack = [rawSubject ?? '', cleanedBody].filter(Boolean).join('\n')

  if (!email && haystack) email = extractEmail(haystack)
  if (!phone && haystack) phone = extractPhone(haystack)
  if (!eventDate && haystack) eventDate = extractEventDate(haystack)
  if (!guestCount && haystack) guestCount = extractGuestCount(haystack)
  if (!budget && haystack) budget = extractBudget(haystack)
  if (!name && haystack) name = extractName(haystack)
  if (!message && cleanedBody) message = cleanedBody

  if (!message) {
    // Last-ditch fallback so downstream insertion never fails on
    // an empty message body (the normalization helper requires
    // non-empty content).
    message = rawSubject ?? '(no message body — operator review)'
  }

  const { score, reasons } = computeConfidence({
    name,
    email,
    phone,
    eventDate,
    guestCount,
    budget,
    message,
  })

  return {
    channelType: input.channelType,
    externalLeadId,
    name,
    email,
    phone,
    eventDate,
    guestCount,
    budget,
    message,
    confidence: score,
    confidenceReasons: reasons,
    needsReview: score < REVIEW_THRESHOLD,
    rawSubject,
  }
}

/**
 * Compact metadata payload to stamp onto messages.metadata +
 * external_messages.metadata. Excludes raw body / subject so
 * the audit + log surface stays PII-light.
 */
export function buildParseMetadata(parsed: ParsedForwardedLead): {
  parser_version: string
  channel_type: ForwardingChannel
  parse_confidence: number
  parse_confidence_reasons: string[]
  parse_needs_review: boolean
} {
  return {
    parser_version: PARSER_VERSION,
    channel_type: parsed.channelType,
    parse_confidence: parsed.confidence,
    parse_confidence_reasons: parsed.confidenceReasons,
    parse_needs_review: parsed.needsReview,
  }
}
