#!/usr/bin/env node
/**
 * Phase 7B — production / staging smoke test.
 *
 * Usage:
 *   SMOKE_APP_URL=https://app.example.com \
 *   SMOKE_SUPABASE_URL=https://xxx.supabase.co \
 *   SMOKE_SUPABASE_ANON_KEY=eyJ... \
 *   SMOKE_SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   SMOKE_TEST_USER_EMAIL=smoke-owner@example.com \
 *   SMOKE_TEST_USER_PASSWORD='hunter2' \
 *   [SMOKE_EXISTING_VENUE_ID=...] \
 *   [SMOKE_SKIP_ONBOARDING=1] \
 *   [SMOKE_TIMEOUT_MS=60000] \
 *   node scripts/smoke-prod.mjs
 *
 * Talks to: the deployed VenueRise app (HTTP) and Supabase REST (HTTPS).
 * Zero npm dependencies — uses Node 18+ built-in `fetch`.
 *
 * What it does, in order:
 *   1.  validate required env vars (clean fail list, no values printed)
 *   2.  GET  /api/health             (expect 200)
 *   3.  GET  /api/readiness          (expect 200, ready:true in non-dev)
 *   4.  authenticate the test user via Supabase Auth REST (password grant)
 *   5.  resolve the venue_id:
 *        SMOKE_EXISTING_VENUE_ID → use it
 *        else → query venues via service-role for first venue this user
 *               owns by venue_members (with legacy owner_user_id fallback)
 *   6.  POST /api/widget             (expect 201 + lead_id + conversation_id)
 *        - Origin header set to SMOKE_APP_URL so the 7A allowlist accepts it
 *   7.  poll Supabase REST for downstream rows:
 *        leads, conversations, messages (AI-authored), follow_up_schedules,
 *        ai_actions — each gets its own deadline
 *   8.  print a latency table; exit non-zero on any failure
 *
 * Cleanup:
 *   If everything passed, deletes ONLY the rows we created
 *   (leads.email = 'smoke-test@example.com'). Never touches other data.
 *
 * What we deliberately don't do:
 *   - cookie-based onboarding via /api/onboarding/create-workspace
 *     (auth-cookie capture from scripts is fragile; the spec calls this
 *     out as acceptable to skip in favor of SMOKE_EXISTING_VENUE_ID)
 *   - any Supabase MCP usage (MCP isn't available in CI)
 *   - any logging of secrets
 */

import { setTimeout as sleep } from 'node:timers/promises'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SMOKE_EMAIL = 'smoke-test@example.com'

const REQUIRED = [
  'SMOKE_APP_URL',
  'SMOKE_SUPABASE_URL',
  'SMOKE_SUPABASE_ANON_KEY',
  'SMOKE_SUPABASE_SERVICE_ROLE_KEY',
  'SMOKE_TEST_USER_EMAIL',
  'SMOKE_TEST_USER_PASSWORD',
]

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

function validateEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].length === 0)
  if (missing.length > 0) {
    process.stderr.write(
      `✗ Missing required env vars:\n${missing.map((m) => `    ${m}`).join('\n')}\n`
    )
    process.stderr.write('See docs/STAGING-CHECKLIST.md for the full list.\n')
    process.exit(2)
  }
  try {
    new URL(process.env.SMOKE_APP_URL)
    new URL(process.env.SMOKE_SUPABASE_URL)
  } catch {
    process.stderr.write('✗ SMOKE_APP_URL or SMOKE_SUPABASE_URL is not a valid URL.\n')
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers — fetch with timeout + JSON parsing + latency capture
// ---------------------------------------------------------------------------

class SmokeError extends Error {
  constructor(step, message, detail) {
    super(`[${step}] ${message}`)
    this.step = step
    this.detail = detail
  }
}

async function fetchWithTimeout(url, init = {}, timeoutMs) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  const start = Date.now()
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    const elapsed = Date.now() - start
    return { res, elapsed }
  } finally {
    clearTimeout(t)
  }
}

