#!/usr/bin/env node
/**
 * Phase 8A — reset (delete-only) demo data for a venue via the admin API.
 *
 * Usage:
 *   DEMO_APP_URL=https://app.venuerise.com \
 *   DEMO_SUPABASE_URL=https://xxx.supabase.co \
 *   DEMO_SUPABASE_ANON_KEY=eyJ... \
 *   DEMO_TEST_USER_EMAIL=owner@example.com \
 *   DEMO_TEST_USER_PASSWORD='hunter2' \
 *   node scripts/reset-demo-venue.mjs
 *
 * Deletes ONLY demo rows. Real data is never touched. Zero npm dependencies.
 * Never prints passwords or tokens.
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

  process.stdout.write(`▶ demo:reset → ${appUrl}\n`)

  let token
  try {
    token = await signIn(supabaseUrl, anonKey, email, password)
  } catch (err) {
    process.stderr.write(`✗ ${err.message}\n`)
    process.exit(1)
  }
  process.stdout.write(`✓ auth.signin\n`)

  const res = await fetch(`${appUrl}/api/admin/demo/reset`, {
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
      `✗ reset failed: HTTP ${res.status} ${JSON.stringify(body ?? {}).slice(0, 200)}\n`
    )
    process.exit(1)
  }

  const counts = body ?? {}
  process.stdout.write('✓ demo.reset.completed\n')
  process.stdout.write(`  leads deleted:      ${counts.leadsDeleted ?? '?'}\n`)
  process.stdout.write(`  ai_actions deleted: ${counts.aiActionsDeleted ?? '?'}\n`)
}

main().catch((err) => {
  process.stderr.write(`\n✗ unexpected error: ${err?.stack ?? err}\n`)
  process.exit(1)
})
