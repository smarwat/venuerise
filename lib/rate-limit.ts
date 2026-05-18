import 'server-only'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { log } from '@/lib/log'

/**
 * Rate limiting — Upstash Redis sliding window with a safe local fallback.
 *
 * ── HONESTY CONTRACT ───────────────────────────────────────────────────────
 * If `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` aren't both set,
 * the limiter returns `{ allowed: true, mode: 'disabled', ... }` and logs
 * a single warning the first time it's invoked in the process.
 *
 * Local dev MUST still work without a Redis instance. Production deploys
 * SHOULD treat `mode: 'disabled'` from /api/health as a misconfiguration
 * alert.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Marked `server-only` — `@upstash/redis` carries server-only Node APIs.
 */

const isDev = process.env.NODE_ENV === 'development'

export type RateLimitMode = 'upstash' | 'disabled'

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  /** Unix ms timestamp when the window resets. 0 when disabled. */
  reset: number
  /** ms until the request can be retried (only present when blocked). */
  retryAfterMs?: number
  mode: RateLimitMode
}

// ---- Upstash bootstrap (lazy, cached) ---------------------------------------

let redisSingleton: Redis | null | undefined // undefined = not yet attempted

function getRedis(): Redis | null {
  if (redisSingleton !== undefined) return redisSingleton
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    redisSingleton = null
    return null
  }
  redisSingleton = new Redis({ url, token })
  return redisSingleton
}

let warnedDisabled = false
function warnDisabledOnce() {
  if (warnedDisabled) return
  warnedDisabled = true
  if (isDev) {
    log.warn(
      { reason: 'upstash_env_missing' },
      'rate_limit.disabled'
    )
  } else {
    // Production misconfiguration — lift to error so it lands in alerting.
    log.error(
      { reason: 'upstash_env_missing' },
      'rate_limit.disabled'
    )
  }
}

// ---- Limiter cache ----------------------------------------------------------

interface LimiterSpec {
  prefix: string
  /** Tokens per window. */
  tokens: number
  /** Sliding window duration. */
  window: '1 m' | '10 s' | '1 h'
}

const limiterCache = new Map<string, Ratelimit>()

function getLimiter(spec: LimiterSpec): Ratelimit | null {
  const redis = getRedis()
  if (!redis) return null
  const key = `${spec.prefix}:${spec.tokens}:${spec.window}`
  let lim = limiterCache.get(key)
  if (!lim) {
    lim = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(spec.tokens, spec.window),
      prefix: spec.prefix,
      analytics: false,
    })
    limiterCache.set(key, lim)
  }
  return lim
}

// ---- Limit definitions (single source of truth) -----------------------------

export const RATE_LIMITS = {
  widget:      { tokens: 10, window: '1 m' as const, prefix: 'vr:widget' },
  ai:          { tokens: 60, window: '1 m' as const, prefix: 'vr:ai'     },
  userAction:  { tokens: 30, window: '1 m' as const, prefix: 'vr:action' },
} as const

// ---- Helpers ----------------------------------------------------------------

function disabledResult(spec: LimiterSpec): RateLimitResult {
  warnDisabledOnce()
  return {
    allowed: true,
    limit: spec.tokens,
    remaining: spec.tokens,
    reset: 0,
    mode: 'disabled',
  }
}

async function check(spec: LimiterSpec, identifier: string): Promise<RateLimitResult> {
  const limiter = getLimiter(spec)
  if (!limiter) return disabledResult(spec)

  try {
    const r = await limiter.limit(identifier)
    const now = Date.now()
    const retryAfterMs = r.success ? undefined : Math.max(0, r.reset - now)
    return {
      allowed: r.success,
      limit: r.limit,
      remaining: r.remaining,
      reset: r.reset,
      retryAfterMs,
      mode: 'upstash',
    }
  } catch (err) {
    // Fail-open on Redis outage — better to serve traffic than to deny it.
    // Surface in logs so the operator notices.
    log.error({ err, prefix: spec.prefix }, 'rate_limit.redis_failed_open')
    return {
      allowed: true,
      limit: spec.tokens,
      remaining: spec.tokens,
      reset: 0,
      mode: 'disabled',
    }
  }
}

// ---- IP extraction ----------------------------------------------------------

export function extractIp(req: Request): string {
  // Vercel / most proxies put the original client IP first in x-forwarded-for.
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  const xri = req.headers.get('x-real-ip')
  if (xri) return xri.trim()
  return 'unknown'
}

// ---- Public surface ---------------------------------------------------------

/**
 * Rate limit a widget submission. Keyed on IP + (optional) venue so a
 * misbehaving site can't burn through every venue's budget.
 */
export async function rateLimitWidget(req: Request, venueId?: string): Promise<RateLimitResult> {
  const ip = extractIp(req)
  const id = venueId ? `${ip}:${venueId}` : ip
  return check(RATE_LIMITS.widget, id)
}

/**
 * Rate limit an AI route. Caller supplies the identity key
 * (typically the user id, or for the chat thread `user:${userId}:conv:${convId}`).
 */
export async function rateLimitAi(_req: Request, key: string): Promise<RateLimitResult> {
  return check(RATE_LIMITS.ai, key)
}

/**
 * Rate limit a user-initiated write action (lead create, etc.).
 */
export async function rateLimitUserAction(_req: Request, key: string): Promise<RateLimitResult> {
  return check(RATE_LIMITS.userAction, key)
}

// ---- Health / introspection -------------------------------------------------

export type RateLimitStatus = 'configured' | 'missing' | 'disabled'

/**
 * Cheap synchronous status check used by /api/health. Does NOT touch Redis.
 *
 * - 'configured' — both env vars present
 * - 'missing'    — env vars absent in production (real bug)
 * - 'disabled'   — env vars absent in development (intentional dev fallback)
 */
export function getRateLimitStatus(): RateLimitStatus {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return 'configured'
  }
  return process.env.NODE_ENV === 'development' ? 'disabled' : 'missing'
}

// ---- Convenience for route handlers -----------------------------------------

/**
 * Build a NextResponse-friendly 429 body + Retry-After / X-RateLimit-* headers.
 * Route handlers can do:
 *
 *   const rl = await rateLimitWidget(req, venueId)
 *   if (!rl.allowed) return rateLimitedResponse(rl)
 */
export function rateLimitedResponse(result: RateLimitResult): Response {
  const retryMs = result.retryAfterMs ?? 0
  const retrySec = Math.ceil(retryMs / 1000)
  return new Response(
    JSON.stringify({ error: 'rate_limited', retry_after_ms: retryMs }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retrySec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(result.reset),
      },
    }
  )
}
