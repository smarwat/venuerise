import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { getChannelCapabilities } from '@/lib/integrations/channels/capabilities'
import type { ChannelType } from '@/lib/integrations/channels/types'

/**
 * Phase 8BE-2 — Inbox channel metadata join.
 *
 * Given a set of conversation ids, returns a map keyed by
 * conversation id with the channel posture the inbox needs
 * to render the source badge + the manual-required banner.
 *
 * Resolution strategy:
 *   1. Prefer the most-recent `external_conversations` row
 *      that links the conversation to a channel.
 *   2. Fall back to the most-recent `messages.metadata.channel_type`
 *      stamp for legacy ingestion paths that never wrote an
 *      external_conversations row.
 *   3. Return null when neither source has channel context —
 *      the badge hides gracefully.
 *
 * Service-role read so the loader can populate the badge
 * regardless of the operator's role (the UI badge is non-
 * sensitive — channel posture is already exposed via the
 * ChannelConnectionsCard).
 */

export interface InboxChannelMeta {
  channelType: ChannelType
  manualReplyRequired: boolean
  displayName: string
  externalThreadId: string | null
  /**
   * Phase 8BG — latest-message parse-review flag. True when at
   * least one recent inbound message for this conversation
   * carries `parse_needs_review === true`. Drives the warning
   * dot in ConversationList rows.
   */
  parseNeedsReview: boolean
}

export type InboxChannelMap = Map<string, InboxChannelMeta>

const EMPTY_MAP: InboxChannelMap = new Map()

function toMeta(
  channelType: ChannelType,
  externalThreadId: string | null,
  parseNeedsReview = false
): InboxChannelMeta {
  const caps = getChannelCapabilities(channelType)
  return {
    channelType,
    manualReplyRequired: caps.manualReplyRequired,
    displayName: caps.displayName,
    externalThreadId,
    parseNeedsReview,
  }
}

export async function loadInboxChannelMap(
  venueId: string | null,
  conversationIds: ReadonlyArray<string>
): Promise<InboxChannelMap> {
  if (!venueId || conversationIds.length === 0) return EMPTY_MAP

  const ids = Array.from(new Set(conversationIds.filter(Boolean)))
  if (ids.length === 0) return EMPTY_MAP

  const supabase = createServiceClient()
  const out: InboxChannelMap = new Map()

  // ── 1. external_conversations join ────────────────────────────────────
  try {
    const { data, error } = await supabase
      .from('external_conversations')
      .select('conversation_id, channel_type, external_thread_id, updated_at')
      .eq('venue_id', venueId)
      .in('conversation_id', ids)
      .order('updated_at', { ascending: false })
    if (error) {
      log.warn(
        {
          op: 'integrations.channels.inbox.lookup_failed',
          venueId,
          errorMessage: error.message,
        },
        'inbox_channels.external_lookup_failed'
      )
    } else if (data) {
      for (const row of data as Array<{
        conversation_id: string | null
        channel_type: string | null
        external_thread_id: string | null
      }>) {
        if (!row.conversation_id || !row.channel_type) continue
        // Newest row per conversation wins — we already ordered DESC.
        if (out.has(row.conversation_id)) continue
        out.set(
          row.conversation_id,
          toMeta(row.channel_type as ChannelType, row.external_thread_id ?? null)
        )
      }
    }
  } catch (err) {
    log.warn(
      { op: 'integrations.channels.inbox.lookup_threw', venueId, err },
      'inbox_channels.external_lookup_threw'
    )
  }

  // ── 2. messages.metadata sweep — pulls the latest few rows per
  // conversation so we can both (a) fall back to channel_type for
  // conversations without an external_conversations row, and (b)
  // bubble up the most-recent `parse_needs_review` signal for the
  // ConversationList warning dot.
  try {
    const { data } = await supabase
      .from('messages')
      .select('conversation_id, metadata, created_at')
      .eq('venue_id', venueId)
      .in('conversation_id', ids)
      .not('metadata', 'is', null)
      .order('created_at', { ascending: false })
      .limit(ids.length * 8) // tolerate a few rows per convo
    if (data) {
      const sawReviewFlag = new Set<string>()
      for (const row of data as Array<{
        conversation_id: string
        metadata: Record<string, unknown> | null
      }>) {
        const md = row.metadata
        if (!md) continue
        // Track parse-review flag regardless of whether we already
        // have a channel mapping — newest-first walk means the
        // first hit per conversation wins, matching "latest
        // message needs review".
        if (
          md['parse_needs_review'] === true &&
          !sawReviewFlag.has(row.conversation_id)
        ) {
          sawReviewFlag.add(row.conversation_id)
          const existing = out.get(row.conversation_id)
          if (existing) {
            out.set(row.conversation_id, {
              ...existing,
              parseNeedsReview: true,
            })
          }
        }
        // Channel-type fallback only fires for conversations that
        // didn't get a mapping from external_conversations.
        if (out.has(row.conversation_id)) continue
        const ct = md['channel_type']
        if (typeof ct !== 'string') continue
        const caps = getChannelCapabilities(ct)
        if (caps === getChannelCapabilities('manual') && ct !== 'manual') {
          // Unknown channel string — fallback handler returns the
          // manual capabilities. Skip to avoid mislabeling.
          continue
        }
        out.set(
          row.conversation_id,
          toMeta(
            ct as ChannelType,
            null,
            sawReviewFlag.has(row.conversation_id)
          )
        )
      }
    }
  } catch (err) {
    log.warn(
      { op: 'integrations.channels.inbox.message_lookup_threw', venueId, err },
      'inbox_channels.message_lookup_threw'
    )
  }

  return out
}
