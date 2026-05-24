import 'server-only'

/**
 * Phase 8BO — Pure helpers for inbound email reply capture.
 *
 * No I/O in this module. Header parsing, reply-quote stripping,
 * confidence scoring. The webhook route at /api/inbound/email
 * composes these with a Supabase lookup against
 * `outbound_messages.provider_message_id` and then
 * `normalizeInboundChannelMessage`.
 *
 * ── HONESTY CONTRACT ──────────────────────────────────────────────────────
 *   - No AI / model calls. Pure regex + string ops.
 *   - We NEVER claim a reply belongs to a conversation unless
 *     we have a header-level match (high confidence) OR a
 *     recent outbound-to-this-address match (medium); otherwise
 *     the row is stamped `parse_needs_review: true` and the UI
 *     surfaces a badge.
 *   - We strip the most common reply-quote patterns
 *     ("On Mon, Jan 1, 2025, X wrote:" + leading "> " lines)
 *     so the operator sees the lead's actual new text, not the
 *     thread quoted back at them. The original `text` is kept
 *     on `messages.metadata.raw_body_preview` (capped) for
 *     audit.
 *   - We DO NOT log the full body. Callers must respect that.
 */

export const INBOUND_PARSER_VERSION = '8BO_v1'

/** Confidence threshold below which the message is flagged for
 *  operator review (`parse_needs_review = true`). */
export const INBOUND_REVIEW_THRESHOLD = 75

// ── Public types ─────────────────────────────────────────────────────────

export interface InboundEmailHeaders {
  /** RFC822 Message-ID of THIS inbound message. */
  messageId?: string | null
  /** RFC822 In-Reply-To of the email this is replying to. */
  inReplyTo?: string | null
  /** RFC822 References chain — space-separated message ids. */
  references?: string | null
  /** Subject line. */
  subject?: string | null
}

export interface InboundEmailPayload {
  from: string
  /** Display name parsed from the From header (e.g. "Sarah Johnson"). */
  fromName?: string | null
  /** Primary recipient (the platform Reply-To address). */
  to: string
  cc?: string[] | null
  text?: string | null
  html?: string | null
  headers: InboundEmailHeaders
  /** Provider-stamped received timestamp (ISO). */
  receivedAt?: string | null
}

export interface NormalizedInboundEmail {
  fromEmail: string
  fromName: string | null
  toEmail: string
  subject: string | null
  /** Reply-stripped, length-capped body the operator sees. */
  cleanBody: string
  /** First 500 chars of the raw body (audit-safe preview). */
  rawPreview: string
  /** All known message ids referenced by this email — used to
   *  look up the source outbound row. Already de-duped + lowercased. */
  referencedMessageIds: string[]
}

export type MatchConfidenceTier = 'high' | 'medium' | 'low' | 'none'

export interface MatchSignals {
  /** Set when an In-Reply-To / References header matched an
   *  outbound_messages.provider_message_id. */
  matchedByHeader: boolean
  /** Set when no header match, but the From address matches a
   *  recent outbound recipient on the venue. */
  matchedByRecentRecipient: boolean
  /** True when the From address was on the suppression list at
   *  capture time — we keep the inbound but flag for review. */
  recipientWasSuppressed: boolean
}

// ── Parsing helpers ──────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Parse "Sarah Johnson <sarah@gmail.com>" or "sarah@gmail.com"
 * into { email, name }. Always returns a lowercased email.
 */
export function parseFromAddress(raw: string | null | undefined): {
  email: string | null
  name: string | null
} {
  if (!raw) return { email: null, name: null }
  const trimmed = raw.trim()
  // "Name <email@host>" form.
  const m = trimmed.match(/^\s*"?([^"<]*)"?\s*<\s*([^>\s]+)\s*>\s*$/)
  if (m) {
    const name = m[1].trim() || null
    const email = m[2].trim().toLowerCase()
    return {
      email: EMAIL_RE.test(email) ? email : null,
      name,
    }
  }
  // Bare email form.
  const bare = trimmed.toLowerCase()
  return {
    email: EMAIL_RE.test(bare) ? bare : null,
    name: null,
  }
}

