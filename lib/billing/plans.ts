/**
 * Phase 9R — Subscription plans + pricing tiers.
 *
 * Pure plan catalog. No DB, no Stripe SDK, no I/O. The catalog is the
 * single source of truth for:
 *   1. The `SubscriptionPlansCard` on /dashboard/settings/billing
 *   2. The `/api/billing/checkout` Stripe price resolver
 *   3. The future `lib/billing/plan-gates.ts` feature-gate helper
 *   4. Webhook → local subscription mapping (plan_id derivation
 *      from price id when Stripe doesn't carry our metadata)
 *
 * STRIPE PRICE IDs LIVE IN ENV
 * ---------------------------
 * Each non-Enterprise plan exposes `stripeMonthlyPriceEnv` and
 * `stripeAnnualPriceEnv` — the *names* of the env vars that hold the
 * Stripe `price_…` strings. We never inline a price ID. Operators wire
 * them in `.env.local` (see `.env.example` Phase 9R block).
 *
 * Enterprise is contact-sales by design — no Stripe price, no
 * checkout, no auto-provisioned tier. Plan limits are `'custom'`.
 *
 * HONESTY CONTRACT
 * ----------------
 * Plan bullets describe **product surfaces shipped today**. We do NOT
 * claim SOC 2, GDPR, HIPAA, PCI, real SSO, SCIM, or 24/7 monitoring.
 * The vocabulary stays: `readiness`, `evidence`, `operator-controlled`,
 * `available workflows`, `scaffolding`. The Enterprise tier surfaces
 * the readiness packs we already ship (Phases 9H–9P) — never a
 * compliance certification.
 *
 * Plan limits are **product controls** for the in-app workflows;
 * they are NOT legal/compliance guarantees and are not enforced
 * globally yet (see `lib/billing/plan-gates.ts`).
 */

export type BillingPlanId =
  | 'starter'
  | 'growth'
  | 'elite'
  | 'enterprise'

export type BillingPlanInterval = 'monthly' | 'annual'

export type BillingPlanFeatureKey =
  | 'ai_inbox'
  | 'website_widget'
  | 'lead_qualification'
  | 'speed_to_lead'
  | 'revenue_leakage'
  | 'follow_up_recovery'
  | 'tour_booking'
  | 'omnichannel_inbox'
  | 'attribution'
  | 'reactivation'
  | 'enterprise_audit'
  | 'trust_center'
  | 'privacy_readiness'
  | 'sso_readiness'
  | 'contract_commitments'

export type BillingPlanLimitKey =
  | 'venues'
  | 'leadsPerMonth'
  | 'adminSeats'
  | 'teamSeats'
  | 'aiDraftsPerMonth'

export interface BillingPlanLimits {
  venues: number | 'custom'
  leadsPerMonth: number | 'custom'
  adminSeats: number | 'custom'
  teamSeats: number | 'custom'
  aiDraftsPerMonth?: number | 'custom'
}

export interface BillingPlan {
  id: BillingPlanId
  name: string
  tagline: string
  monthlyPriceLabel: string
  annualPriceLabel?: string
  /** Env var **name** (not value) that holds the Stripe price id for
   *  monthly billing. Undefined for `enterprise`. */
  stripeMonthlyPriceEnv?: string
  /** Same as `stripeMonthlyPriceEnv` but for annual billing. */
  stripeAnnualPriceEnv?: string
  recommended?: boolean
  custom?: boolean
  limits: BillingPlanLimits
  features: BillingPlanFeatureKey[]
  bullets: string[]
}

// ──────────────────────────────────────────────────────────────────────
//  Catalog
//
//  Order matters — UI renders left → right in this order. Starter is
//  the easy yes; Growth is the recommended real offer; Elite is the
//  anchor; Enterprise is contact-sales.
// ──────────────────────────────────────────────────────────────────────

