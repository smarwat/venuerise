/**
 * Phase 8BE — Omnichannel inbox connector foundation.
 *
 * Type system for the multi-source inbox. Real venue inquiries
 * arrive from many origins (website widget, Instagram DM,
 * Facebook Messenger, Meta lead ads, email, SMS later, The Knot,
 * WeddingWire, manual operator entry). Each source has a
 * different posture for inbound delivery, outbound delivery,
 * threading, and whether VenueRise can reply directly through
 * the channel.
 *
 * This module is the single source of truth for the channel
 * vocabulary. Migrations, helpers, routes, and UI badges all
 * import from here so adding a channel is a one-line edit.
 *
 * Honesty rules carried throughout:
 *   - No autonomous sending. Outbound is operator-approved
 *     even where the connector is "wired" enough to send.
 *   - No real third-party OAuth in this phase. No real Meta
 *     Send API call. No real Gmail API. No WeddingWire / The
 *     Knot direct two-way API claims.
 *   - When `manualReplyRequired` is true the platform UI MUST
 *     surface that to the operator and steer them to copy-and-
 *     paste the reply into the source platform.
 *   - `autonomous_sending_still_disabled` health flag stays
 *     mounted.
 */

export type ChannelType =
  | 'website'
  | 'instagram'
  | 'facebook'
  | 'meta_lead_ads'
  | 'email'
  | 'sms'
  | 'the_knot'
  | 'weddingwire'
  | 'manual'

export const CHANNEL_TYPES: ReadonlyArray<ChannelType> = [
  'website',
  'instagram',
  'facebook',
  'meta_lead_ads',
  'email',
  'sms',
  'the_knot',
  'weddingwire',
  'manual',
]

export type ChannelConnectionStatus =
  | 'draft'
  | 'connected'
  | 'degraded'
  | 'disconnected'
  | 'manual_only'

export const CHANNEL_CONNECTION_STATUSES: ReadonlyArray<ChannelConnectionStatus> =
  [
    'draft',
    'connected',
    'degraded',
    'disconnected',
    'manual_only',
  ]

export type ExternalConversationStatus =
  | 'active'
  | 'archived'
  | 'disconnected'
  | 'manual_required'

export const EXTERNAL_CONVERSATION_STATUSES: ReadonlyArray<ExternalConversationStatus> =
  ['active', 'archived', 'disconnected', 'manual_required']

export type ExternalMessageDirection = 'inbound' | 'outbound'

export const EXTERNAL_MESSAGE_DIRECTIONS: ReadonlyArray<ExternalMessageDirection> =
  ['inbound', 'outbound']

export type ExternalMessageDeliveryStatus =
  | 'received'
  | 'drafted'
  | 'sent'
  | 'failed'
  | 'manual_required'
  | 'copied'
  | 'marked_sent_manually'

export const EXTERNAL_MESSAGE_DELIVERY_STATUSES: ReadonlyArray<ExternalMessageDeliveryStatus> =
  [
    'received',
    'drafted',
    'sent',
    'failed',
    'manual_required',
    'copied',
    'marked_sent_manually',
  ]

// ── Capabilities ─────────────────────────────────────────────────────────

export type ChannelCapabilities = {
  /** Can we receive messages from this channel today? */
  inbound: boolean
  /** Can VenueRise programmatically send back through this channel today? */
  outbound: boolean
  /** Does the channel push us realtime events (vs polling / forwarding)? */
  realTime: boolean
  /** Does the channel preserve thread identity across messages? */
  supportsThreading: boolean
  /**
   * True when an operator MUST copy + paste the reply into the
   * source platform — VenueRise cannot deliver it directly.
   * The UI surfaces a "Manual reply required" banner and a
   * `Copy reply` + `Mark sent manually` workflow.
   */
  manualReplyRequired: boolean
  displayName: string
  shortLabel: string
  /**
   * One-line operator note explaining the current posture and
   * what is gated until a future connector phase. Rendered in
   * the ChannelConnectionsCard + buyer-honest UI.
   */
  operatorNote: string
}

// ── Records ──────────────────────────────────────────────────────────────

export interface ChannelConnectionRecord {
  id: string
  venueId: string
  channelType: ChannelType
  status: ChannelConnectionStatus
  externalAccountLabel: string | null
  externalAccountId: string | null
  metadata: Record<string, unknown>
  lastSyncAt: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

export interface ExternalConversationRecord {
  id: string
  venueId: string
  leadId: string | null
  conversationId: string | null
  channelConnectionId: string | null
  channelType: ChannelType
  externalThreadId: string | null
  externalLeadId: string | null
  externalContactId: string | null
  status: ExternalConversationStatus
  metadata: Record<string, unknown>
  lastInboundAt: string | null
  lastOutboundAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ExternalMessageRecord {
  id: string
  venueId: string
  messageId: string | null
  externalConversationId: string
  channelType: ChannelType
  externalMessageId: string | null
  direction: ExternalMessageDirection
  deliveryStatus: ExternalMessageDeliveryStatus
  metadata: Record<string, unknown>
  createdAt: string
}

// ── Inputs ───────────────────────────────────────────────────────────────

export interface ChannelConnectionCreateInput {
  venueId: string
  channelType: ChannelType
  status?: ChannelConnectionStatus
  externalAccountLabel?: string | null
  externalAccountId?: string | null
  metadata?: Record<string, unknown> | null
  createdBy: string | null
}

export interface ChannelConnectionUpdateInput {
  connectionId: string
  externalAccountLabel?: string | null
  status?: ChannelConnectionStatus
  metadata?: Record<string, unknown> | null
  actorUserId: string | null
}

/**
 * Summary shape returned by the admin GET endpoint. Per-channel
 * capability info + computed `manual_reply_required` so the
 * card never has to re-derive from the bare connection row.
 */
export interface ChannelConnectionListItem {
  channelType: ChannelType
  capabilities: ChannelCapabilities
  manualReplyRequired: boolean
  /** Null when no connection has been recorded for this channel. */
  connection: ChannelConnectionRecord | null
}

export interface ChannelConnectionListSummary {
  generatedAt: string
  disclaimer: string
  items: ChannelConnectionListItem[]
}
