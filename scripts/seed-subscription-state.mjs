#!/usr/bin/env node
/**
 * Phase 7E — seed a test venue into a chosen subscription state.
 *
 * !!!! STAGING / LOCAL ONLY — NEVER RUN IN PRODUCTION !!!!
 *
 * This script writes to `public.subscriptions` via service-role REST so we
 * can move a test venue between states without round-tripping through
 * Stripe. Rows it creates are tagged `metadata.source='billing_gate_test'`
 * so the cleanup path here can safely delete them later without touching
 * real Stripe-managed rows.
 *
 * Usage:
 *   SEED_SUBSCRIPTION_SUPABASE_URL=https://xxx.supabase.co \
 *   SEED_SUBSCRIPTION_SERVICE_ROLE_KEY=eyJ... \
 *   SEED_SUBSCRIPTION_VENUE_ID=<uuid> \
 *   SEED_SUBSCRIPTION_STATUS=trialing|active|past_due|canceled|incomplete|none \
 *   [SEED_SUBSCRIPTION_TRIAL_DAYS=14] \
 *   node scripts/seed-subscription-state.mjs
 *
 * Behavior:
 *   - status='none'                 → delete any tagged test rows for venue
 *   - any other status              → delete tagged test rows, insert fresh
 *   - never touches Stripe-managed rows (those have stripe_subscription_id
 *     set or metadata that doesn't match our tag)
 */

const TAG_VALUE = 'billing_gate_test'
const TEST_CUSTOMER_ID = 'test_customer_billing_gate'

const REQUIRED = [
  'SEED_SUBSCRIPTION_SUPABASE_URL',
  'SEED_SUBSCRIPTION_SERVICE_ROLE_KEY',
  'SEED_SUBSCRIPTION_VENUE_ID',
  'SEED_SUBSCRIPTION_STATUS',
]

const ALLOWED_STATUSES = new Set([
  'none',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
])

