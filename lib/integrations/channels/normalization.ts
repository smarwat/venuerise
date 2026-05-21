import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import { sanitizeAuditJson } from '@/lib/enterprise/audit-events'
import {
  CHANNEL_CAPABILITIES,
  getChannelCapabilities,
} from '@/lib/integrations/channels/capabilities'
// Phase 8BH — Stamp lead attribution metadata so omnichannel
// inbound (website / forwarding / Meta) groups under the
// correct source label in AttributionPerformanceCard.
import { parseLeadAttribution } from '@/lib/enterprise/attribution/parse'
import type {
  ChannelType,
  ExternalConversationRecord,
  ExternalMessageRecord,
} from '@/lib/integrations/channels/types'

/**
 * Phase 8BE — Normalize inbound connector payloads into the
 * internal lead / conversation / message graph.
 *
 * This helper is the SINGLE entry point every public inbound
 * route should call. It owns:
 *
 *   1. Lead lookup / create — by email first, then phone, then
 *      external lead id mapping. Never overwrites rich fields
 *      with empty values.
 *   2. Conversation lookup / create — one per lead per channel
 *      thread (or one shared conversation when the channel
 *      doesn't preserve thread identity, e.g. Meta lead ads).
 *   3. Message insert — `role='lead'` with channel metadata
 *      stamped onto `messages.metadata` so the inbox UI can
 *      render the source badge without a join.
 *   4. external_conversations upsert — preserves the mapping
 *      from the external thread id back to the internal rows
 *      so subsequent messages collapse onto the same thread.
 *   5. external_messages insert — idempotency anchor + delivery
 *      status trail.
 *
 * Idempotency: if `externalMessageId` already exists for this
 * (venue, channel_type) pair, the helper short-circuits with
 * `{ created: false, ...existing }` and inserts nothing.
 *
 * Safety:
 *   - Service-role write path. Routes are responsible for their
 *     own auth (or for being explicitly public + rate-limited).
 *   - Provider payloads are NEVER logged verbatim. Metadata is
 *     sanitized + size-capped via sanitizeAuditJson.
 *   - Never throws raw provider errors back to the caller —
 *     returns a discriminated result so the public route can
 *     translate to an HTTP status without leaking internals.
 *   - autonomous_sending_still_disabled is unaffected — this
 *     helper only handles INBOUND ingestion.
 */

export interface NormalizeInboundMessageInput {
  venueId: string
  channelType: ChannelType
  externalThreadId?: string | null
  externalLeadId?: string | null
  externalMessageId?: string | null
  externalContactId?: string | null
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  messageBody: string
  eventDate?: string | null
  guestCount?: number | null
  budget?: number | null
  /** Optional human-readable label used for `leads.source`. */
  sourceLabel?: string | null
  /** ISO timestamp the external system recorded. Defaults to now(). */
  receivedAt?: string | null
  /** Free-form connector context (parsing notes, raw type, etc.). */
  metadata?: Record<string, unknown> | null
  /**
   * Phase 8BG — extra metadata to merge into the inserted
   * `messages.metadata` (e.g. parser confidence + needs-review
   * flag). Kept separate from `metadata` (which lands on
   * external_conversations + external_messages) so the inbox
   * UI can render the parse-review badge without an extra
   * join. Always sanitized + size-capped via cleanMetadata.
   */
  messageMetadataExtra?: Record<string, unknown> | null
}

export type NormalizeInboundMessageResult =
  | {
      ok: true
      created: boolean
      lead: { id: string }
      conversation: { id: string }
      message: { id: string } | null
      externalConversation: ExternalConversationRecord
      externalMessage: ExternalMessageRecord | null
    }
  | {
      ok: false
      code:
        | 'venue_not_found'
        | 'venue_inactive'
        | 'invalid_input'
        | 'unexpected_error'
      message: string
    }

const MAX_BODY_LEN = 8000
const MAX_METADATA_KEYS = 32

