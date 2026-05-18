#!/usr/bin/env node
/**
 * Phase 7B — widget POST load smoke.
 *
 * Usage:
 *   LOAD_APP_URL=https://app.example.com \
 *   LOAD_VENUE_ID=<uuid> \
 *   [LOAD_CONCURRENCY=10] \
 *   [LOAD_TOTAL=30] \
 *   [LOAD_EXPECT_RATE_LIMIT=0] \
 *   [LOAD_SUPABASE_URL=...] \
 *   [LOAD_SUPABASE_SERVICE_ROLE_KEY=...] \
 *   node scripts/load-widget.mjs
 *
 * Fires N widget submissions at concurrency C, prints status counts +
 * latency percentiles (p50/p90/p95/p99/max), and (optionally) deletes
 * the rows it created.
 *
 * Zero npm dependencies — uses Node 18+ built-in `fetch`.
 *
 * Pass / fail rules:
 *   - exit 0 if all responses were 201 (or 201/429 when LOAD_EXPECT_RATE_LIMIT=1)
 *   - exit 1 if any unexpected 4xx/5xx
 *   - exit 1 if > 20% 429s and LOAD_EXPECT_RATE_LIMIT=0
 */

const REQUIRED = ['LOAD_APP_URL', 'LOAD_VENUE_ID']

function env(name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

function intEnv(name, fallback) {
  const raw = env(name, '')
  if (raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function boolEnv(name, fallback) {
  const raw = env(name, '')
  if (raw === '') return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

function validateEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].length === 0)
  if (missing.length > 0) {
    process.stderr.write(`✗ Missing required env vars: ${missing.join(', ')}\n`)
    process.exit(2)
  }
  try {
    new URL(process.env.LOAD_APP_URL)
  } catch {
    process.stderr.write('✗ LOAD_APP_URL is not a valid URL.\n')
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// Concurrency limiter — no deps
// ---------------------------------------------------------------------------

async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length)
  let cursor = 0
  async function worker() {
    while (true) {
      const idx = cursor++
      if (idx >= tasks.length) return
      try {
        results[idx] = await tasks[idx]()
      } catch (err) {
        results[idx] = { error: err }
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length))
  return sortedAsc[idx]
}

function fmtMs(n) {
  if (n === undefined || n === null) return '—'
  return `${Math.round(n).toString().padStart(6, ' ')}ms`
}

// ---------------------------------------------------------------------------
// Widget POST
// ---------------------------------------------------------------------------

async function fireOne({ appUrl, venueId, idx, runId }) {
  const start = Date.now()
  const body = {
    venue_id: venueId,
    name: `Load Smoke ${idx}`,
    email: `load-smoke-${runId}-${idx}@example.com`,
    phone: '5555550100',
    event_date: '2027-01-15',
    guest_count: 100,
    budget: 20000,
    message: `load smoke ${idx}`,
  }
  try {
    const res = await fetch(`${appUrl}/api/widget`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: appUrl,
      },
      body: JSON.stringify(body),
    })
    return { status: res.status, ms: Date.now() - start }
  } catch (err) {
    return { status: 0, ms: Date.now() - start, error: err.message }
  }
}

// ---------------------------------------------------------------------------
// Optional cleanup
// ---------------------------------------------------------------------------

