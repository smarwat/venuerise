/**
 * Phase 8BF — Meta webhook payload parser.
 *
 * Pure function. Accepts the verified webhook body (already
 * signature-checked upstream) and returns a list of
 * `ParsedMetaEvent` rows suitable for `normalizeInboundChannelMessage`.
 *
 * Supports the three event shapes that matter to a venue:
 *
 *   1. `object: 'instagram'` + `messaging[]` — Instagram DM.
 *   2. `object: 'page'` + `messaging[]` — Facebook Page / Messenger.
 *   3. `object: 'page'` + `changes[].field === 'leadgen'` — Meta
 *      lead-ad form submission. This phase records a PLACEHOLDER
 *      message because pulling the actual lead fields requires
 *      a Graph API call that we do NOT make until 8BF+1.
 *
 * Anything else (postbacks, read receipts, attachments without
 * text, story mentions, etc.) is counted as `ignored` and not
 * surfaced. Never throws on strange payloads.
 *
 * Honesty contract:
 *   - Caps message text at 8000 chars.
 *   - Never returns the raw webhook body in metadata.
 *   - For leadgen events, stamps
 *     `requires_graph_hydration: true` + `parse_needs_review: true`
 *     so the inbox UI surfaces the operator-review badge.
 */

import 'server-only'
import type { ChannelType } from '@/lib/integrations/channels/types'

const MAX_MESSAGE_LEN = 8000

export type MetaChannelType = 'instagram' | 'facebook' | 'meta_lead_ads'

export type MetaEventType = 'message' | 'leadgen'

export interface ParsedMetaEvent {
  channelType: MetaChannelType
  eventType: MetaEventType
  externalThreadId: string
  externalMessageId: string
  externalSenderId: string | null
  externalRecipientId: string | null
  /** External page or IG business account id — used by the
   *  connection resolver to route the event to a venue. */
  externalRecipientPageId: string | null
  message: string
  name: string | null
  email: string | null
  phone: string | null
  eventDate: string | null
  guestCount: number | null
  budget: number | null
  metadata: Record<string, unknown>
  /** ISO timestamp the event was emitted (best-effort). */
  receivedAt: string | null
}

