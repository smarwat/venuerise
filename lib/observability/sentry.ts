import * as Sentry from '@sentry/nextjs'

/**
 * Sentry capture helpers + a shared `beforeSend` redactor (Phase 5C).
 *
 * Used by:
 *   - `sentry.server.config.ts` / `.edge.config.ts` / `.client.config.ts`
 *     to install the redaction pass
 *   - API routes, jobs, and the orchestrator to capture *unexpected* errors
 *     with rich tag/extra context
 *
 * Honesty: this module is intentionally tolerant — every helper is wrapped
 * in a try/catch so a broken Sentry instance never breaks the surrounding
 * request path. Errors get logged via Pino independently; Sentry is purely
 * additive.
 */

// ============================================================================
// Redaction
// ============================================================================
//
// Pino's redact is path-based. Sentry events have a richer shape — request
// headers, request body, breadcrumb data, extra, contexts. We walk the
// event recursively (bounded depth) and replace any KEY that looks
// sensitive with '[REDACTED]'. We also null out a few coarse fields
// (request.cookies, request.data) entirely.
//
// This is defense in depth: capture sites should already pass clean payloads.

const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-venuerise-signature$/i,
  /^svix-signature$/i,
  /^svix-id$/i,
  /^svix-timestamp$/i,
  /token/i,
  /secret/i,
  /password/i,
  /api[_-]?key/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /session[_-]?token/i,
  /^internal_api_secret$/i,
  /^anthropic_api_key$/i,
  /^resend_api_key$/i,
  /^resend_webhook_secret$/i,
  /^supabase_service_role_key$/i,
  /^upstash_redis_rest_token$/i,
]

const REDACTED = '[REDACTED]'
const MAX_DEPTH = 6

function isSensitiveKey(key: string): boolean {
  for (const re of SENSITIVE_KEY_PATTERNS) {
    if (re.test(key)) return true
  }
  return false
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (depth > MAX_DEPTH) return '[truncated:depth]'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, depth + 1))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED
      } else {
        out[k] = redactDeep(v, depth + 1)
      }
    }
    return out
  }
  return value
}

/**
 * Sentry `beforeSend` — last line of redaction before transport.
 * Never throws — if it errors, we fail OPEN and let the original event
 * through (Sentry would otherwise drop it entirely).
 */
export function sentryBeforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  try {
    // 1. Wipe coarse high-risk fields entirely.
    if (event.request) {
      // Request body may contain raw widget payloads (lead PII) or arbitrary
      // JSON we never want in Sentry. Drop wholesale. `data` is typed as
      // `unknown` in the Sentry SDK so a string is acceptable.
      if (event.request.data !== undefined) {
        event.request.data = '[REDACTED]'
      }
      // Cookies frequently carry session tokens. The SDK types this as
      // Record<string,string>, so replace with a one-key sentinel rather
      // than a raw string.
      if (event.request.cookies) {
        event.request.cookies = { _redacted: 'true' }
      }
      // Headers — selectively redact known sensitive ones.
      if (event.request.headers) {
        event.request.headers = redactDeep(event.request.headers) as Record<string, string>
      }
    }

    // 2. Walk the rest of the event recursively.
    if (event.extra) event.extra = redactDeep(event.extra) as Record<string, unknown>
    if (event.contexts) event.contexts = redactDeep(event.contexts) as Sentry.Contexts
    if (event.breadcrumbs) {
      event.breadcrumbs = event.breadcrumbs.map((b) => ({
        ...b,
        data: b.data ? (redactDeep(b.data) as Record<string, unknown>) : b.data,
        message: b.message,
      }))
    }
    // 3. Tags should be safe (only us set them) — skip.
    return event
  } catch {
    // Never crash transport. Better a possibly-noisy event than no events.
    return event
  }
}

// ============================================================================
// Capture helpers
// ============================================================================

export interface CaptureContext {
  requestId?: string
  route?: string
  venueId?: string
  leadId?: string
  conversationId?: string
  followUpId?: string
  tourId?: string
  userId?: string
}

function safeError(err: unknown): Error {
  if (err instanceof Error) return err
  if (typeof err === 'string') return new Error(err)
  try {
    return new Error(JSON.stringify(err))
  } catch {
    return new Error('Unknown non-Error throw value')
  }
}

function isSentryEnabled(): boolean {
  return !!process.env.SENTRY_DSN || !!process.env.NEXT_PUBLIC_SENTRY_DSN
}

function captureWith(
  err: unknown,
  scopeTags: Record<string, string>,
  context: CaptureContext = {}
): void {
  if (!isSentryEnabled()) return
  try {
    Sentry.withScope((scope) => {
      // Tags (low-cardinality, searchable in Sentry UI).
      for (const [k, v] of Object.entries(scopeTags)) {
        if (v) scope.setTag(k, v)
      }
      if (context.requestId) scope.setTag('requestId', context.requestId)
      if (context.route) scope.setTag('route', context.route)
      if (context.venueId) scope.setTag('venueId', context.venueId)
      if (context.userId) scope.setTag('userId', context.userId)

      // Extras (higher cardinality, viewable in the issue details).
      const extras: Record<string, unknown> = {}
      if (context.leadId) extras.leadId = context.leadId
      if (context.conversationId) extras.conversationId = context.conversationId
      if (context.followUpId) extras.followUpId = context.followUpId
      if (context.tourId) extras.tourId = context.tourId
      if (Object.keys(extras).length > 0) scope.setExtras(extras)

      Sentry.captureException(safeError(err))
    })
  } catch {
    // Never throw from a capture helper. Pino has already logged the original.
  }
}

/** Unexpected failure inside an API route handler. Skip for 4xx returns. */
export function captureApiError(err: unknown, context: CaptureContext = {}): void {
  captureWith(err, { layer: 'api' }, context)
}

/** Unexpected failure inside a job function (Inngest or local-fallback). */
export function captureJobError(
  jobName: string,
  err: unknown,
  context: CaptureContext = {}
): void {
  captureWith(err, { layer: 'job', job: jobName }, context)
}

/** Unexpected failure handling a provider webhook (Resend, Stripe, etc). */
export function captureWebhookError(
  provider: string,
  err: unknown,
  context: CaptureContext = {}
): void {
  captureWith(err, { layer: 'webhook', provider }, context)
}

/** Unexpected failure inside an AI agent / orchestrator step. */
export function captureAiError(
  agent: string,
  err: unknown,
  context: CaptureContext = {}
): void {
  captureWith(err, { layer: 'ai', agent }, context)
}
