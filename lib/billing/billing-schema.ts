import { z } from 'zod'

/**
 * Phase 7C — billing payload schemas.
 *
 * `price_id` is optional on the wire: if the caller omits it, the route
 * falls back to `STRIPE_DEFAULT_PRICE_ID`. That keeps the legacy single-
 * plan UX (one CTA, no plan picker) trivial — the client just POSTs `{}`
 * to `/api/billing/checkout` and we resolve the price server-side.
 *
 * Phase 9R — added `plan_id` + `interval`. When `plan_id` is supplied,
 * the route resolves the Stripe price id via `lib/billing/plans.ts`,
 * bypassing `price_id` / `STRIPE_DEFAULT_PRICE_ID`. The order of
 * precedence in the route is:
 *
 *   1. plan_id (Phase 9R, SubscriptionPlansCard)
 *   2. price_id (legacy, explicit)
 *   3. STRIPE_DEFAULT_PRICE_ID (legacy default)
 *
 * `enterprise` is explicitly rejected with `enterprise_contact_required`;
 * the catalog has no Stripe price for it.
 *
 * If a caller supplies `price_id`, we accept anything non-empty and bound
 * the length so an attacker can't ship a giant payload. The string is
 * eventually passed to Stripe which does its own validation.
 */
export const CheckoutSessionSchema = z.object({
  price_id: z.string().min(1).max(255).optional(),
  // Phase 9R — keep the allowlist strict so an unknown plan returns
  // 400 `validation_failed` rather than reaching the price resolver
  // and producing `stripe_price_not_configured`.
  plan_id: z.enum(['starter', 'growth', 'elite', 'enterprise']).optional(),
  interval: z.enum(['monthly', 'annual']).optional(),
  // Phase 9R — optional caller hint propagated into audit metadata.
  // Not echoed to Stripe.
  source: z.string().min(1).max(64).optional(),
})

export type CheckoutSessionPayload = z.infer<typeof CheckoutSessionSchema>
