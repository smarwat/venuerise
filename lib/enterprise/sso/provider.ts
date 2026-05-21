import type {
  SsoCallbackInput,
  SsoCallbackResult,
  SsoInitiateInput,
  SsoInitiateResult,
  SsoProtocol,
  SsoProvider,
} from '@/lib/enterprise/sso/types'
import { notConfiguredAdapter } from '@/lib/enterprise/sso/adapters/not-configured'

/**
 * Phase 9G — SSO provider adapter interface.
 *
 * Vendor SDKs (WorkOS, Clerk, Stytch, Supabase SSO, custom OIDC)
 * each get a thin adapter that satisfies this interface. The
 * routes never import a vendor SDK directly — they go through
 * `resolveSsoAdapter()` so swapping a vendor is an adapter-file
 * change, not a route rewrite.
 *
 * No real adapter ships in Phase 9G. Every provider resolves to
 * the `notConfiguredAdapter` placeholder, which returns
 * structured "not configured" errors. The next phase wires a real
 * SDK in behind the same shape.
 */

export interface SsoProviderAdapter {
  provider: SsoProvider
  protocol: SsoProtocol
  /**
   * Begin an auth flow. Real adapters return a redirect URL the
   * route hands back to the browser. Placeholder returns
   * `SSO_PROVIDER_NOT_CONFIGURED`.
   */
  initiate(input: SsoInitiateInput): Promise<SsoInitiateResult>
  /**
   * Handle the vendor's callback POST/GET. Real adapters validate
   * the assertion + resolve a user. Placeholder returns
   * `SSO_CALLBACK_NOT_CONFIGURED`.
   */
  handleCallback(input: SsoCallbackInput): Promise<SsoCallbackResult>
}

/**
 * Look up the adapter for a provider/protocol pair. Returns the
 * placeholder in 9G; a future phase swaps real adapters in.
 *
 * `protocol` is taken from the connection row (not the provider's
 * default) so a provider that supports both SAML and OIDC can be
 * wired for either per connection.
 */
export function resolveSsoAdapter(
  provider: SsoProvider,
  protocol: SsoProtocol
): SsoProviderAdapter {
  // Phase 9G — every path lands on the placeholder. The signature
  // is in place so adapter wiring is a single-file change later.
  return notConfiguredAdapter(provider, protocol)
}
