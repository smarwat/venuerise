import 'server-only'
import { cache } from 'react'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import {
  type BillingPlanId,
  type BillingPlanInterval,
  isBillingPlanId,
  lookupPlanByStripePriceId,
} from './plans'

/**
 * Phase 9R — current plan resolver for `SubscriptionPlansCard`.
 *
 * Reads the venue's latest subscription row and returns the plan id +
 * interval the venue is on, derived in this order:
 *
 *   1. `subscriptions.metadata.plan_id` (set by Phase 9R checkout)
 *   2. `subscriptions.stripe_price_id` → reverse-lookup against the
 *      env-configured plan catalog (Phase 9R `lookupPlanByStripePriceId`)
 *
 * Returns `null` when neither path resolves — the card then renders
 * "Current plan: Not set" and prompts the operator to choose one.
 *
 * Service-role read because `subscriptions` is RLS-gated to
 * ADMIN_ROLES for SELECT (migration 007). Callers are responsible for
 * gating who sees this surface; the helper itself is venue-scoped via
 * the `venueId` argument.
 *
 * Request-memoized via React `cache()` so multiple card mounts in the
 * same request reuse one Postgres hit.
 */

export interface CurrentPlan {
  planId: BillingPlanId
  interval: BillingPlanInterval | null
  /** Origin of the resolution — used for logs / debug + the card
   *  surfacing "derived from price id" when metadata is missing. */
  source: 'metadata' | 'price_id'
}

export const getCurrentPlanForVenue = cache(
  async (venueId: string): Promise<CurrentPlan | null> => {
    if (!venueId) return null
    const svc = createServiceClient()
    const { data, error } = await svc
      .from('subscriptions')
      .select('status, stripe_price_id, metadata, created_at')
      .eq('venue_id', venueId)
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) {
      log.warn(
        { err: error, venueId, op: 'billing.current_plan.read_failed' },
        'billing.current_plan.read_failed'
      )
      // Never throw — the card falls through to "Not set" rather
      // than failing the whole billing page on a transient read.
      return null
    }

    type Row = {
      status: string | null
      stripe_price_id: string | null
      metadata: Record<string, unknown> | null
      created_at: string
    }
    const rows = (data ?? []) as Row[]

    // Prefer the most relevant row: active > trialing > past_due >
    // anything else. Falls back to created_at desc within a tier.
    const PRIORITY: Record<string, number> = {
      active: 100,
      trialing: 90,
      past_due: 80,
      incomplete: 70,
      paused: 60,
      canceled: 50,
    }
    const sorted = [...rows].sort((a, b) => {
      const ap = PRIORITY[a.status ?? ''] ?? 0
      const bp = PRIORITY[b.status ?? ''] ?? 0
      if (ap !== bp) return bp - ap
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })

    for (const row of sorted) {
      // Path 1 — metadata.plan_id wins.
      const metaPlanId = row.metadata?.plan_id
      if (isBillingPlanId(metaPlanId)) {
        const metaInterval = row.metadata?.interval
        const interval: BillingPlanInterval | null =
          metaInterval === 'monthly' || metaInterval === 'annual'
            ? metaInterval
            : null
        return { planId: metaPlanId, interval, source: 'metadata' }
      }
      // Path 2 — stripe_price_id reverse lookup.
      const fromPrice = lookupPlanByStripePriceId(row.stripe_price_id)
      if (fromPrice) {
        return {
          planId: fromPrice.planId,
          interval: fromPrice.interval,
          source: 'price_id',
        }
      }
    }
    return null
  }
)
