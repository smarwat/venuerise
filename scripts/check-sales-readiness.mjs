#!/usr/bin/env node
// Phase 9J — Enterprise sales readiness regression guard.
//
// Asserts the Phase 9J scaffolding is in place:
//   - lib/enterprise/evidence/{questionnaire-types,questionnaire-map,questionnaire-report,security-summary,readiness-checklist}.ts
//   - Three admin routes (questionnaire-response, buyer-security-summary, demo-mode)
//   - Migration 031 (demo_mode_foundation)
//   - Four UI cards (SecurityQuestionnaireCard, BuyerSecuritySummaryCard, DemoModeCard, EnterpriseReadinessCard)
//   - Local pack script (build-questionnaire-pack)
//   - docs/ENTERPRISE-SALES-READINESS.md
//   - package.json has build:questionnaire-pack + check:sales-readiness
//   - RATE-LIMIT-COVERAGE references new routes
//   - RBAC-MATRIX references owner-only demo mode

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const REQUIRED_FILES = [
  'lib/enterprise/evidence/questionnaire-types.ts',
  'lib/enterprise/evidence/questionnaire-map.ts',
  'lib/enterprise/evidence/questionnaire-report.ts',
  'lib/enterprise/evidence/security-summary.ts',
  'lib/enterprise/evidence/readiness-checklist.ts',
  'app/api/admin/security/questionnaire-response/route.ts',
  'app/api/admin/security/buyer-security-summary/route.ts',
  'app/api/admin/security/demo-mode/route.ts',
  'supabase/migrations/031_demo_mode_foundation.sql',
  'components/dashboard/settings/SecurityQuestionnaireCard.tsx',
  'components/dashboard/settings/BuyerSecuritySummaryCard.tsx',
  'components/dashboard/settings/DemoModeCard.tsx',
  'components/dashboard/settings/EnterpriseReadinessCard.tsx',
  'components/dashboard/DemoModeBanner.tsx',
  'scripts/build-questionnaire-pack.mjs',
  'docs/ENTERPRISE-SALES-READINESS.md',
]

const PACKAGE_SCRIPTS = [
  'build:questionnaire-pack',
  'check:sales-readiness',
]

const DOC_REFERENCES = [
  {
    path: 'docs/RATE-LIMIT-COVERAGE.md',
    tokens: ['questionnaire-response', 'buyer-security-summary', 'demo-mode'],
    label: 'Phase 9J admin routes',
  },
  {
    path: 'docs/RBAC-MATRIX.md',
    tokens: ['demo-mode'],
    label: 'owner-only demo mode',
  },
  {
    path: 'docs/BILLING-QA.md',
    tokens: ['questionnaire', 'demo mode'],
    label: 'Phase 9J QA checks',
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
  const hasAny = ref.tokens.some((t) => doc.toLowerCase().includes(t.toLowerCase()))
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
  console.log('✓ Sales readiness scaffolding clean')
  for (const row of present) console.log(`  ✓ ${row}`)
  process.exit(0)
}

console.error('✗ Sales readiness scaffolding has gaps')
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
console.error(
  'See docs/ENTERPRISE-SALES-READINESS.md for the expected shape.'
)
process.exit(1)