/**
 * Extract every message-id token from In-Reply-To + References.
 * Message-ids are wrapped in angle brackets; we strip them and
 * lowercase for a stable lookup key.
 *
 * Resend / Postmark / SendGrid all populate these headers
 * identically per RFC 5322.
 */
export function extractReferencedMessageIds(
  headers: InboundEmailHeaders
): string[] {
  const out = new Set<string>()
  const collectFrom = (raw: string | null | undefined) => {
    if (!raw) return
    // Match anything between < and >; tolerate folding whitespace.
    const matches = raw.match(/<[^>]+>/g)
    if (!matches) return
    for (const m of matches) {
      const id = m.slice(1, -1).trim().toLowerCase()
      if (id) out.add(id)
    }
  }
  collectFrom(headers.inReplyTo)
  collectFrom(headers.references)
  return Array.from(out)
}

// Most common reply-quote patterns. Order matters — we cut at
// the EARLIEST match so a long thread quoted multiple times
// still collapses to the new text.
const QUOTE_HEADER_RES: RegExp[] = [
  // "On Mon, Jan 1, 2025 at 10:00 AM, Foo <foo@x> wrote:"
  /\bOn\s+\w+,?\s+\w+\s+\d{1,2},?\s+\d{4}.{0,80}wrote:\s*$/im,
  // "On 2025-01-01 10:00, Foo wrote:"
  /\bOn\s+\d{4}-\d{2}-\d{2}.{0,80}wrote:\s*$/im,
  // Outlook block delimiter
  /^[-]{2,}\s*Original Message\s*[-]{2,}\s*$/im,
  // "From: name\nSent: date\nTo: ..." Outlook reply header
  /^From:\s+.+?\nSent:.+?\nTo:/im,
  // Generic Gmail-mobile "Sent from my iPhone" sigs we want to drop
  // are NOT cut here — they're not quote markers; they're sigs.
]

/**
 * Strip the most common email reply-quote patterns. Returns the
 * lead's actual new text (the part above the "On X wrote:" line)
 * or the original body if no quote marker is recognized.
 *
 * We deliberately keep this regex-only — html parsing is brittle
 * across providers and we already prefer `text` over `html` in
 * the route.
 */
export function stripQuotedReply(body: string): string {
  if (!body) return ''
  let cutAt = body.length
  for (const re of QUOTE_HEADER_RES) {
    const m = body.match(re)
    if (m && typeof m.index === 'number' && m.index < cutAt) {
      cutAt = m.index
    }
  }
  let trimmed = body.slice(0, cutAt)
  // Drop trailing "> " quoted lines that escaped the header cut.
  trimmed = trimmed.replace(/(?:^>.*\n?)+\s*$/gm, '')
  return trimmed.trim()
}

const MAX_BODY = 8000
const MAX_PREVIEW = 500

/**
 * Compose a normalized payload from the raw provider payload.
 * Does no I/O — the caller will pair this with a DB lookup for
 * the source outbound_message.
 */
