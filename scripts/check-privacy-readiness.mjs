#!/usr/bin/env node
// Phase 9M — Privacy + DSR readiness regression guard.
//
// Asserts the Phase 9M scaffolding is in place:
//   - lib/enterprise/privacy/{types,data-inventory,retention-policy,dsr,readiness,export-preview,deletion-review}.ts
//   - migration 033
//   - five privacy API routes
//   - two UI cards
//   - docs/PRIVACY-DSR-READINESS.md
//   - package.json has build:privacy-pack + check:privacy-readiness
//   - RATE-LIMIT-COVERAGE references privacy routes
//   - RBAC matrix references privacy access
//   - evidence/questionnaire map references DSR/privacy

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const REQUIRED_FILES = [
  'lib/enterprise/privacy/types.ts',
  'lib/enterprise/privacy/data-inventory.ts',
  'lib/enterprise/privacy/retention-policy.ts',
  'lib/enterprise/privacy/dsr.ts',
  'lib/enterprise/privacy/readiness.ts',
  'lib/enterprise/privacy/export-preview.ts',
  'lib/enterprise/privacy/deletion-review.ts',
  'supabase/migrations/033_privacy_dsr_readiness.sql',
  'app/api/admin/privacy/readiness/route.ts',
  'app/api/admin/privacy/dsr-requests/route.ts',
  'app/api/admin/privacy/dsr-requests/[id]/route.ts',
  'app/api/admin/privacy/dsr-requests/[id]/export-preview/route.ts',
  'app/api/admin/privacy/dsr-requests/[id]/deletion-review/route.ts',
  'components/dashboard/settings/PrivacyReadinessCard.tsx',
  'components/dashboard/settings/DsrRequestsCard.tsx',
  'scripts/build-privacy-pack.mjs',
  'docs/PRIVACY-DSR-READINESS.md',
]

const PACKAGE_SCRIPTS = ['build:privacy-pack', 'check:privacy-readiness']

const DOC_REFERENCES = [
  {
    path: 'docs/RATE-LIMIT-COVERAGE.md',
    tokens: ['/api/admin/privacy', 'dsr-export-preview'],
    label: 'Phase 9M admin routes',
  },
  {
    path: 'docs/RBAC-MATRIX.md',
    tokens: ['/api/admin/privacy', 'dsr-requests'],
    label: 'privacy access posture',
  },
  {
    path: 'lib/enterprise/evidence/questionnaire-map.ts',
    tokens: ['dsr-support', 'retention-policy', 'ai-training-use'],
    label: 'questionnaire DSR + retention + AI-training questions',
  },
  {
    path: 'lib/enterprise/evidence/control-map.ts',
    tokens: [
      'privacy-data-inventory',
      'dsr-request-tracking',
      'dsr-deletion-review',
    ],
    label: 'evidence map privacy controls',
  },
  {
    path: 'docs/BILLING-QA.md',
    tokens: ['DSR', 'privacy readiness'],
    label: 'Phase 9M QA checks',
  },
  {
    path: 'docs/ENTERPRISE-SALES-READINESS.md',
    tokens: ['DSR', 'PrivacyReadinessCard'],
    label: 'sales workflow references the privacy layer',
  },
  {
    path: 'docs/SOC2-EVIDENCE-MAP.md',
    tokens: ['DSR', 'data inventory'],
    label: 'evidence map references privacy/DSR',
  },
  {
    path: 'docs/VENDOR-RISK.md',
    tokens: ['Anthropic', 'training'],
    label: 'vendor risk notes Anthropic + AI training caveat',
  },
  {
    path: 'docs/INCIDENT-RESPONSE.md',
    tokens: ['privacy', 'DSR'],
    label: 'incident response references privacy DSR for incidents involving subject data',
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
  console.log('✓ Privacy readiness scaffolding clean')
  for (const row of present) console.log(`  ✓ ${row}`)
  process.exit(0)
}

console.error('✗ Privacy readiness scaffolding has gaps')
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
console.error('See docs/PRIVACY-DSR-READINESS.md for the expected shape.')
process.exit(1)
