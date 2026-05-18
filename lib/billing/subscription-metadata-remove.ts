import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * Phase 7N — prefix-scoped removal from a JSONB array on
 * `subscriptions.metadata`.
 *
 * Wraps the Postgres RPC `public.remove_subscription_metadata_array_entries`
 * (migration 011). Designed for the admin clear-dunning escape hatch but
 * the helper is generic — any caller that needs prefix-based deletion
 * from a metadata array can use it (we don't expose a second route yet).
 *
 * ── ERROR POSTURE ──────────────────────────────────────────────────────────
 * Returns the updated `metadata` object on success, `null` on failure.
 * Mirrors the Phase 7L append helper's contract so callers can treat both
 * sides of the RPC pair identically.
 *
 * Failure modes:
 *   - RPC raises (e.g. "subscription not found", "key prefix is required")
 *     → logged + Sentry-captured, returns null.
 *   - Network / transport error → caught, logged + Sentry-captured,
 *     returns null.
 *
 * Callers map `null` to a structured 4xx/5xx response. Never throws so
 * batch operations can keep moving.
 *
 * ── PRIVACY ────────────────────────────────────────────────────────────────
 * We log the subscription id, array key, and key PREFIX (not the full
 * entries that were removed). The full metadata object is never serialized
 * into a log line.
 *
 * `server-only` so the service-role import can't leak into client bundles.
 */

const RPC_NAME = 'remove_subscription_metadata_array_entries'

export interface RemoveSubscriptionMetadataArrayEntriesArgs {
  subscriptionId: string
  arrayKey: string
  keyPrefix: string
  requestId?: string
}

export async function removeSubscriptionMetadataArrayEntries(
  args: RemoveSubscriptionMetadataArrayEntriesArgs
): Promise<Record<string, unknown> | null> {
  const { subscriptionId, arrayKey, keyPrefix, requestId } = args
  const reqLog = log.child({
    requestId,
    subscriptionId,
    arrayKey,
    keyPrefix,
    op: 'billing.metadata.remove_prefix',
  })

  if (!keyPrefix || keyPrefix.trim().length === 0) {
    // Cheap pre-check; the SQL would raise but we'd rather not pay the
    // round-trip + Sentry capture for a clear programming error.
    reqLog.error({}, 'billing.metadata.remove_prefix_empty')
    return null
  }

  const svc = createServiceClient()

  try {
    const { data, error } = await svc.rpc(RPC_NAME, {
      p_subscription_id: subscriptionId,
      p_array_key: arrayKey,
      p_key_prefix: keyPrefix,
    })

    if (error) {
      reqLog.error(
        { err: error, code: error.code },
        'billing.metadata.remove_rpc_error'
      )
      captureApiError(error, {
        requestId,
        route: 'billing.removeSubscriptionMetadataArrayEntries',
      })
      return null
    }

    if (data && typeof data === 'object') {
      return data as Record<string, unknown>
    }

    reqLog.warn(
      { dataType: typeof data },
      'billing.metadata.remove_unexpected_shape'
    )
    return null
  } catch (err) {
    reqLog.error({ err }, 'billing.metadata.remove_threw')
    captureApiError(err, {
      requestId,
      route: 'billing.removeSubscriptionMetadataArrayEntries',
    })
    return null
  }
}
