#!/usr/bin/env node
// Phase 9O — Compliance operations regression guard.
//
// Asserts the Phase 9O scaffolding is in place:
//   - lib/enterprise/compliance-ops/{types,policy,calendar,freshness}.ts
//   - migration 035
//   - three compliance API route files
//   - ComplianceCalendarCard
//   - docs/COMPLIANCE-OPS.md
//   - package.json has build:compliance-ops-pack + check:compliance-ops
//   - RATE-LIMIT-COVERAGE references compliance routes
//   - RBAC matrix references compliance access
//   - evidence/questionnaire map references compliance freshness

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const REQUIRED_FILES = [
  'lib/enterprise/compliance-ops/types.ts',
  'lib/enterprise/compliance-ops/policy.ts',
  'lib/enterprise/compliance-ops/calendar.ts',
  'lib/enterprise/compliance-ops/freshness.ts',
  'supabase/migrations/035_compliance_ops_calendar.sql',
  'app/api/admin/security/compliance/calendar/route.ts',
  'app/api/admin/security/compliance/calendar/[id]/route.ts',
  'app/api/admin/security/compliance/freshness/route.ts',
  'components/dashboard/settings/ComplianceCalendarCard.tsx',
  'scripts/build-compliance-ops-pack.mjs',
  'docs/COMPLIANCE-OPS.md',
]

const PACKAGE_SCRIPTS = ['build:compliance-ops-pack', 'check:compliance-ops']

const DOC_REFERENCES = [
  {
    path: 'docs/RATE-LIMIT-COVERAGE.md',
    tokens: [
      '/api/admin/security/compliance/calendar',
      'compliance-freshness',
    ],
    label: 'Phase 9O admin routes',
  },
  {
    path: 'docs/RBAC-MATRIX.md',
    tokens: ['/api/admin/security/compliance'],
    label: 'compliance ops access posture',
  },
  {
    path: 'lib/enterprise/evidence/questionnaire-map.ts',
    tokens: [
      'security-documentation-review-cadence',
      'evidence-freshness',
    ],
    label: 'questionnaire compliance + freshness questions',
  },
  {
    path: 'lib/enterprise/evidence/control-map.ts',
    tokens: [
      'compliance-operations-calendar',
      'evidence-freshness-tracking',
      'recurring-review-workflow',
    ],
    label: 'evidence map compliance ops controls',
  },
  {
    path: 'docs/BILLING-QA.md',
    tokens: ['compliance', 'review'],
    label: 'Phase 9O QA checks',
  },
  {
    path: 'docs/ENTERPRISE-SALES-READINESS.md',
    tokens: ['compliance', 'ComplianceCalendarCard'],
    label: 'sales workflow references the compliance calendar',
  },
  {
    path: 'docs/SOC2-EVIDENCE-MAP.md',
    tokens: ['compliance', 'review cadence'],
    label: 'evidence map references compliance ops',
  },
  {
    path: 'docs/VENDOR-RISK.md',
    tokens: ['vendor risk', 'review'],
    label: 'vendor risk + review cadence cross-reference',
  },
  {
    path: 'docs/INCIDENT-RESPONSE.md',
    tokens: ['tabletop', 'incident'],
    label: 'incident response + tabletop cadence cross-reference',
  },
  {
    path: 'docs/PRIVACY-DSR-READINESS.md',
    tokens: ['privacy', 'retention'],
    label: 'privacy + retention review cadence cross-reference',
  },
  {
    path: 'docs/TRUST-CENTER.md',
    tokens: ['Trust Center', 'review'],
    label: 'Trust Center review cadence cross-reference',
  },
]

const missing = []
const present = []

for (const rel of REQUIRED_FILES) {
  if (existsSync(join(ROOT, rel))) {
    present.push(rel)
  } else {
    missing.push({ kind: 'file', path: rel })
  }
}

const pkgPath = join(ROOT, 'package.json')
if (existsSync(pkgPath)) {
  const pkg = readFileSync(pkgPath, 'utf8')
  for (const name of PACKAGE_SCRIPTS) {
    if (!pkg.includes(`"${name}"`)) {
      missing.push({ kind: 'pkg_script', name })
    } else {
      present.push(`package.json script: ${name}`)
    }
  }
} else {
  missing.push({ kind: 'file', path: 'package.json' })
}

for (const ref of DOC_REFERENCES) {
  const full = join(ROOT, ref.path)
  if (!existsSync(full)) {
    missing.push({ kind: 'file', path: ref.path })
    continue
  }
  const doc = readFileSync(full, 'utf8')
  const hasAny = ref.tokens.some((t) =>
    doc.toLowerCase().includes(t.toLowerCase())
  )
  if (!hasAny) {
    missing.push({
      kind: 'doc_reference',
      path: ref.path,
      label: ref.label,
      tokens: ref.tokens,
    })
  } else {
    present.push(`${ref.path}: mentions ${ref.label}`)
  }
}

if (missing.length === 0) {
  console.log('✓ Compliance ops scaffolding clean')
  for (const row of present) console.log(`  ✓ ${row}`)
  process.exit(0)
}

console.error('✗ Compliance ops scaffolding has gaps')
for (const row of present) console.log(`  ✓ ${row}`)
for (const m of missing) {
  if (m.kind === 'file') {
    console.error(`  ✗ Missing file: ${m.path}`)
  } else if (m.kind === 'pkg_script') {
    console.error(`  ✗ package.json missing script: ${m.name}`)
  } else if (m.kind === 'doc_reference') {
    console.error(
      `  ✗ ${m.path} must reference ${m.label} (looking for any of: ${m.tokens.join(', ')})`
    )
  }
}
console.error('')
console.error('See docs/COMPLIANCE-OPS.md for the expected shape.')
process.exit(1)
