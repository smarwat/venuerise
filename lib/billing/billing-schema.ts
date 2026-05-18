import { z } from 'zod'

/**
 * Phase 7C — billing payload schemas.
 *
 * `price_id` is optional on the wire: if the caller omits it, the route
 * falls back to `STRIPE_DEFAULT_PRICE_ID`. That keeps the future single-
 * plan UX (one CTA, no plan picker) trivial — the client just POSTs `{}`
 * to `/api/billing/checkout` and we resolve the price server-side.
 *
 * If a caller supplies `price_id`, we accept anything non-empty and bound
 * the length so an attacker can't ship a giant payload. The string is
 * eventually passed to Stripe which does its own validation.
 */
export const CheckoutSessionSchema = z.object({
  price_id: z.string().min(1).max(255).optional(),
})

export type CheckoutSessionPayload = z.infer<typeof CheckoutSessionSchema>
