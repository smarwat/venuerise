import 'server-only'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { normalizePhoneForSms } from '@/lib/integrations/delivery/sms'
import { createInboundSmsOrphan } from '@/lib/integrations/inbound/orphans'

/**
 * Phase 8BS — Inbound SMS capture (Twilio).
 *
 * Mirrors `lib/integrations/inbound/email.ts` (Phase 8BO) for
 * the Twilio side. Lead replies to the platform's
 * OUTBOUND_SMS_FROM number land here, get matched to a
 * conversation by recent outbound SMS history or lead phone,
 * and insert as `role:'lead'` on the left of the inbox thread.
 *
 * ── HONESTY CONTRACT ──────────────────────────────────────────────────────
 *   - NEVER auto-fires AI on capture. SMS is intimate +
 *     high-risk; operators must review before any response.
 *   - High-confidence capture inserts immediately. Medium
 *     confidence does too (single-conversation lead with
 *     phone match). Low / no match → ignore. SMS orphan queue
 *     is the next phase (8BT).
 *   - Never stores raw Twilio payload. Body is capped (8000
 *     chars). MMS attachments not captured.
 *   - Never logs the message body at error level. Phone +
 *     conversation id only.
 *   - Webhook signature verification before any DB lookup —
 *     Twilio HMAC-SHA1 over URL + sorted POST params.
 */

const FALSE_VALUES = new Set(['', '0', 'false', 'no', 'off'])

export function isInboundSmsEnabled(): boolean {
  const raw = process.env.INBOUND_SMS_ENABLED
  if (raw == null) return false
  if (FALSE_VALUES.has(raw.trim().toLowerCase())) return false
  // Twilio auth token is reused from the outbound config
  // (TWILIO_AUTH_TOKEN); see env.example. Inbound webhook
  // verification requires it, so absence = "not configured".
  return !!process.env.TWILIO_AUTH_TOKEN
}

export interface InboundSmsPayload {
  provider: 'twilio'
  providerMessageId: string | null
  fromPhone: string
  toPhone: string
  body: string
  numMedia: number
  receivedAt: string | null
}

/**
 * Normalize a Twilio form-data payload (or a JSON-shaped test
 * payload) into our internal SMS shape. We accept either:
 *
 *   - URLSearchParams / { [k]: string } directly from the
 *     route's form parsing
 *   - { MessageSid, From, To, Body, NumMedia } JSON
 *
 * Phone normalization runs through `normalizePhoneForSms` so
 * incoming +1XXX matches the outbound side's storage shape.
 */
export function normalizeInboundSmsPayload(
  input: unknown
): InboundSmsPayload | { error: 'invalid_from' | 'invalid_to' | 'empty_body' } {
  const obj = coerceFlatObject(input)
  const fromRaw = pick(obj, 'From', 'from', 'fromPhone')
  const toRaw = pick(obj, 'To', 'to', 'toPhone')
  const body = (pick(obj, 'Body', 'body') ?? '').toString()
  const messageId = pick(obj, 'MessageSid', 'providerMessageId', 'sid') ?? null
  const numMediaRaw = pick(obj, 'NumMedia', 'numMedia')

  const fromPhone = normalizePhoneForSms(fromRaw ?? null)
  if (!fromPhone) return { error: 'invalid_from' }
  const toPhone = normalizePhoneForSms(toRaw ?? null)
  if (!toPhone) return { error: 'invalid_to' }
  const trimmed = body.trim()
  if (!trimmed) return { error: 'empty_body' }

  const numMedia = (() => {
    if (numMediaRaw == null) return 0
    const n = Number(numMediaRaw)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  })()

  return {
    provider: 'twilio',
    providerMessageId: messageId ? String(messageId).slice(0, 200) : null,
    fromPhone,
    toPhone,
    body: trimmed.slice(0, 8000),
    numMedia,
    receivedAt: new Date().toISOString(),
  }
}

function coerceFlatObject(input: unknown): Record<string, unknown> {
  if (input instanceof URLSearchParams) {
    const out: Record<string, string> = {}
    input.forEach((v, k) => {
      out[k] = v
    })
    return out
  }
  if (input && typeof input === 'object') {
    return input as Record<string, unknown>
  }
  return {}
}

function pick(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | null | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (v != null && v !== '') return v as string
  }
  return undefined
}

// ─── Twilio signature verification ──────────────────────────────────────
//
// Twilio docs: https://www.twilio.com/docs/usage/security#validating-requests
//
//   sign_string = full_url + sorted_concat(key + value)
//   signature   = base64(HMAC-SHA1(sign_string, auth_token))
//
// Sorting is alphabetical by parameter name. Parameter values
// are appended directly (no separator), keys are NOT included
// in the concatenation — only `${key}${value}` per param.

