import 'server-only'
import { cache } from 'react'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * Phase 7D — subscription status helper.
 *
 * Reads the latest subscription row for a venue from `public.subscriptions`
 * (Stripe is the source of truth; this table is the cache populated by
 * `/api/stripe/webhook` and the onboarding trial insert).
 *
 * USAGE PATTERNS
 *
 *   // Read-only — never throws on missing subscription.
 *   const status = await getVenueSubscriptionStatus(venueId)
 *   if (status.kind === 'active') ...
 *
 *   // Gate a write route — throws SubscriptionRequiredError (HTTP 402)
 *   // ONLY when BILLING_GATE_ENABLED=1. When the gate is off, this is a no-op.
 *   await requireActiveSubscription(venueId, { requestId, route })
 *
 * SERVICE-ROLE USAGE
 *   `public.subscriptions` is RLS-gated to ADMIN_ROLES for SELECT (migration
 *   007). The billing gate runs for ANY authenticated caller — including
 *   sales/coordinator/viewer — so we cannot use the user-scoped client
 *   here without locking out roles that should be subject to the gate.
 *   We use the service-role client and rely on the application-level
 *   `venueId` argument (already venue-scoped by the route's auth layer)
 *   for tenant isolation.
 *
 * REQUEST-SCOPED MEMOIZATION
 *   `getVenueSubscriptionStatus` is wrapped in React's `cache()` so a
 *   single request that touches both the layout banner AND a gated route
 *   only hits Postgres once. The wrapper is keyed by `venueId`.
 *
 * `server-only` to keep the service-role import out of the client bundle.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VenueSubscriptionStatus =
  | { kind: 'none' }
  | { kind: 'trialing'; trial_end: string | null; current_period_end: string | null }
  | { kind: 'active'; current_period_end: string | null; cancel_at_period_end: boolean }
  | { kind: 'past_due'; current_period_end: string | null }
  | { kind: 'canceled'; canceled_at: string | null }
  | { kind: 'incomplete' }
  | { kind: 'unknown'; raw_status: string }

export type SubscriptionKind = VenueSubscriptionStatus['kind']

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SubscriptionRequiredError extends Error {
  readonly status = 402 as const
  readonly code = 'subscription_required' as const
  constructor(public readonly subscriptionStatus: VenueSubscriptionStatus) {
    super('subscription_required')
    this.name = 'SubscriptionRequiredError'
  }
}

// ---------------------------------------------------------------------------
// Gate flag
// ---------------------------------------------------------------------------

/**
 * The gate is ENABLED only when the env value is exactly `'1'`. Anything
 * else — unset, empty, 'true', 'yes' — leaves it disabled. This makes
 * accidental activation impossible from a typoed value.
 */
export function billingGateEnabled(): boolean {
  return process.env.BILLING_GATE_ENABLED === '1'
}

// ---------------------------------------------------------------------------
// Status read
// ---------------------------------------------------------------------------

interface SubscriptionRow {
  status: string
  current_period_end: string | null
  trial_end: string | null
  canceled_at: string | null
  cancel_at_period_end: boolean | null
  created_at: string
}

/** Priority order when a venue has multiple subscription rows. */
const STATUS_PRIORITY: Record<string, number> = {
  active: 100,
  trialing: 90,
  past_due: 80,
  incomplete: 70,
  unpaid: 65,
  paused: 60,
  canceled: 50,
  incomplete_expired: 40,
}

function pickPrimaryRow(rows: SubscriptionRow[]): SubscriptionRow | null {
  if (rows.length === 0) return null
  // Sort by status priority desc, then by created_at desc — gives us the
  // "most relevant currently-applicable" row.
  return [...rows].sort((a, b) => {
    const ap = STATUS_PRIORITY[a.status] ?? 0
    const bp = STATUS_PRIORITY[b.status] ?? 0
    if (ap !== bp) return bp - ap
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })[0]
}

function rowToStatus(row: SubscriptionRow): VenueSubscriptionStatus {
  switch (row.status) {
    case 'trialing':
      return {
        kind: 'trialing',
        trial_end: row.trial_end,
        current_period_end: row.current_period_end,
      }
    case 'active':
      return {
        kind: 'active',
        current_period_end: row.current_period_end,
        cancel_at_period_end: Boolean(row.cancel_at_period_end),
      }
    case 'past_due':
    case 'unpaid':
      return {
        kind: 'past_due',
        current_period_end: row.current_period_end,
      }
    case 'canceled':
    case 'incomplete_expired':
      return { kind: 'canceled', canceled_at: row.canceled_at }
    case 'incomplete':
      return { kind: 'incomplete' }
    default:
      return { kind: 'unknown', raw_status: row.status }
  }
}

/**
 * Returns the venue's subscription status. Cached per-request via React's
 * `cache()` so banner + gate within the same request share one DB hit.
 *
 * Never throws on "no subscription" — returns `{ kind: 'none' }`. Throws on
 * actual infrastructure failures so a bad Supabase day doesn't silently
 * unlock the product.
 */
export const getVenueSubscriptionStatus = cache(
  async (venueId: string): Promise<VenueSubscriptionStatus> => {
    if (!venueId) return { kind: 'none' }
    const svc = createServiceClient()
    const { data, error } = await svc
      .from('subscriptions')
      .select('status, current_period_end, trial_end, canceled_at, cancel_at_period_end, created_at')
      .eq('venue_id', venueId)
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) {
      // DB read failure — surface so callers can decide whether to fail-open
      // (banner) or fail-closed (gate). We re-throw and let the gate's
      // try/catch convert to a 500 via the route's normal error path.
      log.error(
        { err: error, venueId, op: 'billing.status.read_failed' },
        'billing.status.read_failed'
      )
      captureApiError(error, { route: 'billing.getVenueSubscriptionStatus', venueId })
      throw error
    }

    const row = pickPrimaryRow((data ?? []) as SubscriptionRow[])
    if (!row) return { kind: 'none' }
    return rowToStatus(row)
  }
)

export function isSubscriptionActive(status: VenueSubscriptionStatus): boolean {
  return status.kind === 'active' || status.kind === 'trialing'
}

// ---------------------------------------------------------------------------
// requireActiveSubscription — the gate
// ---------------------------------------------------------------------------

export interface RequireSubscriptionContext {
  requestId?: string
  route?: string
}

/**
 * Throws `SubscriptionRequiredError` when the venue's subscription isn't
 * `active` or `trialing` AND the gate is enabled. No-op when the gate is
 * disabled or the venue is paid up.
 *
 * Failures to READ the subscription (Postgres down, etc.) re-throw the
 * underlying error rather than fabricating a 402 — we don't want a flaky
 * DB to silently demand a credit card.
 */
export async function requireActiveSubscription(
  venueId: string,
  ctx: RequireSubscriptionContext = {}
): Promise<void> {
  if (!billingGateEnabled()) return
  const status = await getVenueSubscriptionStatus(venueId)
  if (isSubscriptionActive(status)) return

  log.warn(
    {
      requestId: ctx.requestId,
      route: ctx.route,
      venueId,
      kind: status.kind,
    },
    'billing.gate.denied'
  )
  throw new SubscriptionRequiredError(status)
}