async function jsonOrThrow(res, step) {
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    const txt = await res.text().catch(() => '')
    throw new SmokeError(step, `non-JSON response (status=${res.status})`, txt.slice(0, 300))
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// App probes (health + readiness)
// ---------------------------------------------------------------------------

async function checkHealth(appUrl, timeoutMs) {
  const { res, elapsed } = await fetchWithTimeout(`${appUrl}/api/health`, {}, timeoutMs)
  if (res.status !== 200) {
    throw new SmokeError('health', `expected 200, got ${res.status}`)
  }
  const body = await jsonOrThrow(res, 'health')
  return { elapsed, body }
}

async function checkReadiness(appUrl, timeoutMs) {
  const { res, elapsed } = await fetchWithTimeout(`${appUrl}/api/readiness`, {}, timeoutMs)
  if (res.status !== 200) {
    throw new SmokeError(
      'readiness',
      `expected 200, got ${res.status}`,
      await res.text().catch(() => '')
    )
  }
  const body = await jsonOrThrow(res, 'readiness')
  const environment = body.environment
  // In any environment that isn't local development we require strict readiness.
  if (environment !== 'development' && body.ready !== true) {
    throw new SmokeError('readiness', `ready=false in env=${environment}`, body.failed)
  }
  return { elapsed, body }
}

// ---------------------------------------------------------------------------
// Supabase Auth — password grant via REST
// ---------------------------------------------------------------------------

async function signIn({ supabaseUrl, anonKey, email, password, timeoutMs }) {
  const { res, elapsed } = await fetchWithTimeout(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ email, password }),
    },
    timeoutMs
  )
  if (res.status !== 200) {
    const detail = await res.text().catch(() => '')
    throw new SmokeError('auth.signin', `expected 200, got ${res.status}`, detail.slice(0, 200))
  }
  const body = await jsonOrThrow(res, 'auth.signin')
  if (!body.access_token || !body.user?.id) {
    throw new SmokeError('auth.signin', 'missing access_token or user.id in response')
  }
  return { elapsed, userId: body.user.id, accessToken: body.access_token }
}

// ---------------------------------------------------------------------------
// Supabase REST — service-role reads + targeted cleanup
// ---------------------------------------------------------------------------

function svcHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  }
}

async function svcSelect({
  supabaseUrl,
  serviceRoleKey,
  table,
  query,
  timeoutMs,
}) {
  const url = `${supabaseUrl}/rest/v1/${table}?${query}`
  const { res } = await fetchWithTimeout(url, { headers: svcHeaders(serviceRoleKey) }, timeoutMs)
  if (res.status !== 200) {
    const detail = await res.text().catch(() => '')
    throw new SmokeError(`db.${table}`, `expected 200, got ${res.status}`, detail.slice(0, 200))
  }
  return res.json()
}

async function svcDelete({ supabaseUrl, serviceRoleKey, table, query, timeoutMs }) {
  const url = `${supabaseUrl}/rest/v1/${table}?${query}`
  const { res } = await fetchWithTimeout(
    url,
    { method: 'DELETE', headers: svcHeaders(serviceRoleKey) },
    timeoutMs
  )
  if (res.status >= 400) {
    const detail = await res.text().catch(() => '')
    throw new SmokeError(`db.${table}.delete`, `status ${res.status}`, detail.slice(0, 200))
  }
}

async function resolveVenueId({
  appUrl: _appUrl,
  supabaseUrl,
  serviceRoleKey,
  userId,
  timeoutMs,
}) {
  if (process.env.SMOKE_EXISTING_VENUE_ID) {
    return { venueId: process.env.SMOKE_EXISTING_VENUE_ID, source: 'env' }
  }

  // Path A — venue_members
  const members = await svcSelect({
    supabaseUrl,
    serviceRoleKey,
    table: 'venue_members',
    query: `select=venue_id&user_id=eq.${encodeURIComponent(userId)}&order=created_at.asc&limit=1`,
    timeoutMs,
  })
  if (members.length > 0) {
    return { venueId: members[0].venue_id, source: 'venue_members' }
  }

  // Path B — legacy owner_user_id
  const venues = await svcSelect({
    supabaseUrl,
    serviceRoleKey,
    table: 'venues',
    query: `select=id&owner_user_id=eq.${encodeURIComponent(userId)}&order=created_at.asc&limit=1`,
    timeoutMs,
  })
  if (venues.length > 0) {
    return { venueId: venues[0].id, source: 'venues.owner_user_id' }
  }

  throw new SmokeError(
    'venue.resolve',
    'no venue found for test user. Set SMOKE_EXISTING_VENUE_ID or onboard a workspace for this user first.'
  )
}

