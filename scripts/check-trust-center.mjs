#!/usr/bin/env node
// Phase 9N — Trust Center regression guard.
//
// Asserts the Phase 9N scaffolding is in place:
//   - lib/enterprise/trust-center/{types,policy,artifacts,access}.ts
//   - migration 034
//   - four admin route files
//   - public trust page
//   - gated trust page
//   - gated artifact route
//   - two UI cards
//   - docs/TRUST-CENTER.md
//   - package.json has build:trust-center-pack + check:trust-center
//   - RATE-LIMIT-COVERAGE references trust routes
//   - RBAC matrix references trust access
//   - evidence/questionnaire map references trust center

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const REQUIRED_FILES = [
  'lib/enterprise/trust-center/types.ts',
  'lib/enterprise/trust-center/policy.ts',
  'lib/enterprise/trust-center/artifacts.ts',
  'lib/enterprise/trust-center/access.ts',
  'supabase/migrations/034_trust_center_foundation.sql',
  'app/api/admin/security/trust-center/grants/route.ts',
  'app/api/admin/security/trust-center/grants/[id]/route.ts',
  'app/api/admin/security/trust-center/access-events/route.ts',
  'app/api/admin/security/trust-center/packet/route.ts',
  'app/(marketing)/trust/page.tsx',
  'app/trust/access/[token]/page.tsx',
  'app/api/trust/access/[token]/artifact/route.ts',
  'components/dashboard/settings/TrustCenterCard.tsx',
  'components/dashboard/settings/TrustAccessGrantsCard.tsx',
  'scripts/build-trust-center-pack.mjs',
  'docs/TRUST-CENTER.md',
]

const PACKAGE_SCRIPTS = ['build:trust-center-pack', 'check:trust-center']

const DOC_REFERENCES = [
  {
    path: 'docs/RATE-LIMIT-COVERAGE.md',
    tokens: ['/api/admin/security/trust-center', 'trust-artifact-download'],
    label: 'Phase 9N admin + public trust routes',
  },
  {
    path: 'docs/RBAC-MATRIX.md',
    tokens: ['/api/admin/security/trust-center', 'trust-access'],
    label: 'trust center access posture',
  },
  {
    path: 'lib/enterprise/evidence/questionnaire-map.ts',
    tokens: ['trust-center-available', 'trust-center-buyer-access'],
    label: 'questionnaire trust center questions',
  },
  {
    path: 'lib/enterprise/evidence/control-map.ts',
    tokens: [
      'trust-center-public-summary',
      'trust-center-gated-packets',
      'trust-access-tracking',
    ],
    label: 'evidence map trust center controls',
  },
  {
    path: 'docs/BILLING-QA.md',
    tokens: ['trust center', 'bearer'],
    label: 'Phase 9N QA checks',
  },
  {
    path: 'docs/ENTERPRISE-SALES-READINESS.md',
    tokens: ['Trust Center', 'TrustAccessGrantsCard'],
    label: 'sales workflow references the Trust Center',
  },
  {
    path: 'docs/SOC2-EVIDENCE-MAP.md',
    tokens: ['trust center', 'Trust Center'],
    label: 'evidence map references Trust Center',
  },
  {
    path: 'docs/VENDOR-RISK.md',
    tokens: ['disclosure', 'public'],
    label: 'vendor risk + public disclosure cross-reference',
  },
  {
    path: 'docs/INCIDENT-RESPONSE.md',
    tokens: ['incident', 'severity'],
    label: 'incident response surface referenced by trust packet',
  },
  {
    path: 'docs/PRIVACY-DSR-READINESS.md',
    tokens: ['privacy', 'DSR'],
    label: 'privacy surface referenced by trust packet',
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
  console.log('✓ Trust Center scaffolding clean')
  for (const row of present) console.log(`  ✓ ${row}`)
  process.exit(0)
}

console.error('✗ Trust Center scaffolding has gaps')
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
console.error('See docs/TRUST-CENTER.md for the expected shape.')
process.exit(1)