export function verifyTwilioSmsSignature(args: {
  url: string
  params: Record<string, string>
  signature: string | null
  authToken: string
}): boolean {
  const { url, params, signature, authToken } = args
  if (!signature || !authToken || !url) return false

  const sortedKeys = Object.keys(params).sort()
  let data = url
  for (const k of sortedKeys) {
    data += k + params[k]
  }

  const expected = createHmac('sha1', authToken).update(data).digest('base64')
  // Length check first so timingSafeEqual doesn't throw.
  if (signature.length !== expected.length) return false
  try {
    return timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expected, 'utf8')
    )
  } catch {
    return false
  }
}

// ─── Matching ──────────────────────────────────────────────────────────

export type SmsMatchMethod =
  | 'recent_outbound_sms_to_phone'
  | 'lead_phone_recent_conversation'
  | 'lead_phone_exact'
  | 'none'

export interface SmsConversationMatch {
  conversationId: string | null
  venueId: string | null
  leadId: string | null
  matchMethod: SmsMatchMethod
  matchConfidence: 'high' | 'medium' | 'low' | 'none'
  needsReview: boolean
  reasons: string[]
}

/**
 * Match an inbound SMS to an existing conversation.
 *
 * Strategy (priority order):
 *
 *   1. HIGH — most recent operator-sent SMS to this `fromPhone`.
 *      SMS sends from 8BR save into `messages` with
 *      `metadata.reply_method='sms'` and
 *      `metadata.reply_destination=<phone>`. We query by JSONB
 *      key path. 90-day window so a stale lead replying years
 *      later doesn't auto-land on the wrong thread.
 *
 *   2. MEDIUM — lead with this phone has exactly one
 *      conversation. Confident enough to insert.
 *
 *   3. LOW — lead with this phone has multiple conversations.
 *      Pick the most recent but flag `needsReview` — route
 *      decides whether to skip (this phase ignores low; orphan
 *      queue will be 8BT).
 *
 *   4. NONE — no signal. Return without conversationId.
 */
export async function matchInboundSmsToConversation(
  payload: InboundSmsPayload
): Promise<SmsConversationMatch> {
  const supabase = createServiceClient()
  const fromPhone = payload.fromPhone
  const reasons: string[] = []

  // 1. Recent outbound SMS to this phone.
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  try {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const { data: outboundMatches, error } = await (supabase as any)
      .from('messages')
      .select('id, conversation_id, lead_id, venue_id, created_at')
      .eq('role', 'human')
      .eq('metadata->>reply_method', 'sms')
      .eq('metadata->>reply_destination', fromPhone)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)
    /* eslint-enable @typescript-eslint/no-explicit-any */
    if (error) {
      log.warn(
        { errorMessage: error.message },
        'inbound.sms.recent_outbound_lookup_failed'
      )
    } else if (outboundMatches && outboundMatches.length > 0) {
      const hit = outboundMatches[0] as {
        id: string
        conversation_id: string
        lead_id: string | null
        venue_id: string
      }
      reasons.push('matched_recent_outbound_sms_within_90d')
      return {
        conversationId: hit.conversation_id,
        venueId: hit.venue_id,
        leadId: hit.lead_id,
        matchMethod: 'recent_outbound_sms_to_phone',
        matchConfidence: 'high',
        needsReview: false,
        reasons,
      }
    }
  } catch (err) {
    log.warn({ err }, 'inbound.sms.recent_outbound_lookup_threw')
  }

  // 2/3. Lead phone match. Try several stored shapes since
  // lead.phone is operator-entered free text and may not match
  // the normalized E.164 we just computed.
  try {
    const e164 = fromPhone
    const digits = e164.replace(/^\+/, '')
    const us10 = digits.startsWith('1') ? digits.slice(1) : digits
    // Build a small candidate set so we capture "(555) 123-1234"
    // style entries via PostgREST's `.in()` — no fuzzy LIKE
    // needed for the common cases.
    const candidates = Array.from(
      new Set([
        e164,
        digits,
        us10,
        `+${digits}`,
      ].filter(Boolean))
    )
    const { data: leads } = await supabase
      .from('leads')
      .select('id, venue_id, phone')
      .in('phone', candidates)
      .limit(5)
    const leadRows = (leads ?? []) as Array<{
      id: string
      venue_id: string
      phone: string | null
    }>
    if (leadRows.length === 0) {
      reasons.push('no_lead_phone_match')
      return {
        conversationId: null,
        venueId: null,
        leadId: null,
        matchMethod: 'none',
        matchConfidence: 'none',
        needsReview: false,
        reasons,
      }
    }
    // For each lead, count active conversations.
    const leadIds = leadRows.map((l) => l.id)
    const { data: convs } = await supabase
      .from('conversations')
      .select('id, lead_id, venue_id, last_message_at')
      .in('lead_id', leadIds)
      .order('last_message_at', { ascending: false })
      .limit(20)
    const convRows = (convs ?? []) as Array<{
      id: string
      lead_id: string
      venue_id: string
      last_message_at: string | null
    }>
    if (convRows.length === 0) {
      reasons.push('lead_found_no_conversation')
      return {
        conversationId: null,
        venueId: null,
        leadId: leadRows[0].id,
        matchMethod: 'none',
        matchConfidence: 'none',
        needsReview: false,
        reasons,
      }
    }
    if (convRows.length === 1) {
      reasons.push('matched_lead_phone_single_conversation')
      const hit = convRows[0]
      return {
        conversationId: hit.id,
        venueId: hit.venue_id,
        leadId: hit.lead_id,
        matchMethod: 'lead_phone_exact',
        matchConfidence: 'medium',
        needsReview: false,
        reasons,
      }
    }
    // Multiple conversations — low confidence. Don't auto-insert
    // (orphan queue is 8BT).
    reasons.push('lead_phone_multiple_conversations')
    const hit = convRows[0]
    return {
      conversationId: hit.id,
      venueId: hit.venue_id,
      leadId: hit.lead_id,
      matchMethod: 'lead_phone_recent_conversation',
      matchConfidence: 'low',
      needsReview: true,
      reasons,
    }
  } catch (err) {
    log.warn({ err }, 'inbound.sms.lead_lookup_threw')
  }

  return {
    conversationId: null,
    venueId: null,
    leadId: null,
    matchMethod: 'none',
    matchConfidence: 'none',
    needsReview: false,
    reasons: ['lookup_failed'],
  }
}

