#!/usr/bin/env node
// Phase 9H — Backup posture validation script.
//
// Operator-runnable smoke check that the disaster recovery
// scaffolding is in place:
//
//   - docs/DISASTER-RECOVERY.md exists
//   - .env.example contains Phase 9H backup-posture env entries
//   - /api/admin/security/backup-posture route file exists
//   - /api/admin/security/restore-intents route file exists
//   - components/dashboard/settings/BackupPostureCard.tsx exists
//   - docs/RATE-LIMIT-COVERAGE.md mentions backup posture +
//     restore intent
//
// When SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN are present
// in env, the script ALSO does a live smoke probe against the
// Supabase Management API (same endpoint the in-app helper hits)
// so the operator can confirm the token works end-to-end. When
// absent, the live check is skipped with a clear hint.
//
// Exit codes:
//   0 — all required files / docs / routes present
//   1 — at least one missing OR the live probe failed
//
// Wired via `npm run check:backup-posture`. NOT added to
// `verify` yet — the live probe touches an external service.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const REQUIRED_FILES = [
  'docs/DISASTER-RECOVERY.md',
  'app/api/admin/security/backup-posture/route.ts',
  'app/api/admin/security/restore-intents/route.ts',
  'components/dashboard/settings/BackupPostureCard.tsx',
  'components/dashboard/settings/RestoreIntentCard.tsx',
  'lib/enterprise/disaster-recovery/types.ts',
  'lib/enterprise/disaster-recovery/policy.ts',
  'lib/enterprise/disaster-recovery/backup-posture.ts',
  'lib/enterprise/disaster-recovery/restore-intent.ts',
]

const ENV_TOKENS = [
  'SUPABASE_PROJECT_REF',
  'SUPABASE_ACCESS_TOKEN',
]

const RATE_LIMIT_COVERAGE_TOKENS = [
  'backup-posture',
  'restore-intent',
]

const missing = []
const present = []

// 1. Required file presence.
for (const rel of REQUIRED_FILES) {
  const full = join(ROOT, rel)
  if (existsSync(full)) {
    present.push(rel)
  } else {
    missing.push({ kind: 'file', path: rel })
  }
}

// 2. .env.example must mention SUPABASE_PROJECT_REF +
// SUPABASE_ACCESS_TOKEN so operators know how to wire the
// Management API. We don't require the values to be set — just
// that the env-doc surface exists.
const envExamplePath = join(ROOT, '.env.example')
if (existsSync(envExamplePath)) {
  const envExample = readFileSync(envExamplePath, 'utf8')
  for (const token of ENV_TOKENS) {
    if (!envExample.includes(token)) {
      missing.push({ kind: 'env_doc', path: '.env.example', token })
    }
  }
} else {
  missing.push({ kind: 'file', path: '.env.example' })
}

// 3. RATE-LIMIT-COVERAGE.md must mention backup-posture +
// restore-intent so the scanner doc + the route catalog stay in
// sync.
const ratePath = join(ROOT, 'docs/RATE-LIMIT-COVERAGE.md')
if (existsSync(ratePath)) {
  const rateDoc = readFileSync(ratePath, 'utf8')
  for (const token of RATE_LIMIT_COVERAGE_TOKENS) {
    if (!rateDoc.includes(token)) {
      missing.push({
        kind: 'docs_mention',
        path: 'docs/RATE-LIMIT-COVERAGE.md',
        token,
      })
    }
  }
} else {
  missing.push({ kind: 'file', path: 'docs/RATE-LIMIT-COVERAGE.md' })
}

// 4. Live Management API probe (optional). Same endpoint the
// in-app helper hits — confirms the token + ref work
// end-to-end. Skipped quietly when env is absent.
const projectRef = process.env.SUPABASE_PROJECT_REF
const accessToken = process.env.SUPABASE_ACCESS_TOKEN
let liveProbe = { kind: 'skipped' }
if (projectRef && accessToken) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    const res = await fetch(
      `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
        signal: controller.signal,
      }
    )
    clearTimeout(timer)
    if (res.ok) {
      liveProbe = { kind: 'ok', status: res.status }
    } else {
      liveProbe = { kind: 'fail', status: res.status }
      missing.push({
        kind: 'live_probe',
        detail: `Management API returned HTTP ${res.status}`,
      })
    }
  } catch (err) {
    liveProbe = {
      kind: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    }
    missing.push({
      kind: 'live_probe',
      detail: liveProbe.detail,
    })
  }
}

// ── Output ───────────────────────────────────────────────────────────────

const passLines = []
const failLines = []

for (const row of present) {
  passLines.push(`  ✓ ${row}`)
}

if (liveProbe.kind === 'ok') {
  passLines.push(
    `  ✓ Supabase Management API probe (HTTP ${liveProbe.status})`
  )
} else if (liveProbe.kind === 'skipped') {
  passLines.push(
    '  ⊘ Supabase Management API probe skipped — SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN not set'
  )
}

for (const m of missing) {
  if (m.kind === 'file') {
    failLines.push(`  ✗ Missing file: ${m.path}`)
  } else if (m.kind === 'env_doc') {
    failLines.push(
      `  ✗ ${m.path} must reference ${m.token} (Phase 9H env doc)`
    )
  } else if (m.kind === 'docs_mention') {
    failLines.push(
      `  ✗ ${m.path} must mention "${m.token}" — keep matrix in sync with catalog`
    )
  } else if (m.kind === 'live_probe') {
    failLines.push(`  ✗ Management API live probe failed: ${m.detail}`)
  }
}

if (failLines.length === 0) {
  console.log('✓ Backup posture scaffolding clean')
  for (const line of passLines) console.log(line)
  process.exit(0)
}

console.error('✗ Backup posture scaffolding has gaps')
for (const line of passLines) console.log(line)
for (const line of failLines) console.error(line)
console.error('')
console.error(
  'See docs/DISASTER-RECOVERY.md + docs/RATE-LIMIT-COVERAGE.md for the expected shape.'
)
process.exit(1)
