#!/usr/bin/env node
// Phase 9B — Audit coverage regression guard.
//
// Scans app/api for route files that export at least one mutating
// HTTP method (POST | PATCH | PUT | DELETE) and flags any file that
// does NOT contain one of:
//
//   - recordAuditEvent      (writes an enterprise audit row)
//   - AUDIT_EXEMPT          (operator-acknowledged exemption marker)
//   - "public route"        (anonymous endpoint, no actor)
//   - "webhook route"       (upstream provider callback)
//
// The script exits with code 1 when at least one route has no
// coverage AND no exemption marker, so it can be wired into
// validation as a fail-on-regression check. Existing exemptions
// (digest preview, etc.) keep the build green.
//
// Run:
//   npm run check:audit-coverage
//
// Output (clean):
//   ✓ Audit coverage clean — 40 mutating routes, 0 missing
//
// Output (missing):
//   ✗ Audit coverage gap
//     app/api/foo/route.ts (POST)
//   Suggestions:
//     - call recordAuditEvent() in the success path, OR
//     - add a comment with AUDIT_EXEMPT: <reason>, OR
//     - mark "public route" / "webhook route" in a header comment
//
// The check is intentionally string-grep based: it tolerates files
// that use the constants from lib/enterprise/audit-actions.ts and
// catches files that don't, without a TS parser dependency.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const API_ROOT = join(ROOT, 'app', 'api')

const MUTATING_METHOD_REGEX =
  /export\s+async\s+function\s+(POST|PATCH|PUT|DELETE)\s*\(/g

// Anchors that satisfy coverage. ANY ONE of these in the file is
// enough; the scanner doesn't try to verify which handler the
// marker belongs to (string-grep is a regression guard, not a
// type system).
const COVERAGE_ANCHORS = [
  'recordAuditEvent', // enterprise audit-events helper
  'AUDIT_EXEMPT',     // explicit exemption marker
  'public route',     // anonymous endpoint
  'webhook route',    // upstream callback
]

function listRouteFiles(dir) {
  const entries = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      entries.push(...listRouteFiles(full))
    } else if (name === 'route.ts') {
      entries.push(full)
    }
  }
  return entries
}

function methodsExported(source) {
  const methods = new Set()
  for (const match of source.matchAll(MUTATING_METHOD_REGEX)) {
    methods.add(match[1])
  }
  return [...methods]
}

function hasCoverageAnchor(source) {
  return COVERAGE_ANCHORS.some((anchor) => source.includes(anchor))
}

const files = listRouteFiles(API_ROOT)
const missing = []
let mutatingCount = 0

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const methods = methodsExported(source)
  if (methods.length === 0) continue
  mutatingCount += 1
  if (!hasCoverageAnchor(source)) {
    missing.push({ file: relative(ROOT, file), methods })
  }
}

if (missing.length === 0) {
  console.log(
    `✓ Audit coverage clean — ${mutatingCount} mutating routes, 0 missing`
  )
  process.exit(0)
}

console.error('✗ Audit coverage gap')
for (const row of missing) {
  console.error(`  ${row.file} (${row.methods.join(', ')})`)
}
console.error('')
console.error('Suggestions:')
console.error(
  '  - call recordAuditEvent() in the success path (preferred), OR'
)
console.error(
  '  - add a comment with AUDIT_EXEMPT: <reason> if a row is genuinely not warranted, OR'
)
console.error(
  '  - mark "public route" / "webhook route" in a header comment'
)
console.error('')
console.error(
  'See docs/AUDIT-COVERAGE.md for the policy + the existing exemption rationales.'
)
process.exit(1)
