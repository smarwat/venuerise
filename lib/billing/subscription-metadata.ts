import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * Phase 7L — atomic JSONB array append on `subscriptions.metadata`.
 *
 * Wraps the Postgres RPC `public.append_subscription_metadata_array(p_sub,
 * p_array_key, p_entry)` (migration 010). Solves the race documented in
 * Phase 7H + 7K where two writers (a billing cron + the Stripe webhook
 * sync) could both touch `metadata` and stomp each other.
 *
 * ── ERROR POSTURE ──────────────────────────────────────────────────────────
 * Returns the updated `metadata` object on success, `null` on failure.
 *
 * Failure modes:
 *   - RPC returned a Postgres error (e.g. "subscription not found") →
 *     logged + Sentry-captured, returns null.
 *   - Network / transport error → caught, logged + Sentry-captured,
 *     returns null.
 *
 * Callers (the cron jobs) treat `null` as "count as failed, continue
 * batch". They never throw to abort their run — losing one metadata
 * append is less bad than losing the rest of the batch.
 *
 * ── PRIVACY ────────────────────────────────────────────────────────────────
 * `entry` may contain provider message ids or other low-PII strings. We
 * log only the array key + the subscription id; the entry payload is
 * never serialized into log lines.
 *
 * `server-only` so the service-role import can't leak into client bundles.
 */

const RPC_NAME = 'append_subscription_metadata_array'

export type SubscriptionMetadataArrayKey =
  | 'reminders_sent'
  | 'dunning_sent'
  | (string & {})

export interface AppendSubscriptionMetadataArrayArgs {
  subscriptionId: string
  arrayKey: SubscriptionMetadataArrayKey
  entry: Record<string, unknown>
  requestId?: string
}

export async function appendSubscriptionMetadataArray(
  args: AppendSubscriptionMetadataArrayArgs
): Promise<Record<string, unknown> | null> {
  const { subscriptionId, arrayKey, entry, requestId } = args
  const reqLog = log.child({
    requestId,
    subscriptionId,
    arrayKey,
    op: 'billing.metadata.append',
  })

  const svc = createServiceClient()

  try {
    const { data, error } = await svc.rpc(RPC_NAME, {
      p_subscription_id: subscriptionId,
      p_array_key: arrayKey,
      p_entry: entry,
    })

    if (error) {
      reqLog.error(
        { err: error, code: error.code },
        'billing.metadata.append_rpc_error'
      )
      captureApiError(error, {
        requestId,
        route: 'billing.appendSubscriptionMetadataArray',
      })
      return null
    }

    if (data && typeof data === 'object') {
      return data as Record<string, unknown>
    }

    // RPC returned a non-object (shouldn't happen — the function returns
    // jsonb). Surface and treat as failure.
    reqLog.warn({ dataType: typeof data }, 'billing.metadata.append_unexpected_shape')
    return null
  } catch (err) {
    reqLog.error({ err }, 'billing.metadata.append_threw')
    captureApiError(err, {
      requestId,
      route: 'billing.appendSubscriptionMetadataArray',
    })
    return null
  }
}
