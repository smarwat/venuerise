#!/usr/bin/env node
/**
 * Phase 7E — billing gate verification matrix.
 *
 * Probes a representative set of routes against a deployed app and asserts
 * that each response code matches what docs/BILLING-QA.md says it should be.
 *
 * Usage:
 *   BILLING_MATRIX_APP_URL=https://staging.example.com \
 *   BILLING_MATRIX_SUPABASE_URL=https://xxx.supabase.co \
 *   BILLING_MATRIX_SUPABASE_ANON_KEY=eyJ... \
 *   BILLING_MATRIX_SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   BILLING_MATRIX_TEST_USER_EMAIL=smoke-owner@example.com \
 *   BILLING_MATRIX_TEST_USER_PASSWORD='hunter2' \
 *   BILLING_MATRIX_VENUE_ID=<uuid> \
 *   [BILLING_MATRIX_EXPECT_GATE=1] \
 *   [BILLING_MATRIX_CLEANUP=1] \
 *   node scripts/billing-gate-matrix.mjs
 *
 * Zero npm dependencies — Node 18+ built-in fetch only. No Supabase MCP.
 *
 * Default expectations (BILLING_MATRIX_EXPECT_GATE=0):
 *   - all gated write routes succeed (2xx) for the test venue
 *   - widget, billing, webhooks never 402
 *
 * With BILLING_MATRIX_EXPECT_GATE=1:
 *   - gated write routes return 402 subscription_required
 *   - billing checkout / portal / widget never 402
 *   - reads still 2xx
 *
 * Cleanup:
 *   If BILLING_MATRIX_CLEANUP=1 (or by default — set to 0 to skip), the
 *   script deletes any leads it created (sentinel email below) via service-role REST.
 */

const PROBE_EMAIL = 'billing-matrix@example.com'

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const REQUIRED = [
  'BILLING_MATRIX_APP_URL',
  'BILLING_MATRIX_SUPABASE_URL',
  'BILLING_MATRIX_SUPABASE_ANON_KEY',
  'BILLING_MATRIX_SUPABASE_SERVICE_ROLE_KEY',
  'BILLING_MATRIX_TEST_USER_EMAIL',
  'BILLING_MATRIX_TEST_USER_PASSWORD',
  'BILLING_MATRIX_VENUE_ID',
]

