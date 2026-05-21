/**
 * Phase 9R — Plan feature gates (foundation only).
 *
 * Pure helper. No DB, no fetch, no side effects. The gates are designed
 * to be **called soon** — they are NOT wired into existing product code
 * in this phase. The Phase 9R rule is "plan foundation, not hard
 * enforcement". Sudden feature blocking would break trial users.
 *
 * Use sites in this phase:
 *   1. `SubscriptionPlansCard` checkmark rendering
 *   2. Future routes that want to soft-gate a feature can call
 *      `canUseFeature(planId, key)` and either render an "Upgrade
 *      required" UI or no-op when the plan covers the feature.
 *
 * Honesty contract:
 *   - Limits are PRODUCT controls (rate-limit-equivalent guidance),
 *     not legal/compliance guarantees.
 *   - We do NOT claim "no overage charges", "automatic enforcement",
 *     or "guaranteed compliance".
 */

import {
  BILLING_PLANS,
  BILLING_PLAN_ORDER,
  type BillingPlan,
  type BillingPlanFeatureKey,
  type BillingPlanId,
  isFeatureIncluded,
} from './plans'

/** True when the plan includes the feature. Treats `enterprise` as a
 *  full-coverage plan by definition (it lists every feature in its
 *  `features` array — this helper just reads that). */
export function canUseFeature(
  planId: BillingPlanId,
  featureKey: BillingPlanFeatureKey
): boolean {
  return isFeatureIncluded(planId, featureKey)
}

/** Returns the cheapest plan that includes the feature, or `null` when
 *  no plan covers it (shouldn't happen with the current catalog but
 *  keeps callers safe). Use in upgrade-CTA copy:
 *
 *  > Upgrade to **Growth** to unlock Tour booking surfaces.
 */
export function getUpgradeTargetForFeature(
  featureKey: BillingPlanFeatureKey
): BillingPlan | null {
  for (const id of BILLING_PLAN_ORDER) {
    const plan = BILLING_PLANS[id]
    if (plan.features.includes(featureKey)) return plan
  }
  return null
}

/** Operator-facing copy for a feature gate. Pure read-only — used by
 *  the future "Upgrade required" UI pattern. The label is what we'd
 *  show in a button; the helper sentence is what we'd show as
 *  supporting copy.
 *
 *  Wording is deliberately product-y, not legal — see honesty
 *  contract at the top of this file. */
export function getFeatureGateCopy(
  featureKey: BillingPlanFeatureKey
): { label: string; helper: string } {
  const target = getUpgradeTargetForFeature(featureKey)
  const planName = target?.name ?? 'a higher plan'
  return {
    label: `Available on ${planName}`,
    helper: `${FEATURE_LABEL[featureKey]} is included with the ${planName} plan. Plan limits are product controls, not legal or compliance guarantees.`,
  }
}

/** Stable feature label map used by the gate-copy helper + the
 *  SubscriptionPlansCard. Keep in sync with `BillingPlanFeatureKey`. */
export const FEATURE_LABEL: Readonly<Record<BillingPlanFeatureKey, string>> = {
  ai_inbox: 'AI inbox',
  website_widget: 'Website widget',
  lead_qualification: 'Lead qualification',
  speed_to_lead: 'Speed-to-lead tracking',
  revenue_leakage: 'Revenue leakage dashboard',
  follow_up_recovery: 'Follow-up recovery',
  tour_booking: 'Tour booking surfaces',
  omnichannel_inbox: 'Omnichannel inbox',
  attribution: 'Attribution reporting',
  reactivation: 'Reactivation queue',
  enterprise_audit: 'Enterprise audit views',
  trust_center: 'Trust Center workflows',
  privacy_readiness: 'Privacy / DSR readiness',
  sso_readiness: 'SSO readiness scaffolding',
  contract_commitments: 'Contract commitments tracking',
}
