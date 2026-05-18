import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * Phase 7A — readiness probe.
 *
 * `/api/health` answers "is the process alive enough to serve traffic?"
 * `/api/readiness` answers "is the process configured strictly enough to
 * be put into rotation?". Production load balancers should hit readiness
 * before sending traffic and re-check periodically; uptime monitors should
 * hit health.
 *
 * Strict checks (PROD-MUST-PASS):
 *   - supabase           — service-role client can do a HEAD count on `venues`
 *   - anthropic          — ANTHROPIC_API_KEY present
 *   - jobs               — INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY present
 *   - email              — RESEND_API_KEY + RESEND_FROM_EMAIL + RESEND_WEBHOOK_SECRET
 *   - rate_limit         — UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *   - sentry             — SENTRY_DSN present
 *   - internal_secret    — INTERNAL_API_SECRET present AND ≥ 32 chars
 *   - app_url            — NEXT_PUBLIC_APP_URL present AND parseable
 *
 * In production: if ANY check fails, return 503.
 * In development: return 200 with the full status (degraded statuses are
 * surfaced but don't fail the response) and an `environment: 'development'`
 * marker. This lets local dev hit `/api/readiness` for a status overview
 * without flipping a load balancer.
 *
 * Never leaks secrets. Only ok/configured/missing-style status strings.
 */

type Check =
  | 'ok'
  | 'configured'
  | 'missing'
  | 'down'

interface ReadinessChecks {
  supabase: Check
  anthropic: Check
  jobs: Check
  email: Check
  rate_limit: Check
  sentry: Check
  internal_secret: Check
  app_url: Check
  stripe: Check
  stripe_webhook: Check
  stripe_price: Check
  /** 'enabled' / 'disabled' — informational, never fails readiness. */
  billing_gate: 'enabled' | 'disabled'
  /** Phase 7F — does the audit table exist + accept reads? */
  billing_events_log: Check
}

const MIN_INTERNAL_SECRET_LEN = 32

async function checkSupabase(): Promise<Check> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('venues')
      .select('id', { count: 'exact', head: true })
      .limit(1)
    if (error) return 'down'
    return 'ok'
  } catch {
    return 'down'
  }
}

function checkAnthropic(): Check {
  return process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing'
}

function checkJobs(): Check {
  return process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY
    ? 'configured'
    : 'missing'
}

function checkEmail(): Check {
  return process.env.RESEND_API_KEY &&
    process.env.RESEND_FROM_EMAIL &&
    process.env.RESEND_WEBHOOK_SECRET
    ? 'configured'
    : 'missing'
}

function checkRateLimit(): Check {
  return process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? 'configured'
    : 'missing'
}

function checkSentry(): Check {
  return process.env.SENTRY_DSN ? 'configured' : 'missing'
}

function checkInternalSecret(): Check {
  const secret = process.env.INTERNAL_API_SECRET
  if (!secret) return 'missing'
  return secret.length >= MIN_INTERNAL_SECRET_LEN ? 'ok' : 'missing'
}

function checkAppUrl(): Check {
  const url = process.env.NEXT_PUBLIC_APP_URL
  if (!url) return 'missing'
  try {
    // eslint-disable-next-line no-new
    new URL(url)
    return 'ok'
  } catch {
    return 'missing'
  }
}

function checkStripe(): Check {
  return process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing'
}

function checkStripeWebhook(): Check {
  return process.env.STRIPE_WEBHOOK_SECRET ? 'configured' : 'missing'
}

function checkStripePrice(): Check {
  return process.env.STRIPE_DEFAULT_PRICE_ID ? 'configured' : 'missing'
}

function checkBillingGate(): 'enabled' | 'disabled' {
  return process.env.BILLING_GATE_ENABLED === '1' ? 'enabled' : 'disabled'
}

/**
 * Phase 7F — does the billing_events_log table exist + accept reads?
 *
 * Uses a HEAD-style count so no row data is fetched (and no count is
 * exposed in the response). If the table is missing (migration 008 not
 * applied), Postgres returns a 42P01 error which surfaces here as
 * 'missing' — production readiness flips to 503.
 */
async function checkBillingEventsLog(): Promise<Check> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('billing_events_log')
      .select('id', { count: 'exact', head: true })
      .limit(1)
    if (error) return 'missing'
    return 'ok'
  } catch {
    return 'missing'
  }
}

function isPassing(c: Check): boolean {
  return c === 'ok' || c === 'configured'
}

export async function GET(request: Request) {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)
  const isProd = process.env.NODE_ENV === 'production'

  let checks: ReadinessChecks
  try {
    checks = {
      supabase: await checkSupabase(),
      anthropic: checkAnthropic(),
      jobs: checkJobs(),
      email: checkEmail(),
      rate_limit: checkRateLimit(),
      sentry: checkSentry(),
      internal_secret: checkInternalSecret(),
      app_url: checkAppUrl(),
      // Phase 7C — billing readiness. All three required in production.
      stripe: checkStripe(),
      stripe_webhook: checkStripeWebhook(),
      stripe_price: checkStripePrice(),
      // Phase 7D — informational only; never flips readiness off.
      billing_gate: checkBillingGate(),
      // Phase 7F — audit table existence check (required in production).
      billing_events_log: await checkBillingEventsLog(),
    }
  } catch (err) {
    log.error({ err, route: '/api/readiness' }, 'readiness.unexpected_throw')
    captureApiError(err, { requestId, route: '/api/readiness' })
    return respond(
      NextResponse.json(
        { ready: false, error: 'readiness_check_threw' },
        { status: 500 }
      )
    )
  }

  // Exclude `billing_gate` from the failure set — it's a string flag, not
  // a check that needs to pass for prod traffic.
  const failed = (Object.entries(checks) as Array<[keyof ReadinessChecks, Check | string]>)
    .filter(([k, v]) =>
      k !== 'billing_gate' && !isPassing(v as Check)
    )
    .map(([k]) => k)

  const allPassing = failed.length === 0
  const ready = isProd ? allPassing : true

  const body: {
    ready: boolean
    environment: 'production' | 'development' | 'test'
    checks: ReadinessChecks
    failed?: Array<keyof ReadinessChecks>
    ts: string
  } = {
    ready,
    environment:
      process.env.NODE_ENV === 'production'
        ? 'production'
        : process.env.NODE_ENV === 'test'
          ? 'test'
          : 'development',
    checks,
    ts: new Date().toISOString(),
  }
  if (failed.length > 0) body.failed = failed

  if (!allPassing) {
    log.warn({ failed, route: '/api/readiness', environment: body.environment }, 'readiness.degraded')
  }

  return respond(
    NextResponse.json(body, {
      status: ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  )
}
