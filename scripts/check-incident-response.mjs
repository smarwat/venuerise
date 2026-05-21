#!/usr/bin/env node
// Phase 9L — Incident response regression guard.
//
// Asserts the Phase 9L scaffolding is in place:
//   - lib/enterprise/incidents/{types,policy,incidents,detectors,alert-routing}.ts
//   - supabase/migrations/032_incident_response.sql
//   - Four admin routes (list/create, [id] read/update, detect, alert)
//   - IncidentResponseCard
//   - Local pack script + scanner script
//   - docs/INCIDENT-RESPONSE.md
//   - package.json has build:incident-response-pack + check:incident-response
//   - RATE-LIMIT-COVERAGE references the new admin routes
//   - RBAC matrix references incident access
//   - questionnaire-map references incident response
//   - evidence map references incident-response controls

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const REQUIRED_FILES = [
  'lib/enterprise/incidents/types.ts',
  'lib/enterprise/incidents/policy.ts',
  'lib/enterprise/incidents/incidents.ts',
  'lib/enterprise/incidents/detectors.ts',
  'lib/enterprise/incidents/alert-routing.ts',
  'supabase/migrations/032_incident_response.sql',
  'app/api/admin/security/incidents/route.ts',
  'app/api/admin/security/incidents/[id]/route.ts',
  'app/api/admin/security/incidents/detect/route.ts',
  'app/api/admin/security/incidents/[id]/alert/route.ts',
  'components/dashboard/settings/IncidentResponseCard.tsx',
  'scripts/build-incident-response-pack.mjs',
  'docs/INCIDENT-RESPONSE.md',
]

const PACKAGE_SCRIPTS = [
  'build:incident-response-pack',
  'check:incident-response',
]

const DOC_REFERENCES = [
  {
    path: 'docs/RATE-LIMIT-COVERAGE.md',
    tokens: ['/api/admin/security/incidents', 'incident-detect'],
    label: 'Phase 9L admin routes',
  },
  {
    path: 'docs/RBAC-MATRIX.md',
    tokens: ['/api/admin/security/incidents'],
    label: 'incident response access posture',
  },
  {
    path: 'lib/enterprise/evidence/questionnaire-map.ts',
    tokens: ['incident-process', 'monitoring-24x7', 'incident-postmortem'],
    label: 'questionnaire incident response questions',
  },
  {
    path: 'lib/enterprise/evidence/control-map.ts',
    tokens: [
      'incident-response-records',
      'incident-alert-routing',
      'post-incident-review-template',
    ],
    label: 'evidence map incident response controls',
  },
  {
    path: 'docs/BILLING-QA.md',
    tokens: ['incident response', 'detect candidates'],
    label: 'Phase 9L QA checks',
  },
  {
    path: 'docs/ENTERPRISE-SALES-READINESS.md',
    tokens: ['incident', 'IncidentResponseCard'],
    label: 'sales workflow references the incident layer',
  },
  {
    path: 'docs/SOC2-EVIDENCE-MAP.md',
    tokens: ['incident', 'post-incident review'],
    label: 'evidence map references incident response',
  },
  {
    path: 'docs/VENDOR-RISK.md',
    tokens: ['Slack', 'PagerDuty'],
    label: 'vendor risk notes Slack/PagerDuty as optional alert vendors',
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
  console.log('✓ Incident response scaffolding clean')
  for (const row of present) console.log(`  ✓ ${row}`)
  process.exit(0)
}

console.error('✗ Incident response scaffolding has gaps')
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
console.error('See docs/INCIDENT-RESPONSE.md for the expected shape.')
process.exit(1)
