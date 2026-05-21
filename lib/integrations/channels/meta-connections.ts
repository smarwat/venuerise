import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import type { ParsedMetaEvent } from '@/lib/integrations/channels/meta-parser'
import type {
  ChannelConnectionRecord,
  ChannelType,
} from '@/lib/integrations/channels/types'

/**
 * Phase 8BF — Resolve a venue_channel_connections row from a
 * parsed Meta webhook event.
 *
 * Operators record Meta page / IG business / ad account ids in
 * `venue_channel_connections.metadata` via the
 * ChannelConnectionsCard. The webhook handler uses this helper
 * to map an inbound event back to a venue WITHOUT requiring a
 * Graph API call.
 *
 * Match strategy:
 *   - Instagram: metadata.instagram_business_account_id ===
 *     event.externalRecipientPageId
 *   - Facebook:  metadata.meta_page_id === event.externalRecipientPageId
 *   - Lead ads:  metadata.meta_page_id ===
 *     event.metadata.page_id   (fall back to
 *     metadata.meta_ad_account_id when present)
 *
 * Falls back to null when no matching connected venue exists.
 * Caller (webhook route) records ignored count and moves on
 * — Meta retries on non-2xx and we never want a 5xx loop from
 * an event that simply isn't ours.
 */

export interface MetaConnectionMatch {
  connection: ChannelConnectionRecord
  venueId: string
}

function asConnectionRecord(
  row: Record<string, unknown>
): ChannelConnectionRecord {
  return {
    id: row.id as string,
    venueId: row.venue_id as string,
    channelType: row.channel_type as ChannelType,
    status:
      (row.status as ChannelConnectionRecord['status']) ?? 'draft',
    externalAccountLabel: (row.external_account_label as string | null) ?? null,
    externalAccountId: (row.external_account_id as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    lastSyncAt: (row.last_sync_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: (row.created_by as string | null) ?? null,
  }
}

export async function findMetaConnectionForEvent(
  event: ParsedMetaEvent
): Promise<MetaConnectionMatch | null> {
  const supabase = createServiceClient()
  const pageOrIgId = event.externalRecipientPageId ?? null
  if (!pageOrIgId && event.channelType !== 'meta_lead_ads') return null

  try {
    // Pull every connection of the matching channel type that is
    // NOT disconnected. Set is small per venue (one or two rows)
    // and the index on (venue, channel) keeps this cheap.
    const { data, error } = await supabase
      .from('venue_channel_connections')
      .select('*')
      .eq('channel_type', event.channelType)
      .neq('status', 'disconnected')
    if (error) {
      log.warn(
        {
          op: 'integrations.channels.meta.find_connection_failed',
          channel: event.channelType,
          errorMessage: error.message,
        },
        'meta_connections.lookup_failed'
      )
      return null
    }
    const rows = (data ?? []).map((r) =>
      asConnectionRecord(r as Record<string, unknown>)
    )

    for (const row of rows) {
      const md = row.metadata ?? {}
      if (event.channelType === 'instagram') {
        const ig = md['instagram_business_account_id']
        if (typeof ig === 'string' && ig === pageOrIgId) {
          return { connection: row, venueId: row.venueId }
        }
      } else if (event.channelType === 'facebook') {
        const page = md['meta_page_id']
        if (typeof page === 'string' && page === pageOrIgId) {
          return { connection: row, venueId: row.venueId }
        }
      } else if (event.channelType === 'meta_lead_ads') {
        const page = md['meta_page_id']
        const ad = md['meta_ad_account_id']
        const eventPage =
          (event.metadata?.page_id as string | undefined) ?? pageOrIgId
        if (typeof page === 'string' && page === eventPage) {
          return { connection: row, venueId: row.venueId }
        }
        if (typeof ad === 'string' && ad === eventPage) {
          return { connection: row, venueId: row.venueId }
        }
      }
    }
  } catch (err) {
    log.warn(
      {
        op: 'integrations.channels.meta.find_connection_threw',
        channel: event.channelType,
        err,
      },
      'meta_connections.lookup_threw'
    )
  }

  return null
}

/**
 * Allowlisted metadata keys an admin can store on a
 * Meta-family channel connection. Used by the admin POST /
 * PATCH routes to strip everything else — explicitly so
 * tokens / secrets / client ids cannot end up in the DB by
 * accident.
 */
export const META_CONNECTION_METADATA_KEYS = [
  'meta_page_id',
  'instagram_business_account_id',
  'meta_ad_account_id',
  'meta_app_id',
] as const

export type MetaConnectionMetadataKey =
  (typeof META_CONNECTION_METADATA_KEYS)[number]

/**
 * Sentinel substrings that should NEVER appear in metadata
 * keys — used by the admin route validators to reject
 * accidental token submissions before they touch the DB.
 */
export const FORBIDDEN_CONNECTION_METADATA_KEY_SUBSTRINGS = [
  'token',
  'secret',
  'access_token',
  'client_secret',
  'app_secret',
  'webhook_secret',
  'private_key',
  'refresh_token',
] as const

export function metadataKeyIsForbidden(key: string): boolean {
  const lower = key.toLowerCase()
  return FORBIDDEN_CONNECTION_METADATA_KEY_SUBSTRINGS.some((sub) =>
    lower.includes(sub)
  )
}

/**
 * Phase 8BF — Sanitize a channel-connection metadata payload
 * before it touches the DB.
 *
 *   - Drops any key matching `metadataKeyIsForbidden` (secrets,
 *     tokens, app secrets, page tokens, refresh tokens). The
 *     admin UI never asks for these; this defends against a
 *     direct API caller trying to stuff a token through the
 *     metadata field.
 *   - For Meta-family channels, additionally enforces the
 *     `META_CONNECTION_METADATA_KEYS` allowlist so an operator
 *     can't accidentally type a misspelled key into the form
 *     and end up with bogus metadata.
 *   - Returns a NEW object — never mutates the input.
 *
 * `droppedKeys` is reported back so the admin route can echo it
 * to the operator (helpful when a form field name typo
 * silently drops the value).
 */
export interface SanitizeChannelMetadataResult {
  metadata: Record<string, unknown>
  droppedKeys: string[]
  forbiddenKeys: string[]
}

const META_FAMILY_CHANNELS: ReadonlyArray<string> = [
  'instagram',
  'facebook',
  'meta_lead_ads',
]

export function sanitizeChannelConnectionMetadata(
  raw: Record<string, unknown> | null | undefined,
  channelType: string
): SanitizeChannelMetadataResult {
  const out: Record<string, unknown> = {}
  const dropped: string[] = []
  const forbidden: string[] = []
  if (!raw || typeof raw !== 'object') {
    return { metadata: out, droppedKeys: [], forbiddenKeys: [] }
  }
  const isMetaFamily = META_FAMILY_CHANNELS.includes(channelType)
  const allowlist: ReadonlyArray<string> = isMetaFamily
    ? META_CONNECTION_METADATA_KEYS
    : []

  for (const [key, value] of Object.entries(raw)) {
    if (metadataKeyIsForbidden(key)) {
      forbidden.push(key)
      continue
    }
    if (isMetaFamily && !allowlist.includes(key as MetaConnectionMetadataKey)) {
      dropped.push(key)
      continue
    }
    out[key] = value
  }
  return { metadata: out, droppedKeys: dropped, forbiddenKeys: forbidden }
}