// ---------------------------------------------------------------------------
// Widget POST
// ---------------------------------------------------------------------------

async function submitWidget({ appUrl, venueId, timeoutMs }) {
  const body = {
    venue_id: venueId,
    name: 'Smoke Test Lead',
    email: SMOKE_EMAIL,
    phone: '5555550100',
    event_date: '2027-01-15',
    guest_count: 100,
    budget: 20000,
    message: 'Smoke test lead for VenueRise staging validation.',
  }
  const { res, elapsed } = await fetchWithTimeout(
    `${appUrl}/api/widget`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Match the app's origin so the Phase 7A allowlist accepts us.
        Origin: appUrl,
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  )
  if (res.status !== 201) {
    const detail = await res.text().catch(() => '')
    throw new SmokeError(
      'widget.post',
      `expected 201, got ${res.status}`,
      detail.slice(0, 300)
    )
  }
  const j = await jsonOrThrow(res, 'widget.post')
  if (!j.lead_id) throw new SmokeError('widget.post', 'response missing lead_id')
  return { elapsed, leadId: j.lead_id, conversationId: j.conversation_id ?? null }
}

// ---------------------------------------------------------------------------
// Polling — wait for downstream rows to appear
// ---------------------------------------------------------------------------

async function pollUntil({
  step,
  attempt, // async () => row | null
  deadlineMs,
  intervalMs = 1500,
}) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < deadlineMs) {
    try {
      const result = await attempt()
      if (result) {
        return { elapsed: Date.now() - start, value: result }
      }
      last = result
    } catch (err) {
      // surface but keep polling — transient errors are common during cold starts
      last = err instanceof Error ? err.message : String(err)
    }
    await sleep(intervalMs)
  }
  throw new SmokeError(step, `timed out after ${deadlineMs}ms`, last)
}

async function waitForLead({ supabaseUrl, serviceRoleKey, venueId, leadId, deadlineMs, timeoutMs }) {
  return pollUntil({
    step: 'db.leads.appear',
    deadlineMs,
    attempt: async () => {
      const rows = await svcSelect({
        supabaseUrl,
        serviceRoleKey,
        table: 'leads',
        query:
          `select=id,stage,lead_score,ai_active` +
          `&id=eq.${encodeURIComponent(leadId)}` +
          `&venue_id=eq.${encodeURIComponent(venueId)}` +
          `&limit=1`,
        timeoutMs,
      })
      return rows[0] ?? null
    },
  })
}

async function waitForConversation({ supabaseUrl, serviceRoleKey, leadId, deadlineMs, timeoutMs }) {
  return pollUntil({
    step: 'db.conversations.appear',
    deadlineMs,
    attempt: async () => {
      const rows = await svcSelect({
        supabaseUrl,
        serviceRoleKey,
        table: 'conversations',
        query: `select=id&lead_id=eq.${encodeURIComponent(leadId)}&limit=1`,
        timeoutMs,
      })
      return rows[0] ?? null
    },
  })
}

async function waitForAiMessage({
  supabaseUrl,
  serviceRoleKey,
  conversationId,
  deadlineMs,
  timeoutMs,
}) {
  return pollUntil({
    step: 'db.messages.ai_appear',
    deadlineMs,
    attempt: async () => {
      // Match any non-lead-authored message; conversations include 'ai' and
      // 'system' rows depending on orchestrator pathway.
      const rows = await svcSelect({
        supabaseUrl,
        serviceRoleKey,
        table: 'messages',
        query:
          `select=id,sender_type,created_at` +
          `&conversation_id=eq.${encodeURIComponent(conversationId)}` +
          `&sender_type=in.(ai,system)` +
          `&order=created_at.asc&limit=1`,
        timeoutMs,
      })
      return rows[0] ?? null
    },
  })
}

async function waitForFollowUps({ supabaseUrl, serviceRoleKey, leadId, deadlineMs, timeoutMs }) {
  return pollUntil({
    step: 'db.follow_up_schedules.appear',
    deadlineMs,
    attempt: async () => {
      const rows = await svcSelect({
        supabaseUrl,
        serviceRoleKey,
        table: 'follow_up_schedules',
        query:
          `select=id,status,scheduled_for` +
          `&lead_id=eq.${encodeURIComponent(leadId)}` +
          `&limit=10`,
        timeoutMs,
      })
      return rows.length > 0 ? rows : null
    },
  })
}

