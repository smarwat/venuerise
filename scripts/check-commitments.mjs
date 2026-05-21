#!/usr/bin/env node
// Phase 9P — Contract commitments regression guard.
//
// Asserts the Phase 9P scaffolding is in place:
//   - lib/enterprise/commitments/{types,policy,commitments,readiness}.ts
//   - migration 036
//   - three commitments API route files
//   - two UI cards
//   - docs/CONTRACT-COMMITMENTS.md
//   - package.json has build:commitments-pack + check:commitments
//   - RATE-LIMIT-COVERAGE references commitments routes
//   - RBAC matrix references commitments access
//   - evidence/questionnaire map references commitments

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const REQUIRED_FILES = [
  'lib/enterprise/commitments/types.ts',
  'lib/enterprise/commitments/policy.ts',
  'lib/enterprise/commitments/commitments.ts',
  'lib/enterprise/commitments/readiness.ts',
  'supabase/migrations/036_contract_commitments.sql',
  'app/api/admin/security/commitments/route.ts',
  'app/api/admin/security/commitments/[id]/route.ts',
  'app/api/admin/security/commitments/readiness/route.ts',
  'components/dashboard/settings/CommitmentsRegisterCard.tsx',
  'components/dashboard/settings/CommitmentsReadinessCard.tsx',
  'scripts/build-commitments-pack.mjs',
  'docs/CONTRACT-COMMITMENTS.md',
]

const PACKAGE_SCRIPTS = ['build:commitments-pack', 'check:commitments']

const DOC_REFERENCES = [
  {
    path: 'docs/RATE-LIMIT-COVERAGE.md',
    tokens: [
      '/api/admin/security/commitments',
      'commitments-readiness',
    ],
    label: 'Phase 9P admin routes',
  },
  {
    path: 'docs/RBAC-MATRIX.md',
    tokens: ['/api/admin/security/commitments'],
    label: 'commitments access posture',
  },
  {
    path: 'lib/enterprise/evidence/questionnaire-map.ts',
    tokens: [
      'customer-specific-commitment-tracking',
      'unsupported-commitment-prevention',
    ],
    label: 'questionnaire commitments questions',
  },
  {
    path: 'lib/enterprise/evidence/control-map.ts',
    tokens: [
      'contract-commitments-register',
      'unsupported-commitment-warning-workflow',
    ],
    label: 'evidence map commitments controls',
  },
  {
    path: 'docs/BILLING-QA.md',
    tokens: ['commitments', 'register'],
    label: 'Phase 9P QA checks',
  },
  {
    path: 'docs/ENTERPRISE-SALES-READINESS.md',
    tokens: ['commitments', 'CommitmentsRegisterCard'],
    label: 'sales workflow references commitments register',
  },
  {
    path: 'docs/SOC2-EVIDENCE-MAP.md',
    tokens: ['commitments', 'contract'],
    label: 'evidence map references commitments',
  },
  {
    path: 'docs/TRUST-CENTER.md',
    tokens: ['commitments', 'grant'],
    label: 'Trust Center grants cross-reference commitments',
  },
  {
    path: 'docs/COMPLIANCE-OPS.md',
    tokens: ['commitments', 'review'],
    label: 'Compliance ops cross-references commitments review cadence',
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
  console.log('✓ Contract commitments scaffolding clean')
  for (const row of present) console.log(`  ✓ ${row}`)
  process.exit(0)
}

console.error('✗ Contract commitments scaffolding has gaps')
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
console.error('See docs/CONTRACT-COMMITMENTS.md for the expected shape.')
process.exit(1)