export const BILLING_PLANS: Readonly<Record<BillingPlanId, BillingPlan>> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    tagline: 'Speed-to-lead + basic AI inbox for a single venue.',
    monthlyPriceLabel: '$497/mo',
    stripeMonthlyPriceEnv: 'STRIPE_PRICE_STARTER_MONTHLY',
    stripeAnnualPriceEnv: 'STRIPE_PRICE_STARTER_ANNUAL',
    limits: {
      venues: 1,
      leadsPerMonth: 500,
      adminSeats: 1,
      teamSeats: 2,
    },
    features: [
      'ai_inbox',
      'website_widget',
      'lead_qualification',
      'speed_to_lead',
      'revenue_leakage',
    ],
    bullets: [
      '1 venue',
      'AI inbox + website widget',
      'Lead qualification + speed-to-lead tracking',
      'Basic Revenue OS dashboard',
      'Manual omnichannel workflows',
      'Up to 500 leads / month',
      '1 admin seat + 2 team seats',
    ],
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    tagline:
      'Recovery, tour booking, and multi-channel operations for active venues.',
    monthlyPriceLabel: '$997/mo',
    stripeMonthlyPriceEnv: 'STRIPE_PRICE_GROWTH_MONTHLY',
    stripeAnnualPriceEnv: 'STRIPE_PRICE_GROWTH_ANNUAL',
    recommended: true,
    limits: {
      venues: 1,
      leadsPerMonth: 2_500,
      adminSeats: 3,
      teamSeats: 10,
    },
    features: [
      'ai_inbox',
      'website_widget',
      'lead_qualification',
      'speed_to_lead',
      'revenue_leakage',
      'follow_up_recovery',
      'tour_booking',
      'omnichannel_inbox',
      'attribution',
    ],
    bullets: [
      'Everything in Starter',
      'Omnichannel source tracking',
      'Follow-up recovery surfaces',
      'Tour booking surfaces',
      'Attribution reporting',
      'AI draft variants + audit activity views',
      'Up to 2,500 leads / month',
      '3 admin seats + 10 team seats',
    ],
  },
  elite: {
    id: 'elite',
    name: 'Elite',
    tagline:
      'Deeper operational intelligence for high-volume venues and groups.',
    monthlyPriceLabel: '$1,997/mo',
    stripeMonthlyPriceEnv: 'STRIPE_PRICE_ELITE_MONTHLY',
    stripeAnnualPriceEnv: 'STRIPE_PRICE_ELITE_ANNUAL',
    limits: {
      venues: 5,
      leadsPerMonth: 10_000,
      adminSeats: 10,
      teamSeats: 30,
    },
    features: [
      'ai_inbox',
      'website_widget',
      'lead_qualification',
      'speed_to_lead',
      'revenue_leakage',
      'follow_up_recovery',
      'tour_booking',
      'omnichannel_inbox',
      'attribution',
      'reactivation',
      'enterprise_audit',
      'trust_center',
    ],
    bullets: [
      'Everything in Growth',
      'Multi-venue support (where schema supports it)',
      'Advanced revenue leakage analytics',
      'Reactivation queue',
      'Enterprise audit views',
      'Trust / security readiness surfaces',
      'Priority support label',
      'Up to 10,000 leads / month',
      '10 admin seats + 30 team seats',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'For venue groups and procurement-heavy customers.',
    monthlyPriceLabel: 'Custom',
    custom: true,
    limits: {
      venues: 'custom',
      leadsPerMonth: 'custom',
      adminSeats: 'custom',
      teamSeats: 'custom',
      aiDraftsPerMonth: 'custom',
    },
    features: [
      'ai_inbox',
      'website_widget',
      'lead_qualification',
      'speed_to_lead',
      'revenue_leakage',
      'follow_up_recovery',
      'tour_booking',
      'omnichannel_inbox',
      'attribution',
      'reactivation',
      'enterprise_audit',
      'trust_center',
      'privacy_readiness',
      'sso_readiness',
      'contract_commitments',
    ],
    bullets: [
      'Everything in Elite',
      'Custom limits + onboarding',
      'Security questionnaire support',
      'Trust Center access workflows',
      'Enterprise evidence pack',
      'DSR / privacy readiness workflows',
      'SSO readiness scaffolding',
      'Contract commitments tracking',
    ],
  },
}