function env(name, fallback = '') {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

function intEnv(name, fallback) {
  const raw = env(name, '')
  if (raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function validate() {
  const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].length === 0)
  if (missing.length > 0) {
    process.stderr.write(
      `✗ Missing required env vars:\n${missing.map((m) => `    ${m}`).join('\n')}\n` +
        `\nAllowed SEED_SUBSCRIPTION_STATUS values: ${[...ALLOWED_STATUSES].join(', ')}\n` +
        `See docs/BILLING-QA.md for the full QA loop.\n`
    )
    process.exit(2)
  }
  try {
    new URL(process.env.SEED_SUBSCRIPTION_SUPABASE_URL)
  } catch {
    process.stderr.write('✗ SEED_SUBSCRIPTION_SUPABASE_URL is not a valid URL.\n')
    process.exit(2)
  }
  const status = process.env.SEED_SUBSCRIPTION_STATUS
  if (!ALLOWED_STATUSES.has(status)) {
    process.stderr.write(
      `✗ SEED_SUBSCRIPTION_STATUS='${status}' not allowed.\n` +
        `   Choose one of: ${[...ALLOWED_STATUSES].join(', ')}\n`
    )
    process.exit(2)
  }
}

function warn() {
  process.stderr.write(
    '\n' +
      '!!!! STAGING / LOCAL ONLY !!!!\n' +
      'This script writes to public.subscriptions via the Supabase service-role key.\n' +
      'It deletes ONLY rows tagged metadata.source=billing_gate_test.\n' +
      'Never run against production data unless you know exactly what you are doing.\n\n'
  )
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function svcHeaders(serviceRoleKey, extra = {}) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

async function deleteTaggedRows(supabaseUrl, serviceRoleKey, venueId) {
  // Match metadata.source = 'billing_gate_test' via PostgREST JSON arrow.
  // URL form: ?venue_id=eq.<id>&metadata->>source=eq.billing_gate_test
  const url =
    `${supabaseUrl.replace(/\/$/, '')}/rest/v1/subscriptions` +
    `?venue_id=eq.${encodeURIComponent(venueId)}` +
    `&metadata->>source=eq.${encodeURIComponent(TAG_VALUE)}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: svcHeaders(serviceRoleKey, { Prefer: 'return=representation' }),
  })
  if (res.status >= 400) {
    const text = await res.text().catch(() => '')
    throw new Error(`DELETE failed: status=${res.status} body=${text.slice(0, 200)}`)
  }
  const deleted = (await res.json().catch(() => [])) ?? []
  return Array.isArray(deleted) ? deleted.length : 0
}

async function insertRow(supabaseUrl, serviceRoleKey, row) {
  const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/subscriptions`
  const res = await fetch(url, {
    method: 'POST',
    headers: svcHeaders(serviceRoleKey, { Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  })
  if (res.status >= 400) {
    const text = await res.text().catch(() => '')
    throw new Error(`INSERT failed: status=${res.status} body=${text.slice(0, 200)}`)
  }
  const inserted = await res.json().catch(() => [])
  return Array.isArray(inserted) && inserted[0] ? inserted[0] : null
}

// ---------------------------------------------------------------------------
// Row builders per status
// ---------------------------------------------------------------------------

function isoFromNow(daysOffset) {
  return new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000).toISOString()
}

function buildRow(venueId, status, trialDays) {
  const base = {
    venue_id: venueId,
    stripe_customer_id: TEST_CUSTOMER_ID,
    stripe_subscription_id: null,
    status,
    metadata: { source: TAG_VALUE, seeded_at: new Date().toISOString() },
  }
  switch (status) {
    case 'trialing':
      return {
        ...base,
        trial_start: isoFromNow(0),
        trial_end: isoFromNow(trialDays),
        current_period_start: isoFromNow(0),
        current_period_end: isoFromNow(trialDays),
      }
    case 'active':
      return {
        ...base,
        current_period_start: isoFromNow(0),
        current_period_end: isoFromNow(30),
      }
    case 'past_due':
      return {
        ...base,
        // Period elapsed ~3 days ago — they're past_due.
        current_period_start: isoFromNow(-30),
        current_period_end: isoFromNow(-3),
      }
    case 'canceled':
      return {
        ...base,
        canceled_at: isoFromNow(-1),
        current_period_end: isoFromNow(-1),
      }
    case 'incomplete':
      return {
        ...base,
        current_period_start: isoFromNow(0),
        current_period_end: isoFromNow(30),
      }
    default:
      throw new Error(`buildRow: status '${status}' not handled`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  validate()
  warn()

  const supabaseUrl = process.env.SEED_SUBSCRIPTION_SUPABASE_URL
  const serviceRoleKey = process.env.SEED_SUBSCRIPTION_SERVICE_ROLE_KEY
  const venueId = process.env.SEED_SUBSCRIPTION_VENUE_ID
  const status = process.env.SEED_SUBSCRIPTION_STATUS
  const trialDays = intEnv('SEED_SUBSCRIPTION_TRIAL_DAYS', 14)

  process.stdout.write(`▶ seed-subscription-state\n`)
  process.stdout.write(`  venueId : ${venueId.slice(0, 8)}…\n`)
  process.stdout.write(`  status  : ${status}\n`)
  if (status === 'trialing') process.stdout.write(`  trial_days: ${trialDays}\n`)
  process.stdout.write('\n')

  // 1. Always delete previous tagged test rows first.
  let deleted = 0
  try {
    deleted = await deleteTaggedRows(supabaseUrl, serviceRoleKey, venueId)
  } catch (err) {
    process.stderr.write(`✗ pre-cleanup failed: ${err.message}\n`)
    process.exit(1)
  }
  process.stdout.write(
    `✓ removed ${deleted} previous test row${deleted === 1 ? '' : 's'} for this venue.\n`
  )

  if (status === 'none') {
    process.stdout.write(`\n✓ Done. Venue has no test subscription rows.\n`)
    process.stdout.write(
      `  (Real Stripe-managed rows, if any, were NOT touched.)\n`
    )
    return
  }

  // 2. Insert the new row.
  let row
  try {
    row = await insertRow(supabaseUrl, serviceRoleKey, buildRow(venueId, status, trialDays))
  } catch (err) {
    process.stderr.write(`✗ insert failed: ${err.message}\n`)
    process.exit(1)
  }

  process.stdout.write(`✓ inserted synthetic subscription row\n`)
  process.stdout.write(`  id          : ${row?.id ?? '?'}\n`)
  process.stdout.write(`  status      : ${row?.status ?? status}\n`)
  if (row?.trial_end) process.stdout.write(`  trial_end   : ${row.trial_end}\n`)
  if (row?.current_period_end) process.stdout.write(`  period_end  : ${row.current_period_end}\n`)
  if (row?.canceled_at) process.stdout.write(`  canceled_at : ${row.canceled_at}\n`)

  process.stdout.write(`\n✓ Done.\n`)
  process.stdout.write(
    `Next: verify with \`npm run billing:matrix BILLING_MATRIX_EXPECT_GATE=1\` (see docs/BILLING-QA.md).\n`
  )
}

main().catch((err) => {
  process.stderr.write(`\n✗ unexpected error: ${err?.stack ?? err}\n`)
  process.exit(1)
})