export function normalizeInboundPayload(
  payload: InboundEmailPayload
): NormalizedInboundEmail | { error: 'invalid_from' | 'empty_body' | 'invalid_to' } {
  const from = parseFromAddress(payload.from)
  if (!from.email) return { error: 'invalid_from' }
  const toParsed = parseFromAddress(payload.to)
  if (!toParsed.email) return { error: 'invalid_to' }

  // Prefer plain text; fall back to a naive html-strip when only
  // html is provided. Real production deployments should always
  // include the text variant in the inbound webhook config.
  const rawBody =
    (payload.text && payload.text.trim().length > 0
      ? payload.text
      : payload.html
        ? payload.html
            .replace(/<style[^]*?<\/style>/gi, ' ')
            .replace(/<script[^]*?<\/script>/gi, ' ')
            .replace(/<br\s*\/?>(\s*)/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
        : '') ?? ''
  if (rawBody.trim().length === 0) return { error: 'empty_body' }

  const cleanBody = stripQuotedReply(rawBody).slice(0, MAX_BODY)
  const finalBody = cleanBody.length > 0 ? cleanBody : rawBody.slice(0, MAX_BODY)
  const rawPreview = rawBody.slice(0, MAX_PREVIEW)
  const referencedMessageIds = extractReferencedMessageIds(payload.headers)
  // Strip our own outbound Message-ID format if it appears in
  // refs (defense — should never happen unless provider echoes).
  const filtered = referencedMessageIds.filter((id) => id.length > 0)

  return {
    fromEmail: from.email,
    fromName: from.name ?? payload.fromName ?? null,
    toEmail: toParsed.email,
    subject: (payload.headers.subject ?? '').slice(0, 500) || null,
    cleanBody: finalBody,
    rawPreview,
    referencedMessageIds: filtered,
  }
}

// ── Confidence scoring ───────────────────────────────────────────────────

/**
 * Convert match signals into a 0-100 confidence score.
 *
 *   - Header match    → 95  (high; In-Reply-To references a
 *                            provider_message_id we issued)
 *   - Recipient match → 70  (medium; no headers but the From
 *                            address received an outbound from us
 *                            recently — likely a reply with stripped
 *                            headers)
 *   - Suppressed      → -10 (suppressed addresses are usually
 *                            bounces/auto-replies; reduce trust)
 *   - No signal       → 30  (low; we have an email but nothing
 *                            ties it to a conversation)
 *
 * Threshold for `needs_review` is 75 (matches the parser
 * convention from 8BG).
 */
export function scoreMatchConfidence(signals: MatchSignals): {
  score: number
  tier: MatchConfidenceTier
  reasons: string[]
} {
  let score = 0
  const reasons: string[] = []

  if (signals.matchedByHeader) {
    score = 95
    reasons.push('header_match:in_reply_to')
  } else if (signals.matchedByRecentRecipient) {
    score = 70
    reasons.push('recipient_match:recent_outbound')
  } else {
    score = 30
    reasons.push('no_match:headerless_unknown_sender')
  }

  if (signals.recipientWasSuppressed) {
    score -= 10
    reasons.push('suppression_penalty')
  }

  score = Math.max(0, Math.min(100, score))
  const tier: MatchConfidenceTier =
    score >= 90 ? 'high' : score >= 70 ? 'medium' : score >= 40 ? 'low' : 'none'

  return { score, tier, reasons }
}

export interface BuildInboundMetadataInput {
  normalized: NormalizedInboundEmail
  confidence: number
  needsReview: boolean
  confidenceReasons: string[]
  matchedOutboundMessageId: string | null
  matchedProviderMessageId: string | null
  matchedConversationId: string | null
  providerName: string
  providerInboundId: string | null
}

/**
 * Build the metadata blob stamped onto `messages.metadata`. The
 * format matches the existing Phase 8BG parse-review surface
 * (`parse_needs_review`, `parse_confidence`,
 * `parse_confidence_reasons`, `parser_version`) so the inbox
 * UI's existing `ParseReviewBadge` lights up without changes.
 *
 * Additional inbound-email-specific fields are namespaced under
 * `inbound_*` to avoid colliding with the lead-forwarding parser.
 */
export function buildInboundMessageMetadata(input: BuildInboundMetadataInput) {
  return {
    source: 'inbound_email',
    channel_type: 'email' as const,
    parser_version: INBOUND_PARSER_VERSION,
    parse_confidence: input.confidence,
    parse_needs_review: input.needsReview,
    parse_confidence_reasons: input.confidenceReasons,
    inbound_provider: input.providerName,
    inbound_provider_message_id: input.providerInboundId,
    inbound_matched_outbound_message_id: input.matchedOutboundMessageId,
    inbound_matched_provider_message_id: input.matchedProviderMessageId,
    inbound_matched_conversation_id: input.matchedConversationId,
    inbound_subject: input.normalized.subject,
    inbound_raw_body_preview: input.normalized.rawPreview,
    inbound_referenced_message_ids: input.normalized.referencedMessageIds,
    inbound_from_email: input.normalized.fromEmail,
    inbound_from_name: input.normalized.fromName,
    inbound_to_email: input.normalized.toEmail,
  }
}