async function waitForAiAction({ supabaseUrl, serviceRoleKey, leadId, deadlineMs, timeoutMs }) {
  return pollUntil({
    step: 'db.ai_actions.appear',
    deadlineMs,
    attempt: async () => {
      const rows = await svcSelect({
        supabaseUrl,
        serviceRoleKey,
        table: 'ai_actions',
        query:
          `select=id,action_type,status,created_at` +
          `&lead_id=eq.${encodeURIComponent(leadId)}` +
          `&order=created_at.asc&limit=1`,
        timeoutMs,
      })
      return rows[0] ?? null
    },
  })
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup({ supabaseUrl, serviceRoleKey, venueId, timeoutMs }) {
  // Delete leads with our sentinel email scoped to this venue. ON DELETE
  // CASCADE on conversations/messages/follow_up_schedules/ai_actions
  // takes care of the rest (per migration 001).
  try {
    await svcDelete({
      supabaseUrl,
      serviceRoleKey,
      table: 'leads',
      query:
        `email=eq.${encodeURIComponent(SMOKE_EMAIL)}` +
        `&venue_id=eq.${encodeURIComponent(venueId)}`,
      timeoutMs,
    })
    return true
  } catch (err) {
    process.stderr.write(`! cleanup failed: ${err.message}\n`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Pretty output
// ---------------------------------------------------------------------------

function fmtMs(n) {
  if (n === undefined || n === null) return '—'
  return `${n.toString().padStart(6, ' ')}ms`
}

function row(label, value) {
  return `  ${label.padEnd(28, ' ')} ${value}`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  validateEnv()

  const appUrl = process.env.SMOKE_APP_URL.replace(/\/$/, '')
  const supabaseUrl = process.env.SMOKE_SUPABASE_URL.replace(/\/$/, '')
  const anonKey = process.env.SMOKE_SUPABASE_ANON_KEY
  const serviceRoleKey = process.env.SMOKE_SUPABASE_SERVICE_ROLE_KEY
  const email = process.env.SMOKE_TEST_USER_EMAIL
  const password = process.env.SMOKE_TEST_USER_PASSWORD
  const overallTimeoutMs = intEnv('SMOKE_TIMEOUT_MS', 60_000)
  const httpTimeoutMs = Math.min(overallTimeoutMs, 30_000)

  const timings = {}

  process.stdout.write(`▶ Smoke test against ${appUrl}\n`)

  // 1. Health
  const h = await checkHealth(appUrl, httpTimeoutMs)
  timings.health = h.elapsed
  process.stdout.write(`✓ health             ${fmtMs(h.elapsed)}\n`)

  // 2. Readiness
  const r = await checkReadiness(appUrl, httpTimeoutMs)
  timings.readiness = r.elapsed
  process.stdout.write(
    `✓ readiness          ${fmtMs(r.elapsed)} ` +
      `env=${r.body.environment} ready=${r.body.ready}` +
      (r.body.failed?.length ? ` failed=${r.body.failed.join(',')}` : '') +
      `\n`
  )

  // 3. Auth
  const auth = await signIn({
    supabaseUrl,
    anonKey,
    email,
    password,
    timeoutMs: httpTimeoutMs,
  })
  timings.auth = auth.elapsed
  process.stdout.write(`✓ auth.signin        ${fmtMs(auth.elapsed)} userId=${auth.userId.slice(0, 8)}…\n`)

  // 4. Venue resolution
  const venue = await resolveVenueId({
    appUrl,
    supabaseUrl,
    serviceRoleKey,
    userId: auth.userId,
    timeoutMs: httpTimeoutMs,
  })
  process.stdout.write(`✓ venue.resolve      via=${venue.source} venueId=${venue.venueId.slice(0, 8)}…\n`)

  // 5. Widget POST
  const widget = await submitWidget({
    appUrl,
    venueId: venue.venueId,
    timeoutMs: httpTimeoutMs,
  })
  timings.widgetPost = widget.elapsed
  process.stdout.write(`✓ widget.post        ${fmtMs(widget.elapsed)} lead=${widget.leadId.slice(0, 8)}…\n`)

  // 6. Downstream rows
  const lead = await waitForLead({
    supabaseUrl,
    serviceRoleKey,
    venueId: venue.venueId,
    leadId: widget.leadId,
    deadlineMs: 15_000,
    timeoutMs: httpTimeoutMs,
  })
  timings.leadAppears = lead.elapsed
  process.stdout.write(`✓ db.lead.appear     ${fmtMs(lead.elapsed)}\n`)

  let conversationId = widget.conversationId
  if (!conversationId) {
    const conv = await waitForConversation({
      supabaseUrl,
      serviceRoleKey,
      leadId: widget.leadId,
      deadlineMs: 15_000,
      timeoutMs: httpTimeoutMs,
    })
    conversationId = conv.value.id
    timings.conversationAppears = conv.elapsed
    process.stdout.write(`✓ db.conversation    ${fmtMs(conv.elapsed)}\n`)
  } else {
    process.stdout.write(`✓ db.conversation    pre-created in widget response\n`)
  }

  // AI message is gated on Anthropic being configured. Treat as warning if the
  // readiness check earlier said anthropic was missing.
  const anthropicConfigured = r.body.checks?.anthropic === 'configured'
  if (anthropicConfigured) {
    try {
      const aiMsg = await waitForAiMessage({
        supabaseUrl,
        serviceRoleKey,
        conversationId,
        deadlineMs: Math.max(20_000, overallTimeoutMs - (Date.now() % overallTimeoutMs)),
        timeoutMs: httpTimeoutMs,
      })
      timings.aiMessage = aiMsg.elapsed
      process.stdout.write(`✓ db.ai_message      ${fmtMs(aiMsg.elapsed)}\n`)
    } catch (err) {
      process.stdout.write(`! db.ai_message      ${err.message}\n`)
      throw err
    }
  } else {
    process.stdout.write(`~ db.ai_message      skipped (anthropic not configured)\n`)
  }

  try {
    const fu = await waitForFollowUps({
      supabaseUrl,
      serviceRoleKey,
      leadId: widget.leadId,
      deadlineMs: 20_000,
      timeoutMs: httpTimeoutMs,
    })
    timings.followUpsAppear = fu.elapsed
    process.stdout.write(`✓ db.follow_ups      ${fmtMs(fu.elapsed)} count=${fu.value.length}\n`)
  } catch (err) {
    process.stdout.write(`! db.follow_ups      ${err.message}\n`)
    // Not necessarily fatal — orchestrator may defer follow-up creation in
    // some flows. Surface but don't fail the overall smoke run.
  }

  try {
    const ai = await waitForAiAction({
      supabaseUrl,
      serviceRoleKey,
      leadId: widget.leadId,
      deadlineMs: 20_000,
      timeoutMs: httpTimeoutMs,
    })
    timings.aiAction = ai.elapsed
    process.stdout.write(
      `✓ db.ai_actions      ${fmtMs(ai.elapsed)} type=${ai.value.action_type ?? '?'}\n`
    )
  } catch (err) {
    process.stdout.write(`! db.ai_actions      ${err.message}\n`)
  }

  // 7. Cleanup
  const cleaned = await cleanup({
    supabaseUrl,
    serviceRoleKey,
    venueId: venue.venueId,
    timeoutMs: httpTimeoutMs,
  })

  // 8. Summary
  process.stdout.write('\nLatency summary:\n')
  for (const [k, v] of Object.entries(timings)) {
    process.stdout.write(row(k, fmtMs(v)) + '\n')
  }
  process.stdout.write(`\n${cleaned ? '✓' : '!'} cleanup: ${cleaned ? 'deleted smoke rows' : 'failed — review manually'}\n`)
  process.stdout.write('\n✓ smoke passed\n')
}

main().catch((err) => {
  if (err instanceof SmokeError) {
    process.stderr.write(`\n✗ smoke failed at [${err.step}]: ${err.message}\n`)
    if (err.detail) {
      const detail = typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail)
      process.stderr.write(`  detail: ${detail}\n`)
    }
  } else {
    process.stderr.write(`\n✗ smoke failed: ${err?.stack ?? err}\n`)
  }
  process.exit(1)
})