/** Ordered for left → right UI rendering. */
export const BILLING_PLAN_ORDER: ReadonlyArray<BillingPlanId> = [
  'starter',
  'growth',
  'elite',
  'enterprise',
]

// ──────────────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────────────

/** Returns the plan definition. Returns `null` for unknown ids so callers
 *  can fail-soft (e.g. `getBillingPlan(unknown)?.name ?? 'Custom'`). */
export function getBillingPlan(planId: string): BillingPlan | null {
  if (!isBillingPlanId(planId)) return null
  return BILLING_PLANS[planId]
}

/** Type guard. */
export function isBillingPlanId(value: unknown): value is BillingPlanId {
  return (
    typeof value === 'string' &&
    (value === 'starter' ||
      value === 'growth' ||
      value === 'elite' ||
      value === 'enterprise')
  )
}

/** Throws when the id is not a known plan. Used at route boundaries
 *  where an invalid plan is a 400, not a fallback. */
export function assertKnownBillingPlan(value: unknown): BillingPlanId {
  if (!isBillingPlanId(value)) {
    throw new Error(`unknown_billing_plan: ${String(value)}`)
  }
  return value
}

/** Resolves the Stripe price id for a plan + interval. Returns `null`
 *  when the env var isn't set OR when the plan has no Stripe price
 *  (Enterprise). Callers should branch on `null` and either return
 *  `stripe_price_not_configured` (paid plans) or
 *  `enterprise_contact_required` (Enterprise). */
export function getPlanStripePriceId(
  planId: BillingPlanId,
  interval: BillingPlanInterval = 'monthly'
): string | null {
  const plan = BILLING_PLANS[planId]
  if (plan.custom) return null
  const envName =
    interval === 'annual' ? plan.stripeAnnualPriceEnv : plan.stripeMonthlyPriceEnv
  if (!envName) return null
  const value = process.env[envName]
  if (typeof value !== 'string' || value.length === 0) return null
  return value
}

/** True when the feature is included in the plan. Use for UI checkmark
 *  rendering + the future feature-gate helper. */
export function isFeatureIncluded(
  planId: BillingPlanId,
  feature: BillingPlanFeatureKey
): boolean {
  return BILLING_PLANS[planId].features.includes(feature)
}

/** Pulls a single limit from the plan. `'custom'` flows through
 *  unchanged so the UI can render "Custom" without numeric handling. */
export function getPlanLimit(
  planId: BillingPlanId,
  limitKey: BillingPlanLimitKey
): number | 'custom' | undefined {
  return BILLING_PLANS[planId].limits[limitKey]
}

/** Reverse lookup: given a Stripe price id (from
 *  `subscriptions.stripe_price_id`), return which plan + interval it
 *  belongs to. Returns `null` when the price id doesn't match any
 *  configured env var — that happens for venues on legacy prices or
 *  when the env hasn't been wired up yet.
 *
 *  This is the bridge that lets UI display "Current plan: Growth"
 *  without needing a migration to add `billing_plan` to `venues`. */
export function lookupPlanByStripePriceId(
  priceId: string | null | undefined
): { planId: BillingPlanId; interval: BillingPlanInterval } | null {
  if (!priceId) return null
  for (const planId of BILLING_PLAN_ORDER) {
    const plan = BILLING_PLANS[planId]
    if (plan.custom) continue
    const monthly = plan.stripeMonthlyPriceEnv
      ? process.env[plan.stripeMonthlyPriceEnv]
      : null
    if (monthly && monthly === priceId) {
      return { planId, interval: 'monthly' }
    }
    const annual = plan.stripeAnnualPriceEnv
      ? process.env[plan.stripeAnnualPriceEnv]
      : null
    if (annual && annual === priceId) {
      return { planId, interval: 'annual' }
    }
  }
  return null
}