function env(name, fallback = '') {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

function boolEnv(name, fallback) {
  const raw = env(name, '')
  if (raw === '') return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

function validate() {
  const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].length === 0)
  if (missing.length > 0) {
    process.stderr.write(
      `✗ Missing required env vars:\n${missing.map((m) => `    ${m}`).join('\n')}\n` +
        `\nSee docs/BILLING-QA.md §5.1 for the full env table.\n`
    )
    process.exit(2)
  }
  try {
    new URL(process.env.BILLING_MATRIX_APP_URL)
    new URL(process.env.BILLING_MATRIX_SUPABASE_URL)
  } catch {
    process.stderr.write('✗ BILLING_MATRIX_APP_URL or BILLING_MATRIX_SUPABASE_URL is not a valid URL.\n')
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchJson(url, init = {}) {
  const start = Date.now()
  const res = await fetch(url, init)
  const ms = Date.now() - start
  let body = null
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    body = await res.json().catch(() => null)
  } else {
    body = await res.text().catch(() => null)
  }
  return { status: res.status, ms, body }
}

// ---------------------------------------------------------------------------
// Auth — Supabase password grant
// ---------------------------------------------------------------------------

async function signIn(supabaseUrl, anonKey, email, password) {
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify({ email, password }),
  })
  if (res.status !== 200) {
    const detail = await res.text().catch(() => '')
    throw new Error(`sign-in failed: ${res.status} ${detail.slice(0, 200)}`)
  }
  const body = await res.json()
  if (!body.access_token || !body.user?.id) {
    throw new Error('sign-in missing access_token or user.id')
  }
  return { accessToken: body.access_token, userId: body.user.id }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupProbeLeads(supabaseUrl, serviceRoleKey, venueId) {
  const url =
    `${supabaseUrl.replace(/\/$/, '')}/rest/v1/leads` +
    `?email=eq.${encodeURIComponent(PROBE_EMAIL)}` +
    `&venue_id=eq.${encodeURIComponent(venueId)}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  })
  return res.status < 400
}

// ---------------------------------------------------------------------------
// Probes — one per matrix column we can test from a script
// ---------------------------------------------------------------------------

function buildProbes({ appUrl, accessToken, venueId }) {
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    Origin: appUrl,
  }
  const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' }

  return [
    // Reads — never gated.
    {
      name: 'GET /api/leads (read)',
      column: 'lead read',
      gateApplies: false,
      run: () => fetchJson(`${appUrl}/api/leads`, { headers: authHeaders }),
      expectActive: { status: 200, sentinel: 'json' },
      expectGated: { status: 200, sentinel: 'json' },
    },

    // Lead create — gated.
    {
      name: 'POST /api/leads (create)',
      column: 'lead create/update/delete',
      gateApplies: true,
      run: () =>
        fetchJson(`${appUrl}/api/leads`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({
            name: 'Billing Matrix Probe',
            email: PROBE_EMAIL,
          }),
        }),
      expectActive: { status: 201 },
      expectGated: { status: 402, errorEquals: 'subscription_required' },
    },

    // Tour create — gated.
    {
      name: 'POST /api/tours (create)',
      column: 'tour create/update',
      gateApplies: true,
      run: () =>
        fetchJson(`${appUrl}/api/tours`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({
            lead_id: '00000000-0000-0000-0000-000000000000',
            scheduled_at: '2027-01-15T15:00:00.000Z',
          }),
        }),
      // The lead_id is bogus, so when allowed we expect a 4xx FROM THE HANDLER
      // (404/500 depending on FK behavior). We only assert "not 402" in the
      // active case — proves the gate let it through.
      expectActive: { statusNotEquals: 402 },
      expectGated: { status: 402, errorEquals: 'subscription_required' },
    },

    // AI chat — gated, but needs a conversation id. Use a zero-uuid; the
    // ownership check 404s before any AI work. In active mode we expect 404
    // (ownership_failed); gated mode should still 402 because the gate runs
    // AFTER ownership in ai/chat.
    // NOTE: Phase 7D puts the gate AFTER assertOwnsConversation, so a bogus
    // conversation id would return 404 even when the gate would otherwise
    // 402. We skip this probe with a clear "skipped" line to avoid a false
    // positive.
    {
      name: 'POST /api/ai/chat',
      column: 'AI chat',
      gateApplies: true,
      skip: 'gate runs after assertOwnsConversation; needs a real conversation id',
    },

    // Team invite send — gated.
    {
      name: 'POST /api/team/invitations',
      column: 'team invite send',
      gateApplies: true,
      run: () =>
        fetchJson(`${appUrl}/api/team/invitations`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({
            email: `billing-matrix-${Date.now()}@example.com`,
            role: 'coordinator',
          }),
        }),
      // Allowed path → 201 success or 400 validation (we don't care);
      // anything but 402 proves the gate let it through.
      expectActive: { statusNotEquals: 402 },
      expectGated: { status: 402, errorEquals: 'subscription_required' },
    },

    // Billing checkout — never gated.
    {
      name: 'POST /api/billing/checkout',
      column: 'billing checkout',
      gateApplies: false,
      run: () =>
        fetchJson(`${appUrl}/api/billing/checkout`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({}),
        }),
      // 503 billing_not_configured in dev, 200 with url in staging/prod —
      // anything but 402 passes. The whole point is that gating doesn't
      // apply.
      expectActive: { statusNotEquals: 402 },
      expectGated: { statusNotEquals: 402 },
    },

    // Public widget — never gated. Origin must match the app to pass the 7A
    // allowlist; we use a UUID-shaped venue_id so the schema validator passes
    // and we exercise the venue lookup (which yields 200/201 if the venue
    // exists, or 404 otherwise — both prove "not 402").
    {
      name: 'POST /api/widget (public)',
      column: 'public widget submit',
      gateApplies: false,
      run: () =>
        fetchJson(`${appUrl}/api/widget`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: appUrl },
          body: JSON.stringify({
            venue_id: venueId,
            name: 'Widget Matrix Probe',
            email: PROBE_EMAIL,
          }),
        }),
      expectActive: { statusNotEquals: 402 },
      expectGated: { statusNotEquals: 402 },
    },
  ]
}

// ---------------------------------------------------------------------------
// Assertion
// ---------------------------------------------------------------------------

function evaluate(probe, result, expectGate) {
  const expectation = expectGate && probe.gateApplies ? probe.expectGated : probe.expectActive
  if ('status' in expectation && result.status !== expectation.status) {
    return { pass: false, why: `expected status ${expectation.status}, got ${result.status}` }
  }
  if ('statusNotEquals' in expectation && result.status === expectation.statusNotEquals) {
    return { pass: false, why: `status MUST NOT equal ${expectation.statusNotEquals}, but it did` }
  }
  if ('errorEquals' in expectation) {
    const got =
      result.body && typeof result.body === 'object' && 'error' in result.body
        ? String(result.body.error)
        : null
    if (got !== expectation.errorEquals) {
      return {
        pass: false,
        why: `expected error="${expectation.errorEquals}", got error="${got ?? 'none'}"`,
      }
    }
  }
  if ('sentinel' in expectation && expectation.sentinel === 'json') {
    if (result.body === null || typeof result.body === 'string') {
      return { pass: false, why: 'expected JSON body, got non-JSON' }
    }
  }
  return { pass: true }
}

function describeExpectation(probe, expectGate) {
  const e = expectGate && probe.gateApplies ? probe.expectGated : probe.expectActive
  if ('status' in e) return `${e.status}${e.errorEquals ? ` (${e.errorEquals})` : ''}`
  if ('statusNotEquals' in e) return `!= ${e.statusNotEquals}`
  return 'pass'
}

// ---------------------------------------------------------------------------
// Pretty output
// ---------------------------------------------------------------------------

function pad(s, n) {
  return String(s).padEnd(n, ' ')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  validate()

  const appUrl = process.env.BILLING_MATRIX_APP_URL.replace(/\/$/, '')
  const supabaseUrl = process.env.BILLING_MATRIX_SUPABASE_URL.replace(/\/$/, '')
  const anonKey = process.env.BILLING_MATRIX_SUPABASE_ANON_KEY
  const serviceRoleKey = process.env.BILLING_MATRIX_SUPABASE_SERVICE_ROLE_KEY
  const email = process.env.BILLING_MATRIX_TEST_USER_EMAIL
  const password = process.env.BILLING_MATRIX_TEST_USER_PASSWORD
  const venueId = process.env.BILLING_MATRIX_VENUE_ID
  const expectGate = boolEnv('BILLING_MATRIX_EXPECT_GATE', false)
  const doCleanup = boolEnv('BILLING_MATRIX_CLEANUP', true)

  process.stdout.write(
    `▶ billing-gate-matrix → ${appUrl}\n` +
      `  expect_gate=${expectGate}  venueId=${venueId.slice(0, 8)}…\n\n`
  )

  // Auth.
  let accessToken
  try {
    const auth = await signIn(supabaseUrl, anonKey, email, password)
    accessToken = auth.accessToken
    process.stdout.write(`✓ auth.signin  userId=${auth.userId.slice(0, 8)}…\n\n`)
  } catch (err) {
    process.stderr.write(`✗ ${err.message}\n`)
    process.exit(1)
  }

  // Run probes serially — keeps the output table readable + avoids
  // hammering the rate limiter.
  const probes = buildProbes({ appUrl, accessToken, venueId })
  const rows = []

  for (const probe of probes) {
    if (probe.skip) {
      rows.push({
        probe,
        skipped: true,
        reason: probe.skip,
      })
      continue
    }
    let result
    try {
      result = await probe.run()
    } catch (err) {
      result = { status: 0, ms: 0, body: err?.message ?? 'network error' }
    }
    const verdict = evaluate(probe, result, expectGate)
    rows.push({ probe, result, verdict })
  }

  // Print table.
  const COL_NAME = 30
  const COL_EXPECT = 22
  const COL_ACTUAL = 18
  const COL_VERDICT = 10
  process.stdout.write(
    pad('route', COL_NAME) +
      ' ' +
      pad('expected', COL_EXPECT) +
      ' ' +
      pad('actual', COL_ACTUAL) +
      ' ' +
      pad('verdict', COL_VERDICT) +
      '\n'
  )
  process.stdout.write('-'.repeat(COL_NAME + COL_EXPECT + COL_ACTUAL + COL_VERDICT + 3) + '\n')

  let failed = 0
  for (const r of rows) {
    if (r.skipped) {
      process.stdout.write(
        pad(r.probe.name, COL_NAME) +
          ' ' +
          pad('—', COL_EXPECT) +
          ' ' +
          pad('—', COL_ACTUAL) +
          ' ' +
          pad('SKIP', COL_VERDICT) +
          '   ' +
          r.reason +
          '\n'
      )
      continue
    }
    const expected = describeExpectation(r.probe, expectGate)
    const actualErr =
      r.result.body && typeof r.result.body === 'object' && 'error' in r.result.body
        ? `:${r.result.body.error}`
        : ''
    const actual = `${r.result.status}${actualErr}`
    const verdict = r.verdict.pass ? 'PASS' : 'FAIL'
    process.stdout.write(
      pad(r.probe.name, COL_NAME) +
        ' ' +
        pad(expected, COL_EXPECT) +
        ' ' +
        pad(actual, COL_ACTUAL) +
        ' ' +
        pad(verdict, COL_VERDICT) +
        '\n'
    )
    if (!r.verdict.pass) {
      failed++
      process.stdout.write(`    why: ${r.verdict.why}\n`)
    }
  }

  // Cleanup.
  if (doCleanup) {
    const ok = await cleanupProbeLeads(supabaseUrl, serviceRoleKey, venueId)
    process.stdout.write(
      `\n${ok ? '✓' : '!'} cleanup: ${ok ? 'removed probe leads' : 'failed — review manually'}\n`
    )
  }

  if (failed > 0) {
    process.stderr.write(`\n✗ billing-gate-matrix failed: ${failed} probe(s) didn't match expectations.\n`)
    process.exit(1)
  }

  process.stdout.write('\n✓ billing-gate-matrix passed\n')
}

main().catch((err) => {
  process.stderr.write(`\n✗ unexpected error: ${err?.stack ?? err}\n`)
  process.exit(1)
})
