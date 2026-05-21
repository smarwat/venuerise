import type {
  ChannelCapabilities,
  ChannelType,
} from '@/lib/integrations/channels/types'

/**
 * Phase 8BE — Channel capability matrix.
 *
 * SINGLE SOURCE OF TRUTH for the inbound/outbound posture of
 * every supported channel. The admin UI, the manual-required
 * banner, and the delivery helper all import from here so a
 * single edit propagates everywhere.
 *
 * Updating this map IS a policy change. Each row carries an
 * `operatorNote` explaining the current posture honestly.
 *
 * ── Honesty contract ───────────────────────────────────────────────────
 * Do NOT mark `outbound: true` for a channel where the actual
 * connector / OAuth / Send API is not wired AND verified in
 * code. The platform UI keys its "Manual reply required" flow
 * off `manualReplyRequired` — flipping that to false without a
 * working delivery path will silently route operators into
 * dead-end Approve clicks.
 */

export const OMNICHANNEL_INBOX_DISCLAIMER =
  'Omnichannel inbox is a foundation surface. Channel capabilities reflect what the platform can actually do today — direct Instagram/Facebook/Meta lead-ad sending is NOT enabled. Email + SMS connectors are placeholders. The Knot + WeddingWire are modeled as lead-forwarding/manual-reply channels. Operators are never auto-sent; manual-reply channels require explicit copy + mark-sent-manually.'

export const CHANNEL_CAPABILITIES: Readonly<
  Record<ChannelType, ChannelCapabilities>
> = {
  website: {
    inbound: true,
    outbound: true,
    realTime: true,
    supportsThreading: true,
    manualReplyRequired: false,
    displayName: 'Website widget',
    shortLabel: 'Website',
    operatorNote:
      'First-party VenueRise widget. Inbound goes through /api/widget; outbound replies land back in the in-product inbox. No external delivery dependency.',
  },
  instagram: {
    inbound: true,
    outbound: false,
    realTime: false,
    supportsThreading: true,
    manualReplyRequired: true,
    displayName: 'Instagram DM',
    shortLabel: 'Instagram',
    operatorNote:
      'Inbound modeled via forwarding/import for now. Direct VenueRise → Instagram reply sending is NOT wired — operator must copy the reply and send it from the Instagram app/web. Planned: real Meta Graph Send API connector in a later phase (real OAuth, signature verification).',
  },
  facebook: {
    inbound: true,
    outbound: false,
    realTime: false,
    supportsThreading: true,
    manualReplyRequired: true,
    displayName: 'Facebook Messenger',
    shortLabel: 'Facebook',
    operatorNote:
      'Inbound modeled via forwarding/import for now. Direct VenueRise → Messenger reply sending is NOT wired — operator must reply from Page inbox. Planned: real Meta Page Send API connector.',
  },
  meta_lead_ads: {
    inbound: true,
    outbound: false,
    realTime: false,
    supportsThreading: false,
    manualReplyRequired: true,
    displayName: 'Meta lead ad',
    shortLabel: 'Meta Lead Ad',
    operatorNote:
      'Meta lead ads deliver a one-shot lead payload, not a thread. VenueRise records the lead; replies happen via email / phone / DM based on what the prospect shared. No direct ad-platform reply API.',
  },
  email: {
    inbound: true,
    outbound: false,
    realTime: false,
    supportsThreading: true,
    manualReplyRequired: true,
    displayName: 'Email',
    shortLabel: 'Email',
    operatorNote:
      'Email connector is a placeholder. Inbound parsing + outbound send via Resend / Gmail OAuth is NOT shipped in this phase. Operator copies the reply into their email client. Planned: structured inbound parser + per-tenant outbound mailbox.',
  },
  sms: {
    inbound: false,
    outbound: false,
    realTime: false,
    supportsThreading: true,
    manualReplyRequired: true,
    displayName: 'SMS',
    shortLabel: 'SMS',
    operatorNote:
      'SMS is not connected. Inbound + outbound both require a future Twilio / messaging connector with explicit consent capture. Placeholder only.',
  },
  the_knot: {
    inbound: true,
    outbound: false,
    realTime: false,
    supportsThreading: false,
    manualReplyRequired: true,
    displayName: 'The Knot',
    shortLabel: 'The Knot',
    operatorNote:
      'The Knot does NOT expose a public two-way reply API. Modeled as a lead-forwarding inbound channel — replies happen in The Knot dashboard / email. Operator marks the reply sent manually after responding.',
  },
  weddingwire: {
    inbound: true,
    outbound: false,
    realTime: false,
    supportsThreading: false,
    manualReplyRequired: true,
    displayName: 'WeddingWire',
    shortLabel: 'WeddingWire',
    operatorNote:
      'WeddingWire does NOT expose a public two-way reply API. Modeled as a lead-forwarding inbound channel — replies happen in WeddingWire dashboard / email. Operator marks the reply sent manually after responding.',
  },
  manual: {
    inbound: true,
    outbound: false,
    realTime: false,
    supportsThreading: false,
    manualReplyRequired: true,
    displayName: 'Manual entry',
    shortLabel: 'Manual',
    operatorNote:
      'Catch-all for operator-recorded leads that came in by phone, in-person, referral, etc. No external delivery — all follow-up is manual.',
  },
}

/**
 * Convenience: pure lookup. Falls back to a manual-required
 * shape so unknown channels never silently look outbound-ready.
 */
export function getChannelCapabilities(
  channelType: ChannelType | string | null | undefined
): ChannelCapabilities {
  if (!channelType) return CHANNEL_CAPABILITIES.manual
  const direct = (CHANNEL_CAPABILITIES as Record<string, ChannelCapabilities>)[
    channelType
  ]
  return direct ?? CHANNEL_CAPABILITIES.manual
}

/**
 * True when the channel cannot programmatically send back —
 * use this to gate the Approve & send button or to render the
 * manual-required banner.
 */
export function isManualReplyRequired(
  channelType: ChannelType | string | null | undefined
): boolean {
  return getChannelCapabilities(channelType).manualReplyRequired
}