export interface ParseMetaPayloadResult {
  events: ParsedMetaEvent[]
  ignored: number
  objectType: string | null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function trim(s: string): string {
  return s.length <= MAX_MESSAGE_LEN ? s : s.slice(0, MAX_MESSAGE_LEN)
}

function tsToIso(ts: unknown): string | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null
  // Meta sends seconds OR milliseconds depending on event shape.
  // Treat values < 10^12 as seconds.
  const ms = ts < 1e12 ? ts * 1000 : ts
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function hashFallback(parts: ReadonlyArray<string>): string {
  // Cheap deterministic fallback id when Meta omits mid — avoids
  // duplicate inserts via the (venue, channel, external_message_id)
  // unique index downstream. Not cryptographic; idempotency only.
  let h = 0
  const s = parts.join('|')
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return `fallback_${Math.abs(h).toString(36)}_${parts[0]?.slice(0, 16) ?? 'x'}`
}

function parseMessagingEvent(
  objectType: 'instagram' | 'page',
  entryId: string | null,
  msg: Record<string, unknown>
): ParsedMetaEvent | null {
  const sender = isObject(msg.sender) ? msg.sender : null
  const recipient = isObject(msg.recipient) ? msg.recipient : null
  const message = isObject(msg.message) ? msg.message : null
  if (!sender || !recipient || !message) return null

  // Skip read receipts, deliveries, postbacks, attachments-only.
  if ('read' in msg || 'delivery' in msg || 'postback' in msg) return null
  const text = asString(message.text)
  if (!text) return null

  const senderId = asString(sender.id)
  const recipientId = asString(recipient.id)
  if (!senderId || !recipientId) return null

  const mid = asString(message.mid)
  const ts = typeof msg.timestamp === 'number' ? msg.timestamp : null
  const externalThreadId = `${recipientId}:${senderId}`
  const externalMessageId =
    mid ??
    hashFallback([senderId, recipientId, String(ts ?? 0), text.slice(0, 32)])

  const channelType: MetaChannelType =
    objectType === 'instagram' ? 'instagram' : 'facebook'

  return {
    channelType,
    eventType: 'message',
    externalThreadId,
    externalMessageId,
    externalSenderId: senderId,
    externalRecipientId: recipientId,
    externalRecipientPageId: recipientId,
    message: trim(text),
    name:
      channelType === 'instagram' ? 'Instagram Lead' : 'Facebook Lead',
    email: null,
    phone: null,
    eventDate: null,
    guestCount: null,
    budget: null,
    metadata: {
      meta_object_type: objectType,
      meta_event_type: 'message',
      entry_id: entryId,
      message_id: mid,
      sender_id: senderId,
      recipient_id: recipientId,
    },
    receivedAt: tsToIso(ts),
  }
}

function parseLeadgenChange(
  entryId: string | null,
  change: Record<string, unknown>
): ParsedMetaEvent | null {
  const value = isObject(change.value) ? change.value : null
  if (!value) return null
  const leadgenId = asString(value.leadgen_id)
  const formId = asString(value.form_id)
  const pageId = asString(value.page_id) ?? entryId
  if (!leadgenId) return null

  const externalThreadId = formId ? `${formId}:${leadgenId}` : leadgenId
  const createdTime =
    typeof value.created_time === 'number' ? value.created_time : null
  return {
    channelType: 'meta_lead_ads',
    eventType: 'leadgen',
    externalThreadId,
    externalMessageId: leadgenId,
    externalSenderId: null,
    externalRecipientId: pageId,
    externalRecipientPageId: pageId,
    message:
      'Meta lead form received. Connect Graph API hydration to pull submitted fields (Phase 8BF+).',
    name: 'Meta Lead',
    email: null,
    phone: null,
    eventDate: null,
    guestCount: null,
    budget: null,
    metadata: {
      meta_object_type: 'page',
      meta_event_type: 'leadgen',
      entry_id: entryId,
      leadgen_id: leadgenId,
      form_id: formId,
      page_id: pageId,
      requires_graph_hydration: true,
      parse_needs_review: true,
      parse_confidence: 25,
      parse_confidence_reasons: [
        'leadgen_payload_received',
        'graph_hydration_pending',
        'lead_fields_missing',
      ],
    },
    receivedAt: tsToIso(createdTime),
  }
}

export function parseMetaWebhookPayload(
  payload: unknown
): ParseMetaPayloadResult {
  if (!isObject(payload)) {
    return { events: [], ignored: 0, objectType: null }
  }
  const objectType = asString(payload.object)
  const entry = Array.isArray(payload.entry) ? payload.entry : []
  const events: ParsedMetaEvent[] = []
  let ignored = 0

  for (const e of entry) {
    if (!isObject(e)) {
      ignored += 1
      continue
    }
    const entryId = asString(e.id)

    // ── Messaging events (Instagram + Facebook page inbox).
    if (
      (objectType === 'instagram' || objectType === 'page') &&
      Array.isArray(e.messaging)
    ) {
      for (const m of e.messaging) {
        if (!isObject(m)) {
          ignored += 1
          continue
        }
        const parsed = parseMessagingEvent(
          objectType,
          entryId,
          m as Record<string, unknown>
        )
        if (parsed) events.push(parsed)
        else ignored += 1
      }
    }

    // ── Page leadgen changes.
    if (objectType === 'page' && Array.isArray(e.changes)) {
      for (const ch of e.changes) {
        if (!isObject(ch)) {
          ignored += 1
          continue
        }
        const field = asString(ch.field)
        if (field === 'leadgen') {
          const parsed = parseLeadgenChange(
            entryId,
            ch as Record<string, unknown>
          )
          if (parsed) events.push(parsed)
          else ignored += 1
        } else {
          // Other change fields (mention, feed, etc.) are ignored
          // safely until a future phase wires them.
          ignored += 1
        }
      }
    }
  }

  return { events, ignored, objectType }
}

/**
 * Surface ChannelType for callers that want to pass straight
 * into normalization. Centralised so the mapping lives in one
 * place.
 */
export function metaChannelToInternal(
  channelType: MetaChannelType
): ChannelType {
  return channelType
}