async function cleanupByPrefix({ supabaseUrl, serviceRoleKey, venueId, runId }) {
  const url =
    `${supabaseUrl.replace(/\/$/, '')}/rest/v1/leads` +
    `?email=like.${encodeURIComponent(`load-smoke-${runId}-%`)}` +
    `&venue_id=eq.${encodeURIComponent(venueId)}`
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    })
    if (res.status >= 400) {
      const text = await res.text().catch(() => '')
      process.stderr.write(`! cleanup status=${res.status}: ${text.slice(0, 200)}\n`)
      return false
    }
    return true
  } catch (err) {
    process.stderr.write(`! cleanup threw: ${err.message}\n`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  validateEnv()

  const appUrl = process.env.LOAD_APP_URL.replace(/\/$/, '')
  const venueId = process.env.LOAD_VENUE_ID
  const concurrency = intEnv('LOAD_CONCURRENCY', 10)
  const total = intEnv('LOAD_TOTAL', 30)
  const expectRateLimit = boolEnv('LOAD_EXPECT_RATE_LIMIT', false)
  const supabaseUrl = env('LOAD_SUPABASE_URL', '')
  const serviceRoleKey = env('LOAD_SUPABASE_SERVICE_ROLE_KEY', '')
  const runId = Date.now().toString(36)

  process.stdout.write(
    `▶ Load smoke: ${total} requests at concurrency ${concurrency} → ${appUrl}\n` +
      `  runId=${runId} venueId=${venueId.slice(0, 8)}…  expect429=${expectRateLimit}\n\n`
  )

  const tasks = Array.from({ length: total }, (_, i) => () =>
    fireOne({ appUrl, venueId, idx: i, runId })
  )
  const wallStart = Date.now()
  const results = await runWithConcurrency(tasks, concurrency)
  const wallElapsed = Date.now() - wallStart

  const statusCounts = new Map()
  const latencies = []
  for (const r of results) {
    statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1)
    if (r.ms !== undefined) latencies.push(r.ms)
  }
  latencies.sort((a, b) => a - b)

  const p50 = percentile(latencies, 50)
  const p90 = percentile(latencies, 90)
  const p95 = percentile(latencies, 95)
  const p99 = percentile(latencies, 99)
  const max = latencies[latencies.length - 1] ?? null
  const min = latencies[0] ?? null

  process.stdout.write('Status counts:\n')
  for (const [status, count] of [...statusCounts.entries()].sort((a, b) => a[0] - b[0])) {
    const label = status === 0 ? 'network/transport error' : `HTTP ${status}`
    process.stdout.write(`  ${label.padEnd(28, ' ')} ${count}\n`)
  }
  process.stdout.write('\nLatency:\n')
  process.stdout.write(`  ${'wall (total run)'.padEnd(28, ' ')} ${fmtMs(wallElapsed)}\n`)
  process.stdout.write(`  ${'min'.padEnd(28, ' ')} ${fmtMs(min)}\n`)
  process.stdout.write(`  ${'p50'.padEnd(28, ' ')} ${fmtMs(p50)}\n`)
  process.stdout.write(`  ${'p90'.padEnd(28, ' ')} ${fmtMs(p90)}\n`)
  process.stdout.write(`  ${'p95'.padEnd(28, ' ')} ${fmtMs(p95)}\n`)
  process.stdout.write(`  ${'p99'.padEnd(28, ' ')} ${fmtMs(p99)}\n`)
  process.stdout.write(`  ${'max'.padEnd(28, ' ')} ${fmtMs(max)}\n`)

  // Pass/fail
  const okCount = statusCounts.get(201) ?? 0
  const rlCount = statusCounts.get(429) ?? 0
  const errCount = results.length - okCount - (expectRateLimit ? rlCount : 0)
  const rlRatio = total > 0 ? rlCount / total : 0

  let failed = false
  const reasons = []
  if (errCount > 0) {
    failed = true
    reasons.push(`${errCount} non-201/non-allowed responses`)
  }
  if (!expectRateLimit && rlRatio > 0.2) {
    failed = true
    reasons.push(`${rlCount} rate-limited (${Math.round(rlRatio * 100)}%) without LOAD_EXPECT_RATE_LIMIT=1`)
  }

  if (supabaseUrl && serviceRoleKey) {
    const ok = await cleanupByPrefix({ supabaseUrl, serviceRoleKey, venueId, runId })
    process.stdout.write(`\n${ok ? '✓' : '!'} cleanup: ${ok ? 'deleted load rows' : 'failed'}\n`)
  } else {
    process.stdout.write(
      `\n~ cleanup skipped (set LOAD_SUPABASE_URL + LOAD_SUPABASE_SERVICE_ROLE_KEY to enable)\n`
    )
  }

  if (failed) {
    process.stderr.write(`\n✗ load smoke failed: ${reasons.join('; ')}\n`)
    process.exit(1)
  }

  process.stdout.write('\n✓ load smoke passed\n')
}

main().catch((err) => {
  process.stderr.write(`\n✗ load smoke errored: ${err?.stack ?? err}\n`)
  process.exit(1)
})
