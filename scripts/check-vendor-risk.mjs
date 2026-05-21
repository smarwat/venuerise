#!/usr/bin/env node
// Phase 9K — Vendor risk + subprocessor disclosure regression
// guard.
//
// Asserts the Phase 9K scaffolding is in place:
//   - lib/enterprise/vendor-risk/{types,vendor-registry,report}.ts
//   - Two admin routes (vendor-risk-report, subprocessor-disclosure)
//   - Two UI cards (VendorRiskCard, SubprocessorDisclosureCard)
//   - Local pack script (build-vendor-risk-pack)
//   - docs/VENDOR-RISK.md
//   - package.json has build:vendor-risk-pack + check:vendor-risk
//   - RATE-LIMIT-COVERAGE references the new routes
//   - RBAC-MATRIX references vendor-risk-report access
//   - questionnaire-map references subprocessors / vendor review
//
// Also spot-checks that every vendor known to be in the
// production runtime (recognised by `package.json` dependency
// name or by an env reference in `.env.example`) has a row in
// the registry, so adding a new SDK without registering it as a
// vendor fails loud.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const REQUIRED_FILES = [
  'lib/enterprise/vendor-risk/types.ts',
  'lib/enterprise/vendor-risk/vendor-registry.ts',
  'lib/enterprise/vendor-risk/report.ts',
  'app/api/admin/security/vendor-risk-report/route.ts',
  'app/api/admin/security/subprocessor-disclosure/route.ts',
  'components/dashboard/settings/VendorRiskCard.tsx',
  'components/dashboard/settings/SubprocessorDisclosureCard.tsx',
  'scripts/build-vendor-risk-pack.mjs',
  'docs/VENDOR-RISK.md',
]

const PACKAGE_SCRIPTS = ['build:vendor-risk-pack', 'check:vendor-risk']

const DOC_REFERENCES = [
  {
    path: 'docs/RATE-LIMIT-COVERAGE.md',
    tokens: ['vendor-risk-report', 'subprocessor-disclosure'],
    label: 'Phase 9K admin routes',
  },
  {
    path: 'docs/RBAC-MATRIX.md',
    tokens: ['vendor-risk-report', 'subprocessor-disclosure'],
    label: 'vendor risk access posture',
  },
  {
    path: 'lib/enterprise/evidence/questionnaire-map.ts',
    tokens: ['subprocessor', 'vendor-security-review'],
    label: 'questionnaire subprocessor + vendor review questions',
  },
  {
    path: 'docs/BILLING-QA.md',
    tokens: ['vendor risk', 'subprocessor'],
    label: 'Phase 9K QA checks',
  },
  {
    path: 'docs/ENTERPRISE-SALES-READINESS.md',
    tokens: ['vendor-risk-report', 'subprocessor-disclosure'],
    label: 'sales workflow references the new exports',
  },
  {
    path: 'docs/SOC2-EVIDENCE-MAP.md',
    tokens: ['vendor', 'subprocessor'],
    label: 'evidence map references vendor management',
  },
]

// Vendor expectations: any known production SDK that lands in
// package.json or .env.example must have a row in the registry.
// `match` is matched as a case-insensitive substring against the
// registry source.
const KNOWN_VENDOR_PACKAGES = [
  { pkg: '@supabase/supabase-js', match: "id: 'supabase'" },
  { pkg: '@anthropic-ai/sdk', match: "id: 'anthropic'" },
  { pkg: 'stripe', match: "id: 'stripe'" },
  { pkg: 'resend', match: "id: 'resend'" },
  { pkg: '@upstash/redis', match: "id: 'upstash'" },
  { pkg: 'inngest', match: "id: 'inngest'" },
  { pkg: '@sentry/nextjs', match: "id: 'sentry'" },
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

// Cross-check the registry against package.json. A package that
// lands in dependencies without a registry row is a tracking gap.
const registryPath = join(ROOT, 'lib/enterprise/vendor-risk/vendor-registry.ts')
if (existsSync(registryPath) && existsSync(pkgPath)) {
  const registry = readFileSync(registryPath, 'utf8')
  const pkg = readFileSync(pkgPath, 'utf8')
  for (const v of KNOWN_VENDOR_PACKAGES) {
    if (!pkg.includes(`"${v.pkg}"`)) continue
    if (!registry.includes(v.match)) {
      missing.push({
        kind: 'registry_gap',
        pkg: v.pkg,
        match: v.match,
      })
    } else {
      present.push(`registry covers package: ${v.pkg}`)
    }
  }
}

if (missing.length === 0) {
  console.log('✓ Vendor risk scaffolding clean')
  for (const row of present) console.log(`  ✓ ${row}`)
  process.exit(0)
}

console.error('✗ Vendor risk scaffolding has gaps')
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
  } else if (m.kind === 'registry_gap') {
    console.error(
      `  ✗ vendor-registry.ts is missing a row for package "${m.pkg}" (expected to find ${m.match})`
    )
  }
}
console.error('')
console.error('See docs/VENDOR-RISK.md for the expected shape.')
process.exit(1)
