#!/usr/bin/env node
// Phase 9O — Local compliance operations pack generator.
//
// Writes a static pack to `artifacts/evidence/compliance-ops/`
// without requiring a running server, Supabase credentials, or
// even a seeded venue calendar. Operators use this for off-line
// review of the policy + sharing the cadence matrix with
// auditors / buyers.
//
// Output:
//   - artifacts/evidence/compliance-ops/compliance-review-policy.md
//   - artifacts/evidence/compliance-ops/compliance-review-policy.csv
//   - artifacts/evidence/compliance-ops/compliance-freshness-template.md
//   - artifacts/evidence/compliance-ops/compliance-ops-summary.json
//
// Honesty:
//   - The pack documents OPERATOR-INTENDED cadence. It does NOT
//     reflect any particular venue's live completion state.
//   - Operators MUST review before sharing externally.
//
// Source: regex-extracts the policy + disclaimer from
// `lib/enterprise/compliance-ops/policy.ts` as text. Same
// pattern as Phase 9I evidence pack + 9K vendor pack + 9L
// incident pack + 9M privacy pack + 9N trust pack.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const POLICY_PATH = join(
  ROOT,
  'lib',
  'enterprise',
  'compliance-ops',
  'policy.ts'
)
const OUT_DIR = join(ROOT, 'artifacts', 'evidence', 'compliance-ops')

const DISCLAIMER =
  'The compliance operations calendar tracks operator-initiated reviews of internal controls. It does NOT prove continuous compliance. It does NOT auto-rotate secrets, auto-refresh trust artifacts, or send external alerts. Completion is operator-marked; waivers carry an explicit reason. Stale-flagging is a soft signal, not a control failure.'

// ── Field extractors ─────────────────────────────────────────────────────

function field(chunk, key) {
  const re = new RegExp(
    `${key}:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`,
    's'
  )
  const m = chunk.match(re)
  if (!m) return null
  return m[2].replace(/\\'/g, "'").replace(/\\"/g, '"')
}

function intField(chunk, key) {
  const re = new RegExp(`${key}:\\s*(\\d+)`)
  const m = chunk.match(re)
  return m ? Number(m[1]) : null
}

function listField(chunk, key) {
  const idx = chunk.indexOf(`${key}:`)
  if (idx === -1) return []
  const open = chunk.indexOf('[', idx)
  if (open === -1) return []
  let depth = 0
  let close = -1
  for (let i = open; i < chunk.length; i += 1) {
    const ch = chunk[i]
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1) return []
  const inner = chunk.slice(open + 1, close)
  const items = []
  const re = /'((?:\\.|[^'\\])*)'/g
  let m
  while ((m = re.exec(inner)) !== null) {
    items.push(m[1])
  }
  return items
}

// ── Policy extractor ─────────────────────────────────────────────────────

