import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import { getChannelCapabilities } from '@/lib/integrations/channels/capabilities'
import type {
  ChannelType,
  ExternalMessageDeliveryStatus,
  ExternalMessageRecord,
} from '@/lib/integrations/channels/types'

/**
 * Phase 8BE — Outbound delivery adapter foundation.
 *
 * `sendChannelMessage` is the single point of orchestration
 * future Approve & Send paths will call to actually push a
 * reply out through the source channel. In this phase it
 * resolves the channel mapping, consults capabilities, and
 * either records a placeholder result or returns
 * `manual_required` so the caller can steer the operator into
 * the copy + mark-sent-manually flow.
 *
 * Honesty contract:
 *   - This helper does NOT call Meta Send API. It does NOT
 *     call Gmail / Resend / Twilio. It does NOT call
 *     WeddingWire or The Knot. Those connectors ship in
 *     later phases.
 *   - When `capabilities.outbound === false` the helper
 *     returns `manual_required` with a human-readable reason
 *     and records an `external_messages` row with
 *     `delivery_status = 'manual_required'` so the trail
 *     stays intact.
 *   - When the channel IS outbound-capable (today only
 *     `website`) the helper still does not send autonomously
 *     — operator approval still happens upstream. It records
 *     a `sent` delivery status mirroring the existing
 *     in-product reply path.
 *   - autonomous_sending_still_disabled stays mounted.
 */

export interface SendChannelMessageInput {
  venueId: string
  conversationId: string
  messageId: string
  body: string
  /** Override the resolved channel (debug / future use). */
  channelType?: ChannelType | null
}

export type SendChannelMessageResult =
  | {
      status: 'sent'
      channelType: ChannelType
      externalMessageId?: string | null
    }
  | {
      status: 'manual_required'
      channelType: ChannelType
      reason: string
    }
  | {
      status: 'unsupported'
      channelType: ChannelType
      reason: string
    }
  | {
      status: 'failed'
      channelType: ChannelType
      reason: string
    }

interface ResolvedMapping {
  externalConversationId: string
  channelType: ChannelType
}

async function resolveExternalConversation(
  input: SendChannelMessageInput
): Promise<ResolvedMapping | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('external_conversations')
    .select('id, channel_type')
    .eq('venue_id', input.venueId)
    .eq('conversation_id', input.conversationId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    log.warn(
      {
        op: 'integrations.channels.send.resolve_failed',
        venueId: input.venueId,
        conversationId: input.conversationId,
        errorMessage: error.message,
      },
      'delivery.resolve_failed'
    )
    return null
  }
  if (!data) return null
  return {
    externalConversationId: (data as { id: string }).id,
    channelType: (data as { channel_type: ChannelType }).channel_type,
  }
}

async function recordOutboundExternalMessage(args: {
  venueId: string
  externalConversationId: string
  messageId: string
  channelType: ChannelType
  deliveryStatus: ExternalMessageDeliveryStatus
  reason?: string | null
}): Promise<ExternalMessageRecord | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('external_messages')
    .insert({
      venue_id: args.venueId,
      message_id: args.messageId,
      external_conversation_id: args.externalConversationId,
      channel_type: args.channelType,
      external_message_id: null,
      direction: 'outbound',
      delivery_status: args.deliveryStatus,
      metadata: args.reason ? { reason: args.reason } : {},
    })
    .select('*')
    .single()
  if (error || !data) {
    log.warn(
      {
        op: 'integrations.channels.send.record_failed',
        venueId: args.venueId,
        errorMessage: error?.message,
      },
      'delivery.record_failed'
    )
    captureApiError(
      error ?? new Error('external_messages insert returned no row'),
      {
        route: 'integrations.channels.delivery',
        venueId: args.venueId,
      }
    )
    return null
  }
  return data as unknown as ExternalMessageRecord
}

export async function sendChannelMessage(
  input: SendChannelMessageInput
): Promise<SendChannelMessageResult> {
  if (!input.venueId || !input.conversationId || !input.messageId) {
    return {
      status: 'failed',
      channelType: input.channelType ?? 'manual',
      reason: 'missing required input',
    }
  }

  const mapping = await resolveExternalConversation(input)
  // If there's no external mapping, the message originated entirely
  // inside VenueRise (legacy in-product reply). Treat as 'sent' so
  // existing Approve & send flows keep working unchanged. We do NOT
  // record an external_messages row because there's no external
  // conversation to bind it to.
  if (!mapping) {
    return {
      status: 'sent',
      channelType: input.channelType ?? 'website',
      externalMessageId: null,
    }
  }

  const channelType = input.channelType ?? mapping.channelType
  const capabilities = getChannelCapabilities(channelType)

  if (capabilities.manualReplyRequired || !capabilities.outbound) {
    await recordOutboundExternalMessage({
      venueId: input.venueId,
      externalConversationId: mapping.externalConversationId,
      messageId: input.messageId,
      channelType,
      deliveryStatus: 'manual_required',
      reason: capabilities.operatorNote,
    })
    return {
      status: 'manual_required',
      channelType,
      reason: capabilities.operatorNote,
    }
  }

  // Today only `website` resolves here. We record a placeholder
  // `sent` status because the actual delivery already happened
  // through the in-product reply path. Future connector phases
  // (Meta, Gmail) will plug in here without changing callers.
  await recordOutboundExternalMessage({
    venueId: input.venueId,
    externalConversationId: mapping.externalConversationId,
    messageId: input.messageId,
    channelType,
    deliveryStatus: 'sent',
  })
  return { status: 'sent', channelType, externalMessageId: null }
}

/**
 * Mark an internal message as `marked_sent_manually` against
 * the external_messages mapping. Used by the manual-required
 * UI when the operator confirms they pasted the reply into
 * Instagram / WeddingWire / etc.
 */
export async function recordManualSendOutcome(args: {
  venueId: string
  conversationId: string
  messageId: string
}): Promise<{ ok: true; channelType: ChannelType } | { ok: false; reason: string }> {
  const mapping = await resolveExternalConversation({
    venueId: args.venueId,
    conversationId: args.conversationId,
    messageId: args.messageId,
    body: '',
  })
  if (!mapping) {
    return { ok: false, reason: 'no external mapping for conversation' }
  }
  const recorded = await recordOutboundExternalMessage({
    venueId: args.venueId,
    externalConversationId: mapping.externalConversationId,
    messageId: args.messageId,
    channelType: mapping.channelType,
    deliveryStatus: 'marked_sent_manually',
    reason: 'operator confirmed manual send',
  })
  if (!recorded) {
    return { ok: false, reason: 'failed to record manual outcome' }
  }
  // Bump last_outbound_at so the inbox row reflects the manual reply.
  const supabase = createServiceClient()
  await supabase
    .from('external_conversations')
    .update({ last_outbound_at: new Date().toISOString() })
    .eq('id', mapping.externalConversationId)
  return { ok: true, channelType: mapping.channelType }
}
