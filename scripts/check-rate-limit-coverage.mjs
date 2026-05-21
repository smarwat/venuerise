#!/usr/bin/env node
// Phase 9F — Rate-limit coverage regression guard.
//
// Scans app/api for route files that export at least one HTTP
// method handler (POST | PATCH | PUT | DELETE — and GET for
// admin/* sensitive reads) and flags any file that does NOT
// contain one of:
//
//   - rateLimitWidget / rateLimitAi / rateLimitUserAction /
//     rateLimitCspReport  (any throttle call)
//   - RATE_LIMIT_EXEMPT     (operator-acknowledged exemption marker)
//   - "webhook route"       (upstream provider callback;
//                            signature verification is primary)
//   - "public route"        (intentional unthrottled — should be
//                            paired with another throttling mechanism)
//
// Exit code 1 when at least one route has no coverage AND no
// exemption marker so the scanner can wire into `npm run verify`.
//
// Run:
//   npm run check:rate-limit-coverage
//
// Output (clean):
//   ✓ Rate-limit coverage clean — 44 mutating + sensitive routes,
//     0 missing
//
// Output (missing):
//   ✗ Rate-limit coverage gap
//     app/api/foo/route.ts (POST)
//   Suggestions:
//     - call rateLimit*(...) before the mutation, OR
//     - add a comment with RATE_LIMIT_EXEMPT: <reason>, OR
//     - mark "webhook route" if the route verifies a signature
//
// String-grep based by design: catches missing calls, doesn't
// validate position. Pairs with docs/RATE-LIMIT-COVERAGE.md as the
// human-readable matrix.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const API_ROOT = join(ROOT, 'app', 'api')

// Mutating methods are always checked. Admin GET reads count too —
// an admin endpoint scrolling 200 rows per call deserves a budget
// even though it doesn't mutate.
const MUTATING_METHOD_REGEX =
  /export\s+async\s+function\s+(POST|PATCH|PUT|DELETE)\s*\(/g
const ADMIN_GET_METHOD_REGEX =
  /export\s+async\s+function\s+(GET)\s*\(/g

const COVERAGE_ANCHORS = [
  'rateLimit',          // any rateLimit* wrapper
  'RATE_LIMIT_EXEMPT',  // explicit exemption marker
  'webhook route',      // signature-verified upstream
  'public route',       // anonymous, intentionally unthrottled
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

function methodsExported(source, regex) {
  const set = new Set()
  for (const match of source.matchAll(regex)) {
    set.add(match[1])
  }
  return [...set]
}

function hasCoverageAnchor(source) {
  return COVERAGE_ANCHORS.some((anchor) => source.includes(anchor))
}

const files = listRouteFiles(API_ROOT)
const missing = []
let checkedCount = 0

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file)
  const mutating = methodsExported(source, MUTATING_METHOD_REGEX)
  // Admin reads count too — only when the file lives under
  // `app/api/admin/` AND exports GET.
  const isAdmin = rel.startsWith('app/api/admin/')
  const adminGet = isAdmin
    ? methodsExported(source, ADMIN_GET_METHOD_REGEX)
    : []
  const methods = [...mutating, ...adminGet]
  if (methods.length === 0) continue
  checkedCount += 1
  if (!hasCoverageAnchor(source)) {
    missing.push({ file: rel, methods })
  }
}

if (missing.length === 0) {
  console.log(
    `✓ Rate-limit coverage clean — ${checkedCount} mutating + sensitive routes, 0 missing`
  )
  process.exit(0)
}

console.error('✗ Rate-limit coverage gap')
for (const row of missing) {
  console.error(`  ${row.file} (${row.methods.join(', ')})`)
}
console.error('')
console.error('Suggestions:')
console.error(
  '  - call rateLimit*(...) before the mutation (preferred), OR'
)
console.error(
  '  - add a comment with RATE_LIMIT_EXEMPT: <reason> if no throttle is warranted, OR'
)
console.error(
  '  - mark "webhook route" / "public route" in a header comment when applicable'
)
console.error('')
console.error(
  'See docs/RATE-LIMIT-COVERAGE.md for the policy + existing exemption rationales.'
)
process.exit(1)
