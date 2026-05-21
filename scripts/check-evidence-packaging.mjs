#!/usr/bin/env node
// Phase 9I — Evidence packaging regression guard.
//
// Asserts that the SOC 2 evidence scaffolding is in place:
//   - lib/enterprise/evidence/{types,control-map,report}.ts exist
//   - Admin evidence report route exists
//   - SecurityEvidenceCenter component exists
//   - docs/SOC2-EVIDENCE-MAP.md exists
//   - package.json has the build:evidence-pack + check:evidence-packaging scripts
//   - RATE-LIMIT-COVERAGE.md mentions the evidence report endpoint
//   - RBAC-MATRIX.md mentions the evidence report access posture
//   - BILLING-QA.md mentions the evidence center QA checks
//
// String-grep based — pairs with the existing
// scripts/check-audit-coverage.mjs + check-rate-limit-coverage.mjs +
// check-backup-posture.mjs pattern.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const REQUIRED_FILES = [
  'lib/enterprise/evidence/types.ts',
  'lib/enterprise/evidence/control-map.ts',
  'lib/enterprise/evidence/report.ts',
  'app/api/admin/security/evidence-report/route.ts',
  'components/dashboard/settings/SecurityEvidenceCenter.tsx',
  'docs/SOC2-EVIDENCE-MAP.md',
  'scripts/build-evidence-pack.mjs',
]

const PACKAGE_JSON_SCRIPTS = [
  'build:evidence-pack',
  'check:evidence-packaging',
]

const DOC_REFERENCES = [
  {
    path: 'docs/RATE-LIMIT-COVERAGE.md',
    tokens: ['evidence-report'],
    label: 'evidence report endpoint',
  },
  {
    path: 'docs/RBAC-MATRIX.md',
    tokens: ['evidence-report'],
    label: 'evidence report access posture',
  },
  {
    path: 'docs/BILLING-QA.md',
    tokens: ['evidence', 'SecurityEvidenceCenter'],
    label: 'evidence center QA checks',
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
  for (const name of PACKAGE_JSON_SCRIPTS) {
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
  const hasAny = ref.tokens.some((t) => doc.includes(t))
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
  console.log('✓ Evidence packaging scaffolding clean')
  for (const row of present) console.log(`  ✓ ${row}`)
  process.exit(0)
}

console.error('✗ Evidence packaging scaffolding has gaps')
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
  'See docs/SOC2-EVIDENCE-MAP.md for the expected shape of the evidence packaging surface.'
)
process.exit(1)
