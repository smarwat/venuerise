#!/usr/bin/env node
/* eslint-disable */
/**
 * Phase 9S — Fetch-route mismatch scanner.
 *
 * Walks `components/` + `app/` for client-side `fetch('/api/...')` calls
 * and checks the static portion of each URL against the actual files
 * under `app/api/`. Dynamic segments (`/api/leads/${id}`) are normalised
 * to the matching `[id]` directory before lookup so the comparison
 * tolerates template literals.
 *
 * Reports:
 *   - `unknown_route` — client calls an API path with no matching
 *     `route.ts` on disk.
 *   - `unverified` (info-only) — fetch URL contains a fully-dynamic
 *     prefix the scanner can't safely normalise (e.g. computed string).
 *
 * Exit code 1 on `unknown_route` hits; 0 on info-only.
 *
 * Tolerated:
 *   - `fetch('https://...')` external URLs
 *   - `fetch(absoluteUrl)` where the literal isn't a string
 *   - non-API paths like `fetch('/dashboard/...')`
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SCAN_DIRS = ['components', 'app', 'lib']
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', 'coverage'])
const API_ROOT = join(ROOT, 'app', 'api')

// Build the set of mounted API routes by walking app/api for route.ts.
function collectApiRoutes() {
  const routes = new Set()
  function walk(dir, prefix) {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    let hasRoute = false
    for (const entry of entries) {
      const full = join(dir, entry)
      let stat
      try { stat = statSync(full) } catch { continue }
      if (stat.isDirectory()) {
        // Strip route-group parens — `(group)/foo` lives at `/foo`.
        const seg = entry.startsWith('(') && entry.endsWith(')') ? '' : entry
        const nextPrefix = seg ? `${prefix}/${seg}` : prefix
        walk(full, nextPrefix)
      } else if (entry === 'route.ts' || entry === 'route.tsx') {
        hasRoute = true
      }
    }
    if (hasRoute) routes.add(prefix)
  }
  walk(API_ROOT, '/api')
  return routes
}

const API_ROUTES = collectApiRoutes()

// Normalise a client-side fetch path so it lines up with the on-disk
// route. We replace template literals like `${id}` with `[id]` heuristics:
//   /api/leads/${id}              → /api/leads/[anything]
//   /api/leads/${leadId}/messages → /api/leads/[anything]/messages
// The scanner doesn't know which dynamic slug the route uses, so it
// matches "is there ANY route with the same structural shape?"
function structuralCompare(fetchPath) {
  const norm = fetchPath.replace(/\$\{[^}]+\}/g, '<dyn>')
  for (const route of API_ROUTES) {
    const routeNorm = route.replace(/\[[^\]]+\]/g, '<dyn>')
    if (routeNorm === norm) return route
  }
  return null
}

const findings = []
const info = []

function walk(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (stat.isDirectory()) {
      walk(full)
      continue
    }
    if (!/\.(tsx?|jsx?|mjs)$/.test(entry)) continue
    scanFile(full)
  }
}

function scanFile(file) {
  let source
  try { source = readFileSync(file, 'utf8') } catch { return }
  if (!source.includes("'/api") && !source.includes('"/api') && !source.includes('`/api')) return

  const lines = source.split(/\r?\n/)
  // Match: fetch('/api/...'), fetch("/api/..."), fetch(`/api/...`)
  const re = /fetch\(\s*([`'"])(\/api\/[^`'"]+)\1/g
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('UI_INTERACTION_EXEMPT')) continue
    let m
    while ((m = re.exec(line)) !== null) {
      const url = m[2]
      // Strip query string before structural compare.
      const cleanPath = url.split('?')[0]
      // Skip when the URL ends in a `/` and the line continues with
      // string concatenation (`'/api/foo/' + id + '/bar'`). The
      // scanner only sees the literal prefix; flagging it as
      // unknown would be a false positive. Same for template var
      // immediately after the literal closes.
      if (
        cleanPath.endsWith('/') &&
        /['"]\s*\+\s*\w/.test(line.slice(m.index + m[0].length, m.index + m[0].length + 12))
      ) {
        continue
      }
      // Skip when the first segment after /api/ is a template var
      // (e.g. `/api/${path}/${venueId}`) — the scanner cannot
      // resolve which on-disk route the caller meant.
      if (/^\/api\/<dyn>/.test(cleanPath.replace(/\$\{[^}]+\}/g, '<dyn>'))) {
        continue
      }
      const direct = API_ROUTES.has(cleanPath)
      if (direct) continue
      const structural = structuralCompare(cleanPath)
      if (structural) continue
      // Unknown — record.
      findings.push({
        file: relative(ROOT, file),
        line: i + 1,
        url: cleanPath,
      })
    }
    // Info: `fetch(someVar)` with no inline string — can't verify.
    const dyn = /fetch\(\s*(?!\s*[`'"])[A-Za-z_][\w.]*\s*[,)]/g
    while (dyn.exec(line) !== null) {
      info.push({ file: relative(ROOT, file), line: i + 1 })
    }
  }
}

for (const d of SCAN_DIRS) walk(join(ROOT, d))

if (findings.length === 0) {
  console.log(
    `✓ Fetch-route scan clean — ${API_ROUTES.size} routes detected, ${info.length} dynamic fetches (info-only).`
  )
  process.exit(0)
}

console.log(`✗ Fetch-route scan — ${findings.length} unknown route(s):\n`)
for (const f of findings) {
  console.log(`  ${f.file}:${f.line}  ${f.url}`)
}
console.log(`\n${API_ROUTES.size} routes on disk. ${info.length} dynamic fetches not verified.`)
process.exit(1)
