import {
  getChannelCapabilities,
  isManualReplyRequired,
} from '@/lib/integrations/channels/capabilities'
import type { ChannelType } from '@/lib/integrations/channels/types'

/**
 * Phase 8BM — Reply-method resolver.
 *
 * Pure deterministic helper. Given the source channel + the
 * lead's available contact info + the platform's channel
 * capability matrix, returns a structured description of where
 * the operator's reply will actually go.
 *
 * ── HONESTY CONTRACT ────────────────────────────────────────────────────
 * The resolver NEVER returns `deliveryMode: 'direct'` unless the
 * source channel's capability matrix says `outbound: true` AND
 * the platform has a working external delivery path. Today (8BM
 * is a UI/labeling phase, NOT an integration phase) every
 * non-website channel resolves to `'manual'` or `'internal_only'`.
 * Website resolves to `'internal_only'` because the in-product
 * widget thread is the destination — no external email/SMS sender
 * is wired.
 *
 * When a future phase ships real email or SMS, flip the relevant
 * `EXTERNAL_DELIVERY` constants below to `true` after the
 * connector + send helper are verified. The resolver picks up
 * the change without any UI edits.
 */

// ── Public types ─────────────────────────────────────────────────────────

export type ReplyDeliveryMode =
  | 'direct'         // platform sends to the channel — wired + working
  | 'manual'         // operator must copy + send externally
  | 'internal_only'  // saved in VenueRise, no external delivery expected
  | 'unavailable'    // platform can't reach the lead at all

export type ReplyMethodKey =
  | 'email'
  | 'sms'
  | 'instagram'
  | 'facebook'
  | 'the_knot'
  | 'weddingwire'
  | 'meta_lead_ads'
  | 'website'
  | 'internal'

export interface ReplyMethodOption {
  method: ReplyMethodKey
  methodLabel: string
  destinationLabel: string | null
  deliveryMode: ReplyDeliveryMode
  helperText: string
}

export interface ReplyMethod {
  sourceChannel: ChannelType | null
  sourceLabel: string
  method: ReplyMethodKey
  methodLabel: string
  /** Email address, phone number, account handle, or null when N/A. */
  destinationLabel: string | null
  deliveryMode: ReplyDeliveryMode
  /** Whether the lead has more than one viable reply path. */
  canSwitch: boolean
  /** Alternative methods the operator could pick. Includes the
   *  active method; the UI dedupes by `method`. */
  switchOptions: ReplyMethodOption[]
  /** Loud caveat — null when nothing surprising. */
  warning: string | null
  /** One-line helper text under the method label. */
  helperText: string
}

export interface ResolveReplyMethodArgs {
  channelType: ChannelType | string | null | undefined
  leadEmail: string | null | undefined
  leadPhone: string | null | undefined
  /** Optional override for "is direct email send actually wired
   *  on this venue right now?" Defaults to platform-wide false. */
  emailDirectDeliveryEnabled?: boolean
  smsDirectDeliveryEnabled?: boolean
}

// ── External-delivery feature flags ──────────────────────────────────────
//
// Flip these to `true` ONLY when a real outbound connector has
// shipped, been verified end-to-end, and is enabled per-tenant.
// 8BM is a labeling phase — these stay false. The resolver
// accepts per-call overrides so a future per-venue config can
// activate direct delivery one venue at a time.

const EXTERNAL_EMAIL_DELIVERY_DEFAULT = false
const EXTERNAL_SMS_DELIVERY_DEFAULT = false

// ── Helpers ──────────────────────────────────────────────────────────────

function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  // Lightweight shape check — we're not validating, just gating
  // bad data. The DB column is the source of truth.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null
  return trimmed.toLowerCase()
}

function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  // Keep digits + leading + for E.164-ish display. Operator-
  // entered phones can be messy ("(333) 232-3223"); we display
  // them as entered so the operator recognizes their own format.
  const trimmed = raw.trim()
  if (trimmed.length < 7) return null
  return trimmed
}

