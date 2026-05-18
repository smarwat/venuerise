#!/usr/bin/env node
/**
 * Phase 8A — seed demo data for a venue via the admin API.
 *
 * Usage:
 *   DEMO_APP_URL=https://app.venuerise.com \
 *   DEMO_SUPABASE_URL=https://xxx.supabase.co \
 *   DEMO_SUPABASE_ANON_KEY=eyJ... \
 *   DEMO_TEST_USER_EMAIL=owner@example.com \
 *   DEMO_TEST_USER_PASSWORD='hunter2' \
 *   node scripts/seed-demo-venue.mjs
 *
 * Idempotent — safe to re-run. Wipes any previous demo rows for the test
 * user's primary venue, then inserts a fresh fixture set.
 *
 * Zero npm dependencies — Node 18+ built-in `fetch`. Never prints
 * passwords or tokens.
 */

const REQUIRED = [
  'DEMO_APP_URL',
  'DEMO_SUPABASE_URL',
  'DEMO_SUPABASE_ANON_KEY',
  'DEMO_TEST_USER_EMAIL',
  'DEMO_TEST_USER_PASSWORD',
]

function validate() {
  const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].length === 0)
  if (missing.length > 0) {
    process.stderr.write(
      `✗ Missing required env vars:\n${missing.map((m) => `    ${m}`).join('\n')}\n` +
        `\nSee docs/DEMO-RUNBOOK.md for the full env table.\n`
    )
    process.exit(2)
  }
  try {
    new URL(process.env.DEMO_APP_URL)
    new URL(process.env.DEMO_SUPABASE_URL)
  } catch {
    process.stderr.write('✗ DEMO_APP_URL or DEMO_SUPABASE_URL is not a valid URL.\n')
    process.exit(2)
  }
}

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
  if (!body.access_token) throw new Error('sign-in missing access_token')
  return body.access_token
}

async function main() {
  validate()

  const appUrl = process.env.DEMO_APP_URL.replace(/\/$/, '')
  const supabaseUrl = process.env.DEMO_SUPABASE_URL.replace(/\/$/, '')
  const anonKey = process.env.DEMO_SUPABASE_ANON_KEY
  const email = process.env.DEMO_TEST_USER_EMAIL
  const password = process.env.DEMO_TEST_USER_PASSWORD

  process.stdout.write(`▶ demo:seed → ${appUrl}\n`)

  let token
  try {
    token = await signIn(supabaseUrl, anonKey, email, password)
  } catch (err) {
    process.stderr.write(`✗ ${err.message}\n`)
    process.exit(1)
  }
  process.stdout.write(`✓ auth.signin\n`)

  const res = await fetch(`${appUrl}/api/admin/demo/seed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  })

  let body = null
  try {
    body = await res.json()
  } catch {
    // fall through
  }

  if (res.status !== 200) {
    process.stderr.write(
      `✗ seed failed: HTTP ${res.status} ${JSON.stringify(body ?? {}).slice(0, 200)}\n`
    )
    process.exit(1)
  }

  const counts = body ?? {}
  process.stdout.write('✓ demo.seed.completed\n')
  process.stdout.write(`  leads created:         ${counts.leadsCreated ?? '?'}\n`)
  process.stdout.write(`  conversations created: ${counts.conversationsCreated ?? '?'}\n`)
  process.stdout.write(`  messages created:      ${counts.messagesCreated ?? '?'}\n`)
  process.stdout.write(`  tours created:         ${counts.toursCreated ?? '?'}\n`)
  process.stdout.write(`  follow-ups created:    ${counts.followUpsCreated ?? '?'}\n`)
  if (counts.aiActionsCreated !== undefined) {
    process.stdout.write(`  ai_actions created:    ${counts.aiActionsCreated}\n`)
  }
}

main().catch((err) => {
  process.stderr.write(`\n✗ unexpected error: ${err?.stack ?? err}\n`)
  process.exit(1)
})