// ─── Process ───────────────────────────────────────────────────────────

export interface InboundSmsProcessResult {
  ok: boolean
  ignored?: boolean
  reason?: string
  messageId?: string
  conversationId?: string
  match?: SmsConversationMatch
  safeError?: string
}

/**
 * Dedupe key strategy:
 *
 *   - Primary: `metadata->>provider_message_id` = MessageSid.
 *     Twilio guarantees unique SIDs across the account.
 *   - Fallback: when payload omits MessageSid (rare), compute
 *     a sha256 of `from + to + body` and check for a recent
 *     row with that hash. Not used in this phase — Twilio
 *     always includes MessageSid.
 *
 * On dedupe hit, returns `{ ok: true, ignored: true, reason:
 * 'duplicate' }` — Twilio retries that find the existing row
 * should not bump conversation order.
 */
export async function processInboundSmsReply(
  payload: InboundSmsPayload
): Promise<InboundSmsProcessResult> {
  // 0. MMS: ignore in this phase. If a body exists alongside
  //    the attachment we still capture the text portion; pure-
  //    MMS (no body) was already rejected at normalize.
  if (payload.numMedia > 0) {
    // Body is present (normalize rejected empty), so we'll
    // capture the text and ignore attachments — but flag in
    // the reason so logs are honest.
  }

  const supabase = createServiceClient()

  // 1. Dedupe by provider message id.
  if (payload.providerMessageId) {
    try {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const { data: existing } = await (supabase as any)
        .from('messages')
        .select('id, conversation_id')
        .eq('metadata->>source', 'inbound_sms')
        .eq('metadata->>provider_message_id', payload.providerMessageId)
        .limit(1)
        .maybeSingle()
      /* eslint-enable @typescript-eslint/no-explicit-any */
      if (existing && (existing as { id?: string }).id) {
        const row = existing as { id: string; conversation_id: string }
        return {
          ok: true,
          ignored: true,
          reason: 'duplicate',
          messageId: row.id,
          conversationId: row.conversation_id,
        }
      }
    } catch (err) {
      log.warn({ err }, 'inbound.sms.dedupe_lookup_threw')
    }
  }

  // 2. Match to a conversation.
  const match = await matchInboundSmsToConversation(payload)

  // Phase 8BT — persist no/low-confidence inbound as an
  // orphan in the shared `inbound_email_orphans` table
  // (channel='sms') so operators can manually link or dismiss
  // from the inbox queue card. Replaces the pre-8BT "log +
  // drop" path.
  const shouldOrphan =
    !match.conversationId || !match.venueId || match.needsReview
  if (shouldOrphan) {
    // Collect suggested conversation/lead ids from the match
    // attempt — even when no confident pick was possible, the
    // matcher might have surfaced candidates the operator can
    // one-click link to.
    const preInferredConvIds =
      match.conversationId && match.matchConfidence !== 'high'
        ? [match.conversationId]
        : []
    const preInferredLeadIds = match.leadId ? [match.leadId] : []

    const orphanMetadata: Record<string, unknown> = {
      sms_num_media: payload.numMedia,
      match_method: match.matchMethod,
      match_confidence: match.matchConfidence,
    }
    if (payload.numMedia > 0) {
      orphanMetadata.had_attachments = true
      orphanMetadata.attachments_ignored_count = payload.numMedia
    }

    const orphanResult = await createInboundSmsOrphan({
      fromPhone: payload.fromPhone,
      toPhone: payload.toPhone,
      body: payload.body,
      rawPreview: payload.body.slice(0, 500),
      provider: payload.provider,
      providerMessageId: payload.providerMessageId,
      matchConfidence:
        match.matchConfidence === 'high'
          ? 95
          : match.matchConfidence === 'medium'
            ? 70
            : match.matchConfidence === 'low'
              ? 40
              : 0,
      matchReasons: match.reasons,
      receivedAtIso: payload.receivedAt,
      preInferredVenueId: match.venueId,
      preInferredLeadId: match.leadId,
      preInferredConversationIds: preInferredConvIds,
      preInferredLeadIds,
      metadata: orphanMetadata,
    })

    log.info(
      {
        matchMethod: match.matchMethod,
        matchConfidence: match.matchConfidence,
        orphanCreated: orphanResult.ok ? orphanResult.created : false,
        orphanVenueId: orphanResult.ok ? orphanResult.venueId : null,
      },
      match.matchMethod === 'none'
        ? 'inbound.sms.orphaned_no_match'
        : 'inbound.sms.orphaned_needs_review'
    )

    return {
      ok: true,
      ignored: true,
      reason:
        match.matchMethod === 'none'
          ? 'orphaned_no_match'
          : 'orphaned_needs_review',
      match,
    }
  }

  // 3. Insert as role:'lead'.
  try {
    const messageMetadata: Record<string, unknown> = {
      source: 'inbound_sms',
      channel_type: 'sms',
      provider: payload.provider,
      provider_message_id: payload.providerMessageId,
      inbound_from_phone: payload.fromPhone,
      inbound_to_phone: payload.toPhone,
      match_method: match.matchMethod,
      match_confidence: match.matchConfidence,
      match_reasons: match.reasons,
      parse_needs_review: false,
      parsed_at: new Date().toISOString(),
    }
    if (payload.numMedia > 0) {
      messageMetadata.had_attachments = true
      messageMetadata.attachments_ignored_count = payload.numMedia
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('messages')
      .insert({
        conversation_id: match.conversationId,
        lead_id: match.leadId,
        venue_id: match.venueId,
        role: 'lead' as const,
        content: payload.body,
        metadata: messageMetadata,
      })
      .select('id')
      .single()
    if (insertErr || !inserted) {
      log.error(
        { errorMessage: insertErr?.message ?? 'no_row' },
        'inbound.sms.insert_failed'
      )
      return {
        ok: false,
        safeError: 'Could not save inbound SMS.',
      }
    }

    // 4. Touch conversation so the inbox re-sorts.
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', match.conversationId)

    const messageId = (inserted as { id: string }).id
    log.info(
      {
        conversationId: match.conversationId,
        messageId,
        matchMethod: match.matchMethod,
        matchConfidence: match.matchConfidence,
        providerMessageIdPresent: !!payload.providerMessageId,
      },
      'inbound.sms.captured'
    )
    return {
      ok: true,
      messageId,
      // Guaranteed non-null at this point — the shouldOrphan
      // early-return above filtered out null cases. Coerce so
      // the typed flow into InboundSmsProcessResult is clean.
      conversationId: match.conversationId ?? undefined,
      match,
    }
  } catch (err) {
    log.error({ err }, 'inbound.sms.insert_threw')
    return { ok: false, safeError: 'Unexpected error saving inbound SMS.' }
  }
}

/**
 * Sha256 of `from+to+body` for the fallback dedupe path. Not
 * used in this phase but exported for tests / future use if a
 * provider omits MessageSid.
 */
export function bodyDedupeHash(payload: InboundSmsPayload): string {
  return createHash('sha256')
    .update(`${payload.fromPhone}|${payload.toPhone}|${payload.body}`)
    .digest('hex')
}
