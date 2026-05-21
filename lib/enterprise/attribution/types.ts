/**
 * Phase 8BH — Lead attribution type system.
 *
 * Best-effort attribution captured from the inquiry source:
 * UTM params on the landing page, click ids stamped by the ad
 * platform, `document.referrer`, and (for omnichannel routes)
 * the channel that delivered the lead. NO pixel, NO ad
 * platform API call, NO multi-touch attribution.
 */

export type SourceLabel =
  | 'Google Ads'
  | 'Meta Ads'
  | 'Instagram'
  | 'Facebook'
  | 'WeddingWire'
  | 'The Knot'
  | 'Bing Ads'
  | 'TikTok Ads'
  | 'Website'
  | 'Email'
  | 'Referral'
  | 'Direct'
  | 'Manual entry'
  | 'Unknown'

export const SOURCE_LABELS: ReadonlyArray<SourceLabel> = [
  'Google Ads',
  'Meta Ads',
  'Instagram',
  'Facebook',
  'WeddingWire',
  'The Knot',
  'Bing Ads',
  'TikTok Ads',
  'Website',
  'Email',
  'Referral',
  'Direct',
  'Manual entry',
  'Unknown',
]

export interface LeadAttribution {
  source: string | null
  medium: string | null
  campaign: string | null
  term: string | null
  content: string | null
  landingPage: string | null
  referrer: string | null
  gclid: string | null
  fbclid: string | null
  msclkid: string | null
  ttclid: string | null
  channelType: string | null
  capturedAt: string | null
  /** Derived label used by the UI badges + perf card grouping. */
  sourceLabel: SourceLabel
}

/**
 * Lowercase snake_case shape we actually stamp onto
 * `leads.metadata.attribution`. Mirrors the JSON contract the
 * widget POSTs / the normalization helper writes.
 */
export interface LeadAttributionMetadata {
  source: string | null
  medium: string | null
  campaign: string | null
  term: string | null
  content: string | null
  landing_page: string | null
  referrer: string | null
  gclid: string | null
  fbclid: string | null
  msclkid: string | null
  ttclid: string | null
  channel_type: string | null
  source_label: SourceLabel
  captured_at: string | null
}

export interface AttributionInput {
  source?: string | null
  medium?: string | null
  campaign?: string | null
  term?: string | null
  content?: string | null
  landing_page?: string | null
  landingPage?: string | null
  referrer?: string | null
  gclid?: string | null
  fbclid?: string | null
  msclkid?: string | null
  ttclid?: string | null
  channel_type?: string | null
  channelType?: string | null
  captured_at?: string | null
  capturedAt?: string | null
  // Convenience: callers can also pass utm_* keys directly.
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_term?: string | null
  utm_content?: string | null
}