function extractPolicy(src) {
  const arr = src.match(
    /COMPLIANCE_REVIEW_POLICY[^=]*=\s*\[([\s\S]+?)\n\]\s*$/m
  )
  const body = arr ? arr[1] : src
  const chunks = body.split(/\n\s*\{\s*\n?\s*id:/).slice(1)
  const out = []
  for (const raw of chunks) {
    const chunk = 'id:' + raw
    const id = field(chunk, 'id')
    if (!id) continue
    out.push({
      id,
      area: field(chunk, 'area') ?? 'custom',
      title: field(chunk, 'title') ?? '',
      cadence: field(chunk, 'cadence') ?? 'ad_hoc',
      description: field(chunk, 'description') ?? '',
      ownerRole: field(chunk, 'ownerRole') ?? '',
      evidenceReferences: listField(chunk, 'evidenceReferences'),
      recommendedAction: field(chunk, 'recommendedAction') ?? '',
      staleAfterDays: intField(chunk, 'staleAfterDays') ?? 0,
      buyerImpactIfStale: field(chunk, 'buyerImpactIfStale') ?? '',
    })
  }
  return out
}

// ── Renderers ────────────────────────────────────────────────────────────

function csvEscape(value) {
  const s = String(value ?? '')
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

function renderPolicyMarkdown(generatedAt, policy) {
  const lines = []
  lines.push('# VenueRise Compliance Review Policy')
  lines.push('')
  lines.push(`_Generated: ${generatedAt}_`)
  lines.push('')
  lines.push('> ' + DISCLAIMER)
  lines.push('')
  lines.push(`${policy.length} policy items across operator-intended cadence.`)
  lines.push('')
  // Cadence summary table.
  const byCadence = new Map()
  for (const p of policy) {
    byCadence.set(p.cadence, (byCadence.get(p.cadence) ?? 0) + 1)
  }
  lines.push('## Cadence summary')
  lines.push('')
  lines.push('| Cadence | Count |')
  lines.push('|---|---:|')
  for (const c of ['monthly', 'quarterly', 'semiannual', 'annual', 'ad_hoc']) {
    lines.push(`| ${c} | ${byCadence.get(c) ?? 0} |`)
  }
  lines.push('')
  lines.push('## Per-area policy')
  lines.push('')
  for (const item of policy) {
    lines.push(`### ${item.title}`)
    lines.push('')
    lines.push(`- **Area**: ${item.area}`)
    lines.push(`- **Cadence**: ${item.cadence}`)
    lines.push(`- **Owner role**: ${item.ownerRole}`)
    lines.push(`- **Stale after**: ${item.staleAfterDays} days`)
    lines.push('')
    lines.push(item.description)
    if (item.recommendedAction) {
      lines.push('')
      lines.push(`**Recommended action**: ${item.recommendedAction}`)
    }
    if (item.evidenceReferences.length > 0) {
      lines.push('')
      lines.push('**Evidence references**')
      for (const r of item.evidenceReferences) lines.push(`- \`${r}\``)
    }
    if (item.buyerImpactIfStale) {
      lines.push('')
      lines.push(`**Buyer impact if stale**: ${item.buyerImpactIfStale}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function renderPolicyCsv(policy) {
  const headers = [
    'id',
    'area',
    'title',
    'cadence',
    'owner_role',
    'stale_after_days',
    'description',
    'recommended_action',
    'buyer_impact_if_stale',
    'evidence_reference_count',
  ]
  const rows = [headers.join(',')]
  for (const p of policy) {
    rows.push(
      [
        p.id,
        p.area,
        p.title,
        p.cadence,
        p.ownerRole,
        String(p.staleAfterDays),
        p.description,
        p.recommendedAction,
        p.buyerImpactIfStale,
        String(p.evidenceReferences.length),
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  return rows.join('\n') + '\n'
}

function renderFreshnessTemplate(generatedAt) {
  return `# VenueRise Compliance Freshness — Template

_Generated: ${generatedAt}_

> ${DISCLAIMER}

## Per-area template

Use this template to manually record review status when the
live admin route is unavailable (e.g. tabletop exercise, audit
prep). Replace placeholders before sharing externally.

| Area | Title | Last completed | Next due | Status | Stale |
|---|---|---|---|---|---|
| vendor_risk | Vendor risk registry review | YYYY-MM-DD | YYYY-MM-DD | completed / upcoming / overdue | yes / no |
| subprocessors | Subprocessor disclosure review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| privacy_dsr | Privacy data inventory review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| retention_policy | Retention policy review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| disaster_recovery | Disaster recovery dry-run | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| backup_posture | Backup posture review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| incident_response | Incident tabletop exercise | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| trust_center | Trust Center public copy review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| trust_center | Trust Center gated artifact review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| security_questionnaire | Security questionnaire review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| evidence_pack | Evidence pack regeneration | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| sso_readiness | SSO readiness review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| audit_coverage | Audit coverage scanner review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| rate_limit_coverage | Rate-limit coverage scanner review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| access_control | RBAC matrix review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| security_headers | Security headers + CSP review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |
| data_lifecycle | Data lifecycle review | YYYY-MM-DD | YYYY-MM-DD | ... | ... |

## Notes

- Live freshness data lives behind /api/admin/security/compliance/freshness.
- This template is for off-line review and pre-deploy planning.
- The platform does NOT auto-update this template.
`
}

function renderSummaryJson(generatedAt, policy) {
  const byCadence = {}
  const byArea = {}
  for (const p of policy) {
    byCadence[p.cadence] = (byCadence[p.cadence] ?? 0) + 1
    byArea[p.area] = (byArea[p.area] ?? 0) + 1
  }
  return (
    JSON.stringify(
      {
        generatedAt,
        disclaimer: DISCLAIMER,
        counts: {
          totalPolicyItems: policy.length,
          byCadence,
          byArea,
        },
      },
      null,
      2
    ) + '\n'
  )
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(POLICY_PATH)) {
    console.error(`✗ compliance ops policy not found at ${POLICY_PATH}`)
    process.exit(1)
  }
  const src = readFileSync(POLICY_PATH, 'utf8')
  const policy = extractPolicy(src)
  if (policy.length === 0) {
    console.error('✗ no policy items extracted — extractor likely broken')
    process.exit(1)
  }
  const generatedAt = new Date().toISOString()
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  const policyMd = join(OUT_DIR, 'compliance-review-policy.md')
  const policyCsv = join(OUT_DIR, 'compliance-review-policy.csv')
  const freshnessTpl = join(OUT_DIR, 'compliance-freshness-template.md')
  const jsonPath = join(OUT_DIR, 'compliance-ops-summary.json')

  writeFileSync(policyMd, renderPolicyMarkdown(generatedAt, policy))
  writeFileSync(policyCsv, renderPolicyCsv(policy))
  writeFileSync(freshnessTpl, renderFreshnessTemplate(generatedAt))
  writeFileSync(jsonPath, renderSummaryJson(generatedAt, policy))

  console.log('✓ Compliance ops pack generated')
  console.log(`  ${policyMd}`)
  console.log(`  ${policyCsv}`)
  console.log(`  ${freshnessTpl}`)
  console.log(`  ${jsonPath}`)
  console.log('')
  console.log(`  ${policy.length} policy items across operator-intended cadence`)
  console.log('')
  console.log(
    'Note: this is a STATIC pack. The live calendar lives behind /api/admin/security/compliance/calendar.'
  )
}

main()
