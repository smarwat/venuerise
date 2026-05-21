#!/usr/bin/env node
// Phase 9C — Cross-tenant RBAC smoke probe.
//
// Operator-run harness that probes a representative set of admin
// + resource routes with a venue A session cookie + venue B
// resource ids. Expected posture (Phase 9B RBAC matrix):
//
//   - Unauthenticated  → 401 unauthorized
//   - Cross-tenant     → 404 not_found (NEVER 403). The 403→404
//                        collapse keeps the surface from being used
//                        to enumerate foreign venue / resource ids.
//   - Validation       → must not happen BEFORE the tenant check
//                        when the target is foreign. (We don't
//                        actively probe this; we infer from the
//                        404 vs 400 response code.)
//
// ── ENV CONTRACT ──────────────────────────────────────────────────────────
//
// Required (script exits 0 with "skipped" and a clear hint when missing):
//   RBAC_PROBE_BASE_URL              http://localhost:3000
//   RBAC_PROBE_COOKIE                session cookie string for a venue-A user
//   RBAC_PROBE_FOREIGN_VENUE_ID      uuid of venue B
//   RBAC_PROBE_FOREIGN_LEAD_ID       uuid of a lead in venue B
//   RBAC_PROBE_FOREIGN_TOUR_ID       uuid of a tour in venue B
//   RBAC_PROBE_FOREIGN_AI_ACTION_ID  uuid of an ai_action in venue B
//
// The cookie format is whatever Supabase Auth set on the browser —
// usually `sb-<projectref>-auth-token=...`. Copy from devtools.
//
// ── WHY THIS LIVES OUTSIDE `npm run verify` ───────────────────────────────
// The script requires real seeded test tenants. Production CI does
// not have those seeded. Operators run this manually in staging or
// against a local dev server after seeding two venues; the smoke
// belongs in the runbook, not on every commit.
//
// Run:
//   npm run check:cross-tenant-rbac

import process from 'node:process'

const BASE_URL = process.env.RBAC_PROBE_BASE_URL
const COOKIE = process.env.RBAC_PROBE_COOKIE
const FOREIGN_VENUE = process.env.RBAC_PROBE_FOREIGN_VENUE_ID
const FOREIGN_LEAD = process.env.RBAC_PROBE_FOREIGN_LEAD_ID
const FOREIGN_TOUR = process.env.RBAC_PROBE_FOREIGN_TOUR_ID
const FOREIGN_AI_ACTION = process.env.RBAC_PROBE_FOREIGN_AI_ACTION_ID

if (
  !BASE_URL ||
  !COOKIE ||
  !FOREIGN_VENUE ||
  !FOREIGN_LEAD ||
  !FOREIGN_TOUR ||
  !FOREIGN_AI_ACTION
) {
  console.error('⊘ Cross-tenant RBAC probe skipped — missing env')
  console.error('  Required:')
  console.error('    RBAC_PROBE_BASE_URL=http://localhost:3000')
  console.error('    RBAC_PROBE_COOKIE="<sb-<ref>-auth-token=...>"')
  console.error('    RBAC_PROBE_FOREIGN_VENUE_ID=<uuid>')
  console.error('    RBAC_PROBE_FOREIGN_LEAD_ID=<uuid>')
  console.error('    RBAC_PROBE_FOREIGN_TOUR_ID=<uuid>')
  console.error('    RBAC_PROBE_FOREIGN_AI_ACTION_ID=<uuid>')
  console.error('')
  console.error('  See docs/RUNBOOK.md → "Cross-tenant probe" for how to seed.')
  // Exit 0 — missing env is a skip, not a failure. CI without seeded
  // tenants should not fail on this.
  process.exit(0)
}

// ── Probe definitions ─────────────────────────────────────────────────────
// Each probe targets ONE specific cross-tenant escape vector. We
// intentionally keep this list short — it's a representative set,
// not exhaustive. The Phase 9B RBAC matrix is the full source of
// truth; add a probe here when a NEW route family appears.
//
// `expectAuth` — status when the caller IS authenticated but the
//   resource belongs to a foreign tenant. Standard: 404.
// `expectAnon` — status when the caller has NO cookie.
//   Standard: 401, unless the route is public (none of these are).
// `parseBodyAs` — defines how we read the response body for the
//   diagnostic table. JSON for typed-error routes; null for routes
//   that only signal via status code.

