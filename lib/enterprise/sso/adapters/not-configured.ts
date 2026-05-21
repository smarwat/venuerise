import type {
  SsoCallbackInput,
  SsoCallbackResult,
  SsoInitiateInput,
  SsoInitiateResult,
  SsoProtocol,
  SsoProvider,
} from '@/lib/enterprise/sso/types'
import type { SsoProviderAdapter } from '@/lib/enterprise/sso/provider'

/**
 * Phase 9G — Placeholder SSO adapter.
 *
 * Returned by `resolveSsoAdapter()` for every provider/protocol
 * pair until real vendor adapters land. Both methods reject with
 * structured `SsoErrorCode` values so the routes can surface a
 * stable response shape AND the audit pipeline can record a
 * meaningful `reason` field.
 *
 * The factory takes provider + protocol so the returned adapter's
 * identity fields (`adapter.provider`, `adapter.protocol`) match
 * the connection row the caller looked up — diagnostics see the
 * intended vendor even when the implementation is the placeholder.
 *
 * NOTHING in this file performs an actual auth exchange. NEVER
 * inspects request bodies. NEVER touches the database.
 */

export function notConfiguredAdapter(
  provider: SsoProvider,
  protocol: SsoProtocol
): SsoProviderAdapter {
  return {
    provider,
    protocol,
    async initiate(_input: SsoInitiateInput): Promise<SsoInitiateResult> {
      return {
        ok: false,
        code: 'SSO_PROVIDER_NOT_CONFIGURED',
        message: `${provider}/${protocol} adapter is not configured yet. SSO is in readiness mode (Phase 9G).`,
      }
    },
    async handleCallback(_input: SsoCallbackInput): Promise<SsoCallbackResult> {
      return {
        ok: false,
        code: 'SSO_CALLBACK_NOT_CONFIGURED',
        message: `${provider}/${protocol} callback handler is not configured yet. SSO is in readiness mode (Phase 9G).`,
      }
    },
  }
}
