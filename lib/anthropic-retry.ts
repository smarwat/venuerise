import 'server-only'
import { log } from '@/lib/log'
import { captureAiError } from '@/lib/observability/sentry'

/**
 * Anthropic call resilience wrapper (Phase 5D).
 *
 * Wraps a single `anthropic.messages.create(...)` (or any Anthropic SDK call)
 * with:
 *   - up to N attempts (default 3) on RETRYABLE errors only
 *   - exponential backoff (200ms → 800ms) with ±20% jitter
 *   - per-attempt timeout via AbortController (default 30s)
 *   - structured logs for every attempt + outcome
 *   - Sentry capture on terminal failure
 *
 * The wrapper is intentionally generic on T — it doesn't bind to the SDK's
 * Message response type. It probes the result for a `usage.{input,output}_tokens`
 * shape and logs token totals when present, so callers don't have to.
 *
 * Marked `server-only` because the Anthropic API key never belongs in a
 * client bundle.
 */

// ── Backoff schedule (ms before each attempt's retry decision) ──────────────
//   Attempt 1 fails → wait BACKOFF_MS[1] (~200ms) → attempt 2
//   Attempt 2 fails → wait BACKOFF_MS[2] (~800ms) → attempt 3
//   Attempt 3 fails → throw (no further wait)
const BACKOFF_MS = [0, 200, 800] as const
const JITTER_FACTOR = 0.2

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_TIMEOUT_MS = 30_000

// ── Error classification ────────────────────────────────────────────────────

const RETRYABLE_TYPES = new Set<string>([
  'rate_limit_error',
  'api_error',
  'overloaded_error',
  // 'timeout_error' isn't a documented SDK type — we surface our own below.
])

interface MaybeAnthropicError {
  status?: number
  name?: string
  message?: string
  error?: { type?: string; message?: string }
  cause?: unknown
}

function asMaybeErr(err: unknown): MaybeAnthropicError {
  return (err && typeof err === 'object') ? (err as MaybeAnthropicError) : {}
}

/**
 * True iff `err` looks like a transient Anthropic / network failure worth
 * retrying. Conservative: when unsure, returns false (don't retry).
 */
function isRetryableError(err: unknown, signalAborted: boolean): boolean {
  // 1. Per-attempt timeout — we aborted, treat as transient.
  if (signalAborted) return true

  const e = asMaybeErr(err)
  const name = String(e.name ?? '')
  if (name === 'AbortError' || name === 'TimeoutError') return true

  // 2. HTTP status — 429 + 5xx.
  if (typeof e.status === 'number') {
    if (e.status === 429) return true
    if (e.status >= 500 && e.status < 600) return true
    // Explicitly non-retryable status codes:
    //   400 invalid_request | 401 auth | 403 perm | 404 not_found | 413 too_large
    return false
  }

  // 3. Anthropic API error envelope.
  const apiType = e.error?.type
  if (apiType && RETRYABLE_TYPES.has(apiType)) return true

  // 4. Network errors that show up without an HTTP status — common patterns.
  const msg = String(e.message ?? '').toLowerCase()
  if (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('fetch failed')
  ) {
    return true
  }

  return false
}

function classifyReason(err: unknown, signalAborted: boolean): string {
  if (signalAborted) return 'timeout'
  const e = asMaybeErr(err)
  if (e.error?.type) return e.error.type
  if (typeof e.status === 'number') return `http_${e.status}`
  if (e.name) return String(e.name).toLowerCase()
  return 'unknown'
}

function backoffWithJitter(attemptIndex: number): number {
  const base = BACKOFF_MS[attemptIndex] ?? 0
  if (base === 0) return 0
  const delta = base * JITTER_FACTOR
  // Uniform in [base - delta, base + delta]
  return Math.max(0, Math.round(base + (Math.random() * 2 - 1) * delta))
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })
}

// ── Token extraction (best-effort, never throws) ────────────────────────────

interface UsageLike {
  usage?: { input_tokens?: number; output_tokens?: number }
}

function tokensFromResult(result: unknown): {
  inputTokens?: number
  outputTokens?: number
} {
  if (!result || typeof result !== 'object') return {}
  const u = (result as UsageLike).usage
  if (!u || typeof u !== 'object') return {}
  const inputTokens = typeof u.input_tokens === 'number' ? u.input_tokens : undefined
  const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : undefined
  return { inputTokens, outputTokens }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface AnthropicRetryOptions {
  /** Agent name — used as a Sentry tag + log field (`lead-qualifier`, ...). */
  agent: string
  /** Optional request correlation id (Phase 5B). */
  requestId?: string
  /** Model id, surfaced in logs + Sentry tags so model regressions are grep-able. */
  model?: string
  /** Default: 3. */
  maxAttempts?: number
  /** Per-attempt abort timeout in ms. Default: 30_000. */
  timeoutMs?: number
}

/**
 * Run `fn` against Anthropic with retry + timeout + structured observability.
 *
 *   const response = await withAnthropicRetry(
 *     (signal) => anthropic.messages.create({ model, ... }, { signal }),
 *     { agent: 'lead-qualifier', requestId, model: MODEL }
 *   )
 *
 * `fn` MUST forward the signal to the SDK call so the timeout has teeth.
 */
export async function withAnthropicRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: AnthropicRetryOptions
): Promise<T> {
  const {
    agent,
    requestId,
    model,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  const baseFields = { agent, model, requestId }
  const callLog = requestId ? log.child({ requestId }) : log

  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    callLog.info(
      { ...baseFields, attempt, maxAttempts },
      'ai.anthropic.started'
    )

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('anthropic_attempt_timeout')), timeoutMs)
    const startedAt = Date.now()

    try {
      const result = await fn(ac.signal)
      const latencyMs = Date.now() - startedAt
      const { inputTokens, outputTokens } = tokensFromResult(result)
      callLog.info(
        {
          ...baseFields,
          attempt,
          latencyMs,
          inputTokens,
          outputTokens,
        },
        'ai.anthropic.completed'
      )
      return result
    } catch (err) {
      const latencyMs = Date.now() - startedAt
      const signalAborted = ac.signal.aborted
      const reason = classifyReason(err, signalAborted)
      lastError = err

      // Decide: retry or escalate?
      const willRetry = attempt < maxAttempts && isRetryableError(err, signalAborted)
      if (willRetry) {
        const backoffMs = backoffWithJitter(attempt) // attempt is 1-indexed
        callLog.warn(
          { ...baseFields, attempt, latencyMs, reason, backoffMs },
          'ai.anthropic.retry'
        )
        await sleep(backoffMs)
        continue
      }

      // Terminal — non-retryable OR attempts exhausted.
      const e = asMaybeErr(err)
      callLog.error(
        {
          ...baseFields,
          attempts: attempt,
          latencyMs,
          reason,
          errorType: e.error?.type,
          status: e.status,
        },
        'ai.anthropic.failed'
      )
      captureAiError(agent, err, { requestId })
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  // Unreachable in practice — every path above either returns or throws.
  // Belt-and-suspenders so TypeScript's control-flow analyzer is happy.
  throw (lastError instanceof Error
    ? lastError
    : new Error('Anthropic retry exhausted with no error captured'))
}
