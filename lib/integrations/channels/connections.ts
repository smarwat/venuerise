import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import {
  CHANNEL_CAPABILITIES,
  OMNICHANNEL_INBOX_DISCLAIMER,
} from '@/lib/integrations/channels/capabilities'
import {
  CHANNEL_TYPES,
  type ChannelConnectionCreateInput,
  type ChannelConnectionListSummary,
  type ChannelConnectionRecord,
  type ChannelConnectionUpdateInput,
  type ChannelType,
} from '@/lib/integrations/channels/types'

/**
 * Phase 8BE — Channel connections helper.
 *
 * Thin service-role wrappers used by the admin routes.
 * Connection rows do NOT carry secrets / tokens — when a
 * real OAuth connector ships in a future phase the encrypted
 * credentials live elsewhere and are joined by id.
 */

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

export async function listChannelConnections(args: {
  venueId: string | null
}): Promise<ChannelConnectionListSummary> {
  if (!args.venueId) {
    return {
      generatedAt: new Date().toISOString(),
      disclaimer: OMNICHANNEL_INBOX_DISCLAIMER,
      items: CHANNEL_TYPES.map((c) => ({
        channelType: c,
        capabilities: CHANNEL_CAPABILITIES[c],
        manualReplyRequired: CHANNEL_CAPABILITIES[c].manualReplyRequired,
        connection: null,
      })),
    }
  }
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_channel_connections')
    .select('*')
    .eq('venue_id', args.venueId)
    .order('created_at', { ascending: true })
  if (error) {
    log.warn(
      { op: 'channels.connections.list_failed', venueId: args.venueId,
        errorMessage: error.message },
      'channels.connections.list_failed'
    )
    captureApiError(error, {
      route: 'integrations.channels.connections.list',
      venueId: args.venueId,
    })
  }
  const rows = (data ?? []).map((r) => asConnectionRecord(r as Record<string, unknown>))
  // Group by channel — pick the most-recently-updated row per
  // channel for the summary. Connections with `disconnected`
  // status still appear so the operator sees the history.
  const byChannel = new Map<ChannelType, ChannelConnectionRecord>()
  for (const r of rows) {
    const existing = byChannel.get(r.channelType)
    if (!existing) byChannel.set(r.channelType, r)
    else if (
      Date.parse(r.updatedAt) > Date.parse(existing.updatedAt)
    ) {
      byChannel.set(r.channelType, r)
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    disclaimer: OMNICHANNEL_INBOX_DISCLAIMER,
    items: CHANNEL_TYPES.map((c) => {
      const conn = byChannel.get(c) ?? null
      return {
        channelType: c,
        capabilities: CHANNEL_CAPABILITIES[c],
        manualReplyRequired: CHANNEL_CAPABILITIES[c].manualReplyRequired,
        connection: conn,
      }
    }),
  }
}

export async function createChannelConnection(
  input: ChannelConnectionCreateInput
): Promise<
  | { ok: true; connection: ChannelConnectionRecord }
  | { ok: false; code: 'validation_failed' | 'duplicate' | 'unexpected_error'; message: string }
> {
  if (!input.venueId || !input.channelType) {
    return {
      ok: false,
      code: 'validation_failed',
      message: 'venue_id and channel_type are required',
    }
  }
  if (!(input.channelType in CHANNEL_CAPABILITIES)) {
    return {
      ok: false,
      code: 'validation_failed',
      message: 'unknown channel_type',
    }
  }
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_channel_connections')
    .insert({
      venue_id: input.venueId,
      channel_type: input.channelType,
      status: input.status ?? 'draft',
      external_account_label: input.externalAccountLabel ?? null,
      external_account_id: input.externalAccountId ?? null,
      metadata: input.metadata ?? {},
      created_by: input.createdBy,
    })
    .select('*')
    .single()
  if (error) {
    if (error.code === '23505') {
      return {
        ok: false,
        code: 'duplicate',
        message: 'connection already exists for that account',
      }
    }
    log.error(
      { op: 'channels.connections.create_failed',
        venueId: input.venueId, errorMessage: error.message },
      'channels.connections.create_failed'
    )
    captureApiError(error, {
      route: 'integrations.channels.connections.create',
      venueId: input.venueId,
    })
    return {
      ok: false,
      code: 'unexpected_error',
      message: 'insert failed',
    }
  }
  return { ok: true, connection: asConnectionRecord(data as Record<string, unknown>) }
}

export async function updateChannelConnection(
  input: ChannelConnectionUpdateInput
): Promise<
  | { ok: true; connection: ChannelConnectionRecord }
  | { ok: false; code: 'not_found' | 'validation_failed' | 'unexpected_error'; message: string }
> {
  if (!input.connectionId) {
    return {
      ok: false,
      code: 'validation_failed',
      message: 'connection_id is required',
    }
  }
  const supabase = createServiceClient()
  const patch: Record<string, unknown> = {}
  if (input.externalAccountLabel !== undefined) {
    patch.external_account_label = input.externalAccountLabel ?? null
  }
  if (input.status !== undefined) patch.status = input.status
  if (input.metadata !== undefined) patch.metadata = input.metadata ?? {}
  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      code: 'validation_failed',
      message: 'no updatable fields supplied',
    }
  }
  const { data, error } = await supabase
    .from('venue_channel_connections')
    .update(patch)
    .eq('id', input.connectionId)
    .select('*')
    .maybeSingle()
  if (error) {
    log.error(
      { op: 'channels.connections.update_failed',
        connectionId: input.connectionId, errorMessage: error.message },
      'channels.connections.update_failed'
    )
    captureApiError(error, {
      route: 'integrations.channels.connections.update',
    })
    return {
      ok: false,
      code: 'unexpected_error',
      message: 'update failed',
    }
  }
  if (!data) {
    return { ok: false, code: 'not_found', message: 'connection not found' }
  }
  return { ok: true, connection: asConnectionRecord(data as Record<string, unknown>) }
}

export async function getChannelConnection(
  connectionId: string
): Promise<ChannelConnectionRecord | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('venue_channel_connections')
    .select('*')
    .eq('id', connectionId)
    .maybeSingle()
  if (!data) return null
  return asConnectionRecord(data as Record<string, unknown>)
}