function channelShortLabel(channelType: ChannelType | string | null | undefined): string {
  if (!channelType) return 'Unknown source'
  const caps = getChannelCapabilities(channelType)
  return caps.shortLabel
}

// ── Main resolver ────────────────────────────────────────────────────────

export function resolveReplyMethod(args: ResolveReplyMethodArgs): ReplyMethod {
  const channelType = (args.channelType ?? null) as ChannelType | null
  const email = normalizeEmail(args.leadEmail)
  const phone = normalizePhone(args.leadPhone)
  const emailExternal =
    args.emailDirectDeliveryEnabled ?? EXTERNAL_EMAIL_DELIVERY_DEFAULT
  const smsExternal =
    args.smsDirectDeliveryEnabled ?? EXTERNAL_SMS_DELIVERY_DEFAULT
  const sourceLabel = channelShortLabel(channelType)

  // Build the option list first; then pick the default method.
  const options: ReplyMethodOption[] = []

  // Email option — available whenever the lead has a real-looking
  // address. Delivery mode honors EXTERNAL_EMAIL_DELIVERY.
  if (email) {
    options.push({
      method: 'email',
      methodLabel: 'Email',
      destinationLabel: email,
      deliveryMode: emailExternal ? 'direct' : 'internal_only',
      helperText: emailExternal
        ? 'Sends via email when you click send.'
        : 'Saved in VenueRise only — email sending is not connected yet.',
    })
  }

  // SMS option — only when phone is present. Always shown as
  // "on file" context even when sending is off; the bar surfaces
  // it as a non-active alternative so the operator knows the
  // number is available for manual outreach.
  if (phone) {
    options.push({
      method: 'sms',
      methodLabel: 'SMS',
      destinationLabel: phone,
      deliveryMode: smsExternal ? 'direct' : 'internal_only',
      helperText: smsExternal
        ? 'Sends via SMS when you click send.'
        : 'SMS on file — direct sending is not connected.',
    })
  }

  // Channel-native option. For inbound-only channels (Instagram,
  // Facebook, The Knot, etc.) the operator must reply natively
  // on the platform.
  switch (channelType) {
    case 'instagram':
      options.push({
        method: 'instagram',
        methodLabel: 'Instagram',
        destinationLabel: null,
        deliveryMode: 'manual',
        helperText: 'Copy this response into Instagram to reply.',
      })
      break
    case 'facebook':
      options.push({
        method: 'facebook',
        methodLabel: 'Facebook Messenger',
        destinationLabel: null,
        deliveryMode: 'manual',
        helperText: 'Copy this response into Facebook Messenger to reply.',
      })
      break
    case 'the_knot':
      options.push({
        method: 'the_knot',
        methodLabel: 'The Knot',
        destinationLabel: null,
        deliveryMode: 'manual',
        helperText: 'Copy this response into The Knot to reply.',
      })
      break
    case 'weddingwire':
      options.push({
        method: 'weddingwire',
        methodLabel: 'WeddingWire',
        destinationLabel: null,
        deliveryMode: 'manual',
        helperText: 'Copy this response into WeddingWire to reply.',
      })
      break
    case 'meta_lead_ads':
      options.push({
        method: 'meta_lead_ads',
        methodLabel: 'Meta lead ad',
        destinationLabel: null,
        deliveryMode: 'unavailable',
        helperText: 'Lead-ad replies are not connected yet — use email or SMS if shared.',
      })
      break
    case 'website':
      options.push({
        method: 'website',
        methodLabel: 'Website widget',
        destinationLabel: null,
        deliveryMode: 'internal_only',
        helperText: 'Saved in the in-product widget thread.',
      })
      break
    default:
      // No additional native option — `manual` / unknown channels
      // fall through to whatever email/SMS options were added
      // above. If nothing was added we fall back to 'internal'.
      break
  }

  // De-dupe (defensive).
  const deduped: ReplyMethodOption[] = []
  const seen = new Set<ReplyMethodKey>()
  for (const opt of options) {
    if (seen.has(opt.method)) continue
    seen.add(opt.method)
    deduped.push(opt)
  }

  // Pick the default method. Priority:
  //   1. Channel-native if the channel REQUIRES manual reply
  //      (instagram / fb / knot / weddingwire / meta_lead_ads /
  //      manual). The operator must respond on the original
  //      channel; email/SMS as backup is on the operator.
  //   2. Email if present.
  //   3. SMS if present.
  //   4. Channel-native non-manual (website).
  //   5. Internal fallback.
  const manualRequired = isManualReplyRequired(channelType)
  const findOpt = (m: ReplyMethodKey) =>
    deduped.find((o) => o.method === m)

  let chosen: ReplyMethodOption | undefined
  if (manualRequired) {
    chosen =
      findOpt('instagram') ??
      findOpt('facebook') ??
      findOpt('the_knot') ??
      findOpt('weddingwire') ??
      findOpt('meta_lead_ads') ??
      findOpt('email') ??
      findOpt('sms')
  } else {
    chosen =
      findOpt('email') ??
      findOpt('sms') ??
      findOpt('website')
  }

  // Internal fallback — operator has neither a channel-native
  // path nor any contact info. Reply is saved internally only.
  if (!chosen) {
    chosen = {
      method: 'internal',
      methodLabel: 'Internal',
      destinationLabel: null,
      deliveryMode: 'internal_only',
      helperText: 'No contact channel on file. Reply will be saved inside VenueRise only.',
    }
    deduped.push(chosen)
  }

  // Compose a warning when the default method is anything other
  // than `direct`. The UI uses tone to color the pill; the
  // warning is the plain-English caveat.
  const warning = (() => {
    if (chosen.deliveryMode === 'direct') return null
    if (chosen.deliveryMode === 'manual') {
      return `${chosen.methodLabel} does not accept direct sending. Copy your response into ${chosen.methodLabel} after writing.`
    }
    if (chosen.deliveryMode === 'unavailable') {
      return 'No working delivery path for this channel yet. Reply will be saved in VenueRise.'
    }
    // internal_only
    return chosen.method === 'website'
      ? 'Reply saved in the in-product widget thread.'
      : `Reply will be saved in VenueRise — ${chosen.methodLabel.toLowerCase()} sending is not connected yet.`
  })()

  return {
    sourceChannel: channelType,
    sourceLabel,
    method: chosen.method,
    methodLabel: chosen.methodLabel,
    destinationLabel: chosen.destinationLabel,
    deliveryMode: chosen.deliveryMode,
    canSwitch: deduped.length > 1,
    switchOptions: deduped,
    warning,
    helperText: chosen.helperText,
  }
}

// ── Display helpers exported for the UI ──────────────────────────────────

export function deliveryModeLabel(mode: ReplyDeliveryMode): string {
  switch (mode) {
    case 'direct': return 'Direct'
    case 'manual': return 'Manual'
    case 'internal_only': return 'Internal'
    case 'unavailable': return 'Unavailable'
  }
}

export function deliveryModeTone(mode: ReplyDeliveryMode): {
  bg: string
  text: string
  ring: string
} {
  switch (mode) {
    case 'direct':
      return { bg: 'bg-[#ECFDF5]', text: 'text-[#047857]', ring: 'border-[#A7F3D0]' }
    case 'manual':
      return { bg: 'bg-[#FAF7F0]', text: 'text-[#92763C]', ring: 'border-[#E8DCC4]' }
    case 'internal_only':
      return { bg: 'bg-[#F1F5F9]', text: 'text-[#475569]', ring: 'border-[#E2E8F0]' }
    case 'unavailable':
      return { bg: 'bg-[#FEF2F2]', text: 'text-[#B91C1C]', ring: 'border-[#FECACA]' }
  }
}