function trimToLen(s: string | null | undefined, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max)
}

function cleanMetadata(
  raw: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!raw) return {}
  const sanitized = sanitizeAuditJson(raw)
  if (!sanitized || typeof sanitized !== 'object') return {}
  const obj = sanitized as Record<string, unknown>
  const keys = Object.keys(obj).slice(0, MAX_METADATA_KEYS)
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = obj[k]
  return out
}

function asExternalConversationRecord(
  row: Record<string, unknown>
): ExternalConversationRecord {
  return {
    id: row.id as string,
    venueId: row.venue_id as string,
    leadId: (row.lead_id as string | null) ?? null,
    conversationId: (row.conversation_id as string | null) ?? null,
    channelConnectionId:
      (row.channel_connection_id as string | null) ?? null,
    channelType: row.channel_type as ChannelType,
    externalThreadId: (row.external_thread_id as string | null) ?? null,
    externalLeadId: (row.external_lead_id as string | null) ?? null,
    externalContactId: (row.external_contact_id as string | null) ?? null,
    status: (row.status as ExternalConversationRecord['status']) ?? 'active',
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    lastInboundAt: (row.last_inbound_at as string | null) ?? null,
    lastOutboundAt: (row.last_outbound_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

function asExternalMessageRecord(
  row: Record<string, unknown>
): ExternalMessageRecord {
  return {
    id: row.id as string,
    venueId: row.venue_id as string,
    messageId: (row.message_id as string | null) ?? null,
    externalConversationId: row.external_conversation_id as string,
    channelType: row.channel_type as ChannelType,
    externalMessageId: (row.external_message_id as string | null) ?? null,
    direction:
      (row.direction as ExternalMessageRecord['direction']) ?? 'inbound',
    deliveryStatus:
      (row.delivery_status as ExternalMessageRecord['deliveryStatus']) ??
      'received',
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at as string,
  }
}

export async function normalizeInboundChannelMessage(
  input: NormalizeInboundMessageInput
): Promise<NormalizeInboundMessageResult> {
  const reqLog = log.child({
    op: 'integrations.channels.normalize_inbound',
    channel: input.channelType,
    venueId: input.venueId,
  })

  // ── Validate ────────────────────────────────────────────────────────
  if (!input.venueId) {
    return { ok: false, code: 'invalid_input', message: 'venue_id is required' }
  }
  if (!input.channelType || !(input.channelType in CHANNEL_CAPABILITIES)) {
    return {
      ok: false,
      code: 'invalid_input',
      message: 'unknown channel_type',
    }
  }
  if (!input.messageBody || input.messageBody.trim().length === 0) {
    return {
      ok: false,
      code: 'invalid_input',
      message: 'message body is required',
    }
  }
  const capabilities = getChannelCapabilities(input.channelType)
  if (!capabilities.inbound) {
    return {
      ok: false,
      code: 'invalid_input',
      message: `channel ${input.channelType} does not support inbound delivery`,
    }
  }

  const supabase = createServiceClient()
  const metadata = cleanMetadata(input.metadata)
  const body = trimToLen(input.messageBody, MAX_BODY_LEN).trim()
  const receivedAt = input.receivedAt ?? new Date().toISOString()

  try {
    // ── 1. Verify venue exists + active ───────────────────────────────
    const { data: venueRow, error: venueErr } = await supabase
      .from('venues')
      .select('id, is_active')
      .eq('id', input.venueId)
      .maybeSingle()
    if (venueErr) {
      reqLog.error(
        { errorMessage: venueErr.message },
        'normalize.venue_lookup_failed'
      )
      captureApiError(venueErr, {
        route: 'integrations.channels.normalize_inbound',
        venueId: input.venueId,
      })
      return {
        ok: false,
        code: 'unexpected_error',
        message: 'venue lookup failed',
      }
    }
    if (!venueRow) {
      return {
        ok: false,
        code: 'venue_not_found',
        message: 'venue does not exist',
      }
    }
    const venue = venueRow as { id: string; is_active: boolean }
    if (!venue.is_active) {
      return {
        ok: false,
        code: 'venue_inactive',
        message: 'venue is not active',
      }
    }

    // ── 2. Idempotency — if externalMessageId already maps, return ────
    if (input.externalMessageId) {
      const { data: dupRow } = await supabase
        .from('external_messages')
        .select('*')
        .eq('venue_id', input.venueId)
        .eq('channel_type', input.channelType)
        .eq('external_message_id', input.externalMessageId)
        .maybeSingle()
      if (dupRow) {
        const dup = asExternalMessageRecord(
          dupRow as Record<string, unknown>
        )
        const { data: convRow } = await supabase
          .from('external_conversations')
          .select('*')
          .eq('id', dup.externalConversationId)
          .maybeSingle()
        if (convRow) {
          const ec = asExternalConversationRecord(
            convRow as Record<string, unknown>
          )
          return {
            ok: true,
            created: false,
            lead: { id: ec.leadId ?? '' },
            conversation: { id: ec.conversationId ?? '' },
            message: dup.messageId ? { id: dup.messageId } : null,
            externalConversation: ec,
            externalMessage: dup,
          }
        }
      }
    }

    // ── 3. Resolve lead: email → phone → external_lead_id mapping ─────
    let leadId: string | null = null
    const email = input.contactEmail?.trim()?.toLowerCase() ?? null
    const phone = input.contactPhone?.trim() ?? null

    if (email) {
      const { data } = await supabase
        .from('leads')
        .select('id')
        .eq('venue_id', input.venueId)
        .ilike('email', email)
        .limit(1)
        .maybeSingle()
      if (data) leadId = (data as { id: string }).id
    }
    if (!leadId && phone) {
      const { data } = await supabase
        .from('leads')
        .select('id')
        .eq('venue_id', input.venueId)
        .eq('phone', phone)
        .limit(1)
        .maybeSingle()
      if (data) leadId = (data as { id: string }).id
    }
    if (!leadId && input.externalLeadId) {
      const { data } = await supabase
        .from('external_conversations')
        .select('lead_id')
        .eq('venue_id', input.venueId)
        .eq('channel_type', input.channelType)
        .eq('external_lead_id', input.externalLeadId)
        .not('lead_id', 'is', null)
        .limit(1)
        .maybeSingle()
      if (data) leadId = (data as { lead_id: string | null }).lead_id ?? null
    }

    // Create the lead if no existing one matched. We persist the
    // channel as the `source` so the existing operator filters in
    // /dashboard/leads keep working without schema changes.
    if (!leadId) {
      const sourceLabel = input.sourceLabel ?? input.channelType
      // Phase 8BH — Compute attribution from the inbound channel
      // context. The parser maps channel_type → SourceLabel
      // (instagram → Instagram, the_knot → The Knot, etc.) so
      // omnichannel inbound leads show up in the same
      // AttributionPerformanceCard as widget-attributed leads.
      const inboundAttribution = parseLeadAttribution({
        channel_type: input.channelType,
        source: input.sourceLabel ?? input.channelType,
        medium: 'inbound',
        captured_at: receivedAt,
      })
      const leadMetadata = cleanMetadata({
        channel_type: input.channelType,
        external_lead_id: input.externalLeadId ?? null,
        external_thread_id: input.externalThreadId ?? null,
        external_contact_id: input.externalContactId ?? null,
        source_label: input.sourceLabel ?? null,
        attribution: inboundAttribution,
        ...metadata,
      })
      const insertPayload = {
        venue_id: input.venueId,
        name: input.contactName?.trim() || 'Unknown',
        email: email ?? '',
        phone: phone ?? null,
        event_date: input.eventDate ?? null,
        guest_count: input.guestCount ?? null,
        budget: input.budget ?? null,
        notes: null,
        source: trimToLen(sourceLabel, 50),
        stage: 'new_inquiry' as const,
        lead_score: 0,
        urgency: 'medium' as const,
        ai_active: true,
        metadata: leadMetadata,
      }
      const { data: newLead, error: insertErr } = await supabase
        .from('leads')
        .insert(insertPayload)
        .select('id')
        .single()
      if (insertErr || !newLead) {
        reqLog.error(
          { errorMessage: insertErr?.message },
          'normalize.lead_insert_failed'
        )
        captureApiError(
          insertErr ?? new Error('lead insert returned no row'),
          {
            route: 'integrations.channels.normalize_inbound',
            venueId: input.venueId,
          }
        )
        return {
          ok: false,
          code: 'unexpected_error',
          message: 'lead insert failed',
        }
      }
      leadId = (newLead as { id: string }).id
    }

    // ── 4. Resolve or create the external_conversations row ──────────
    let externalConversation: ExternalConversationRecord | null = null
    if (input.externalThreadId) {
      const { data } = await supabase
        .from('external_conversations')
        .select('*')
        .eq('venue_id', input.venueId)
        .eq('channel_type', input.channelType)
        .eq('external_thread_id', input.externalThreadId)
        .maybeSingle()
      if (data) {
        externalConversation = asExternalConversationRecord(
          data as Record<string, unknown>
        )
      }
    }

    // ── 5. Resolve or create internal conversation row ───────────────
    let internalConversationId: string | null =
      externalConversation?.conversationId ?? null
    if (!internalConversationId) {
      // Reuse the lead's most recent open conversation if available.
      const { data: existingConv } = await supabase
        .from('conversations')
        .select('id')
        .eq('venue_id', input.venueId)
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (existingConv) {
        internalConversationId = (existingConv as { id: string }).id
      } else {
        const { data: newConv, error: convErr } = await supabase
          .from('conversations')
          .insert({
            lead_id: leadId,
            venue_id: input.venueId,
            sentiment: 'neutral' as const,
            unread_count: 0,
          })
          .select('id')
          .single()
        if (convErr || !newConv) {
          reqLog.error(
            { errorMessage: convErr?.message },
            'normalize.conversation_insert_failed'
          )
          captureApiError(
            convErr ?? new Error('conversation insert returned no row'),
            {
              route: 'integrations.channels.normalize_inbound',
              venueId: input.venueId,
            }
          )
          return {
            ok: false,
            code: 'unexpected_error',
            message: 'conversation insert failed',
          }
        }
        internalConversationId = (newConv as { id: string }).id
      }
    }

    if (!externalConversation) {
      const { data: ecRow, error: ecErr } = await supabase
        .from('external_conversations')
        .insert({
          venue_id: input.venueId,
          lead_id: leadId,
          conversation_id: internalConversationId,
          channel_type: input.channelType,
          external_thread_id: input.externalThreadId ?? null,
          external_lead_id: input.externalLeadId ?? null,
          external_contact_id: input.externalContactId ?? null,
          status: 'active',
          metadata,
          last_inbound_at: receivedAt,
        })
        .select('*')
        .single()
      if (ecErr || !ecRow) {
        reqLog.error(
          { errorMessage: ecErr?.message },
          'normalize.external_conversation_insert_failed'
        )
        captureApiError(
          ecErr ?? new Error('external_conversations insert returned no row'),
          {
            route: 'integrations.channels.normalize_inbound',
            venueId: input.venueId,
          }
        )
        return {
          ok: false,
          code: 'unexpected_error',
          message: 'external_conversations insert failed',
        }
      }
      externalConversation = asExternalConversationRecord(
        ecRow as Record<string, unknown>
      )
    } else {
      // Bump last_inbound_at + ensure lead/conversation mapping is set.
      const patch: Record<string, unknown> = { last_inbound_at: receivedAt }
      if (!externalConversation.leadId && leadId) patch.lead_id = leadId
      if (!externalConversation.conversationId && internalConversationId)
        patch.conversation_id = internalConversationId
      const { data: updated } = await supabase
        .from('external_conversations')
        .update(patch)
        .eq('id', externalConversation.id)
        .select('*')
        .single()
      if (updated) {
        externalConversation = asExternalConversationRecord(
          updated as Record<string, unknown>
        )
      }
    }

    // ── 6. Insert the internal messages row (role=lead) ──────────────
    const { data: messageRow, error: messageErr } = await supabase
      .from('messages')
      .insert({
        conversation_id: internalConversationId,
        lead_id: leadId,
        venue_id: input.venueId,
        role: 'lead' as const,
        content: body,
        metadata: {
          channel_type: input.channelType,
          external_message_id: input.externalMessageId ?? null,
          external_thread_id: input.externalThreadId ?? null,
          source: input.sourceLabel ?? input.channelType,
          // Phase 8BG — parse-review metadata when caller
          // supplied it. Sanitized through the same cleaner as
          // external metadata so a pathological forwarder cannot
          // blow the row.
          ...cleanMetadata(input.messageMetadataExtra),
        },
      })
      .select('id')
      .single()
    if (messageErr || !messageRow) {
      reqLog.error(
        { errorMessage: messageErr?.message },
        'normalize.message_insert_failed'
      )
      captureApiError(
        messageErr ?? new Error('messages insert returned no row'),
        {
          route: 'integrations.channels.normalize_inbound',
          venueId: input.venueId,
        }
      )
      return {
        ok: false,
        code: 'unexpected_error',
        message: 'message insert failed',
      }
    }
    const messageId = (messageRow as { id: string }).id

    // Bump unread_count on the internal conversation so the inbox
    // surface lights up like a regular lead reply.
    await supabase
      .from('conversations')
      .update({ unread_count: 1, last_message_at: receivedAt })
      .eq('id', internalConversationId)

    // ── 7. Insert external_messages mapping ──────────────────────────
    const { data: emRow, error: emErr } = await supabase
      .from('external_messages')
      .insert({
        venue_id: input.venueId,
        message_id: messageId,
        external_conversation_id: externalConversation.id,
        channel_type: input.channelType,
        external_message_id: input.externalMessageId ?? null,
        direction: 'inbound',
        delivery_status: 'received',
        metadata,
      })
      .select('*')
      .single()
    if (emErr || !emRow) {
      reqLog.warn(
        { errorMessage: emErr?.message, messageId },
        'normalize.external_message_insert_failed'
      )
      captureApiError(
        emErr ?? new Error('external_messages insert returned no row'),
        {
          route: 'integrations.channels.normalize_inbound',
          venueId: input.venueId,
        }
      )
      // Non-fatal — the internal message is in. Return success.
      return {
        ok: true,
        created: true,
        lead: { id: leadId },
        conversation: { id: internalConversationId! },
        message: { id: messageId },
        externalConversation,
        externalMessage: null,
      }
    }
    const externalMessage = asExternalMessageRecord(
      emRow as Record<string, unknown>
    )

    reqLog.info(
      {
        leadId,
        conversationId: internalConversationId,
        messageId,
        externalConversationId: externalConversation.id,
      },
      'normalize.success'
    )

    return {
      ok: true,
      created: true,
      lead: { id: leadId },
      conversation: { id: internalConversationId! },
      message: { id: messageId },
      externalConversation,
      externalMessage,
    }
  } catch (err) {
    reqLog.error({ err }, 'normalize.unexpected_error')
    captureApiError(err, {
      route: 'integrations.channels.normalize_inbound',
      venueId: input.venueId,
    })
    return {
      ok: false,
      code: 'unexpected_error',
      message: 'unexpected error',
    }
  }
}