const probes = [
  {
    name: 'GET /api/admin/audit-events?venue_id=<foreign>',
    method: 'GET',
    path: `/api/admin/audit-events?venue_id=${FOREIGN_VENUE}`,
    expectAuth: 404,
    expectAnon: 401,
  },
  {
    name: 'GET /api/admin/ai/autopilot-readiness?venue_id=<foreign>',
    method: 'GET',
    path: `/api/admin/ai/autopilot-readiness?venue_id=${FOREIGN_VENUE}`,
    expectAuth: 404,
    expectAnon: 401,
  },
  {
    name: 'GET /api/admin/ai/autopilot-simulation?venue_id=<foreign>',
    method: 'GET',
    path: `/api/admin/ai/autopilot-simulation?venue_id=${FOREIGN_VENUE}`,
    expectAuth: 404,
    expectAnon: 401,
  },
  {
    name: 'GET /api/admin/leads/reactivation-queue?venue_id=<foreign>',
    method: 'GET',
    path: `/api/admin/leads/reactivation-queue?venue_id=${FOREIGN_VENUE}`,
    expectAuth: 404,
    expectAnon: 401,
  },
  {
    name: 'POST /api/admin/revenue-os/settings (foreign venue_id)',
    method: 'POST',
    path: '/api/admin/revenue-os/settings',
    body: { venue_id: FOREIGN_VENUE, settings: {} },
    expectAuth: 404,
    expectAnon: 401,
  },
  {
    name: 'PATCH /api/leads/<foreignLeadId>',
    method: 'PATCH',
    path: `/api/leads/${FOREIGN_LEAD}`,
    body: { stage: 'qualified' },
    expectAuth: 404,
    expectAnon: 401,
  },
  {
    name: 'PATCH /api/tours/<foreignTourId>',
    method: 'PATCH',
    path: `/api/tours/${FOREIGN_TOUR}`,
    body: { status: 'cancelled' },
    expectAuth: 404,
    expectAnon: 401,
  },
  {
    name: 'PATCH /api/ai/actions/<foreignAiActionId>/reject',
    method: 'PATCH',
    path: `/api/ai/actions/${FOREIGN_AI_ACTION}/reject`,
    body: { reason: 'rbac probe' },
    expectAuth: 404,
    expectAnon: 401,
  },
]

async function probe(p, { cookie }) {
  const url = `${BASE_URL.replace(/\/$/, '')}${p.path}`
  const headers = {
    accept: 'application/json',
  }
  if (cookie) headers.cookie = cookie
  if (p.body) headers['content-type'] = 'application/json'

  let res
  try {
    res = await fetch(url, {
      method: p.method,
      headers,
      body: p.body ? JSON.stringify(p.body) : undefined,
      redirect: 'manual',
    })
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.message : String(err) }
  }

  let bodyText = ''
  try {
    bodyText = await res.text()
  } catch {
    bodyText = ''
  }
  let bodyCode = null
  try {
    const parsed = JSON.parse(bodyText)
    if (parsed && typeof parsed.error === 'string') {
      bodyCode = parsed.error
    }
  } catch {
    // Non-JSON body — fine; we'll show the status only.
  }
  return { status: res.status, bodyCode }
}

function formatRow(name, method, expected, actual, result, note) {
  const cells = [
    truncate(name, 56),
    method.padEnd(6),
    String(expected).padEnd(8),
    String(actual).padEnd(7),
    result.padEnd(7),
    note,
  ]
  return cells.join('  ')
}

function truncate(s, n) {
  if (s.length <= n) return s.padEnd(n)
  return `${s.slice(0, n - 1)}…`
}

console.log('Cross-tenant RBAC probe')
console.log('  Base URL:', BASE_URL)
console.log('  Foreign venue:', FOREIGN_VENUE)
console.log('')

console.log(
  formatRow(
    'route',
    'method',
    'expected',
    'actual',
    'result',
    'detail'
  )
)
console.log('  ' + '-'.repeat(100))

let pass = 0
let fail = 0

// Pass 1 — authenticated (venue A) against foreign resources.
console.log('  ── Authenticated (venue A → venue B) ──')
for (const p of probes) {
  const r = await probe(p, { cookie: COOKIE })
  const actual = r.error ? `ERR` : String(r.status)
  const ok = !r.error && r.status === p.expectAuth
  if (ok) pass++
  else fail++
  const note = r.error
    ? r.error
    : r.bodyCode
      ? `error="${r.bodyCode}"`
      : ''
  console.log(
    '  ' +
      formatRow(
        p.name,
        p.method,
        p.expectAuth,
        actual,
        ok ? 'PASS' : 'FAIL',
        note
      )
  )
}

// Pass 2 — unauthenticated against the same routes.
console.log('')
console.log('  ── Unauthenticated (no cookie) ──')
for (const p of probes) {
  const r = await probe(p, { cookie: null })
  const actual = r.error ? `ERR` : String(r.status)
  const ok = !r.error && r.status === p.expectAnon
  if (ok) pass++
  else fail++
  const note = r.error
    ? r.error
    : r.bodyCode
      ? `error="${r.bodyCode}"`
      : ''
  console.log(
    '  ' +
      formatRow(
        p.name,
        p.method,
        p.expectAnon,
        actual,
        ok ? 'PASS' : 'FAIL',
        note
      )
  )
}

console.log('')
console.log(`Summary: ${pass} pass / ${fail} fail (${pass + fail} probes total)`)

if (fail > 0) {
  console.error('')
  console.error('At least one probe diverged from the expected posture.')
  console.error('Investigate before promoting to production.')
  console.error(
    'See docs/RBAC-MATRIX.md for the cross-tenant 403→404 collapse rule.'
  )
  process.exit(1)
}
process.exit(0)
