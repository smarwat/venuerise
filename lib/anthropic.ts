import 'server-only'
import Anthropic from '@anthropic-ai/sdk'

/**
 * Anthropic SDK client — lazy + typed.
 *
 * Previously this file eagerly constructed the SDK at module-load time
 * with `apiKey: process.env.ANTHROPIC_API_KEY!`. When the env var was
 * missing the SDK got `apiKey: undefined` and then threw the cryptic
 *
 *   "Could not resolve authentication method. Expected one of apiKey,
 *    authToken, credentials, config, or profile to be set."
 *
 * on the FIRST `messages.create(...)` call, which surfaced as a generic
 * 500 from `/api/ai/{chat,qualify,followup}` with the raw SDK message
 * leaked into the response body.
 *
 * New shape:
 *
 *   - `getAnthropic()` builds the client on first call and caches it.
 *     If `ANTHROPIC_API_KEY` is missing/empty, throws the typed
 *     `AnthropicNotConfiguredError` synchronously so route handlers can
 *     map it to a clean 503 instead of letting the SDK's internal
 *     auth-resolver error escape.
 *
 *   - `anthropicConfigured()` is a pure env-presence probe (no client
 *     construction). Used by `/api/readiness` + by route handlers that
 *     want to short-circuit before reading the body.
 *
 *   - The api key value is NEVER included in any error, log, or
 *     response — only the typed code.
 *
 * `server-only` so an accidental client import fails the build.
 */

export const MODEL = 'claude-sonnet-4-5'

export class AnthropicNotConfiguredError extends Error {
  readonly code = 'anthropic_not_configured' as const
  readonly status = 503 as const
  constructor() {
    super('anthropic_not_configured')
    this.name = 'AnthropicNotConfiguredError'
  }
}

let cachedClient: Anthropic | null = null

/**
 * Pure env-presence check. Mirrors the convention used by other lazy
 * integrations in this codebase (e.g. `emailConfigured()`).
 *
 * A non-empty `ANTHROPIC_API_KEY` is the minimum bar; the SDK will
 * later reject malformed keys at API call time, but that's a fault we
 * want to surface as a real 5xx, not as `anthropic_not_configured`.
 */
export function anthropicConfigured(): boolean {
  const k = process.env.ANTHROPIC_API_KEY
  return typeof k === 'string' && k.length > 0
}

/**
 * Returns the cached Anthropic client. Builds it on the first call.
 *
 * Throws `AnthropicNotConfiguredError` (status 503, code
 * 'anthropic_not_configured') when the env var is missing — callers
 * should `try/catch` and map to a 503 JSON response.
 */
export function getAnthropic(): Anthropic {
  if (cachedClient) return cachedClient
  if (!anthropicConfigured()) {
    throw new AnthropicNotConfiguredError()
  }
  cachedClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  })
  return cachedClient
}

/**
 * Back-compat lazy proxy for the old `anthropic` named export. Existing
 * agent code that does `import { anthropic } from '@/lib/anthropic'` and
 * then `anthropic.messages.create(...)` continues to work — the proxy
 * resolves to `getAnthropic()` on every property access.
 *
 * The error surface is identical to `getAnthropic()`: if the env var is
 * missing, the FIRST property access on this proxy throws
 * `AnthropicNotConfiguredError`, which the route handlers catch and
 * convert to a 503 with a clean JSON body. No raw SDK message leaks.
 */
export const anthropic = new Proxy({} as Anthropic, {
  get(_target, prop, receiver) {
    const client = getAnthropic()
    const value = Reflect.get(client, prop, receiver)
    // Bind methods so `this` stays the real client.
    return typeof value === 'function' ? value.bind(client) : value
  },
})
