import 'server-only'
import Stripe from 'stripe'

/**
 * Phase 7C — Stripe client wrapper.
 *
 * Lazy singleton. We DO NOT construct the Stripe client at module-load time
 * because:
 *   - In local dev without `STRIPE_SECRET_KEY`, the rest of the app should
 *     continue to build, boot, and serve non-billing routes happily.
 *   - The build step (which evaluates server modules) shouldn't blow up on
 *     a missing key.
 *
 * The first caller of `stripe()` in a request scope materializes the client.
 * Routes that need Stripe call `stripe()` and let it throw with a clear
 * `billing_not_configured` error if the key is absent.
 *
 * API version is pinned to the SDK's compiled-in `LatestApiVersion` so a
 * `stripe` package bump doesn't silently shift the wire format. Override
 * with `STRIPE_API_VERSION` if you need to pin for testing against a
 * different version.
 *
 * `server-only` so an accidental client import fails the build before the
 * secret has a chance to leak.
 */

let cached: Stripe | null = null

export class BillingNotConfiguredError extends Error {
  constructor(message = 'billing_not_configured') {
    super(message)
    this.name = 'BillingNotConfiguredError'
  }
}

export function billingConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY
}

export function getStripeMode(): 'live' | 'test' | 'unknown' {
  const key = process.env.STRIPE_SECRET_KEY ?? ''
  if (key.startsWith('sk_live_')) return 'live'
  if (key.startsWith('sk_test_')) return 'test'
  return 'unknown'
}

export function stripe(): Stripe {
  if (cached) return cached
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    throw new BillingNotConfiguredError(
      'STRIPE_SECRET_KEY is not set — billing routes are unavailable.'
    )
  }
  // Pinned to the SDK's compiled-in version. Override via STRIPE_API_VERSION
  // only when you need to test against a different wire format. The SDK
  // doesn't re-export its `LatestApiVersion` literal union on the default
  // namespace; using `Parameters<typeof Stripe>` extracts the constructor's
  // config type directly without depending on the deep-import path.
  const apiVersionRaw = process.env.STRIPE_API_VERSION ?? '2026-04-22.dahlia'
  type StripeCtorConfig = ConstructorParameters<typeof Stripe>[1]
  const config: StripeCtorConfig = {
    apiVersion: apiVersionRaw as NonNullable<StripeCtorConfig>['apiVersion'],
    typescript: true,
    appInfo: {
      name: 'venuerise',
      version: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0',
    },
  }
  cached = new Stripe(key, config)
  return cached
}

/**
 * Construct the canonical Stripe webhook event from a raw request body +
 * signature header. Throws `BillingNotConfiguredError` if the webhook
 * secret is missing — callers should map that to a 503, not a 401, since
 * the failure isn't the caller's fault.
 *
 * Signature verification errors are surfaced as-is so the route layer can
 * map them to 401 (which is what Stripe expects on signature mismatch).
 */
export function constructWebhookEvent(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined = process.env.STRIPE_WEBHOOK_SECRET
): Stripe.Event {
  if (!secret) {
    throw new BillingNotConfiguredError(
      'STRIPE_WEBHOOK_SECRET is not set — webhook verification is unavailable.'
    )
  }
  if (!signatureHeader) {
    // Mirror Stripe's "signature verification failed" semantics so the
    // route layer can collapse both cases (missing + invalid) to 401.
    const err = new Error('Missing Stripe-Signature header')
    err.name = 'StripeSignatureVerificationError'
    throw err
  }
  return stripe().webhooks.constructEvent(rawBody, signatureHeader, secret)
}
