#!/usr/bin/env node
/**
 * Phase 7A — production env-var sanity check.
 *
 * Runs against whatever env the shell currently sees. Useful in CI before
 * promoting a deploy, or locally with `env $(cat .env.production) npm run check:prod-env`.
 *
 * Matches the strict set enforced by /api/readiness — keep in sync.
 *
 * Exits 1 on any failure and prints which vars are missing or too short.
 * Never prints values.
 */

const REQUIRED = [
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'INTERNAL_API_SECRET',
  'INNGEST_EVENT_KEY',
  'INNGEST_SIGNING_KEY',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_WEBHOOK_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'SENTRY_DSN',
  'NEXT_PUBLIC_SENTRY_DSN',
  // Phase 7C — Stripe billing. Required in prod; readiness fails if missing.
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_DEFAULT_PRICE_ID',
]

const MIN_SECRET_LEN = 32
const errors = []
const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].length === 0)
if (missing.length > 0) {
  errors.push(`Missing required env vars: ${missing.join(', ')}`)
}

const internal = process.env.INTERNAL_API_SECRET || ''
if (internal && internal.length < MIN_SECRET_LEN) {
  errors.push(`INTERNAL_API_SECRET must be at least ${MIN_SECRET_LEN} chars (currently ${internal.length}).`)
}

const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
if (appUrl) {
  try {
    const u = new URL(appUrl)
    if (!u.protocol.startsWith('http')) {
      errors.push(`NEXT_PUBLIC_APP_URL must use http(s) — got "${u.protocol}".`)
    }
  } catch {
    errors.push(`NEXT_PUBLIC_APP_URL is not a valid URL: "${appUrl}".`)
  }
}

if (errors.length > 0) {
  for (const e of errors) process.stderr.write(`✗ ${e}\n`)
  process.exit(1)
}

process.stdout.write(`✓ All ${REQUIRED.length} required env vars present and INTERNAL_API_SECRET length OK.\n`)
