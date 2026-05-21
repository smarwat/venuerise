#!/usr/bin/env node
// Phase 9N — Local Trust Center pack generator.
//
// Writes a static pack to `artifacts/evidence/trust-center/`
// without requiring a running server or any Supabase
// credentials. Operators use this for off-line review +
// procurement archives.
//
// Output:
//   - artifacts/evidence/trust-center/public-trust-summary.md
//   - artifacts/evidence/trust-center/standard-trust-packet.md
//   - artifacts/evidence/trust-center/full-trust-packet.md
//   - artifacts/evidence/trust-center/trust-center-summary.json
//
// Honesty:
//   - The pack documents intent + curated buyer-safe copy. It
//     does NOT include subject data, secrets, audit internals,
//     or internal-only vendor rows.
//   - Operators MUST review before sharing externally.
//
// Source: extracts the curated `PUBLIC_TRUST_SECTIONS` +
// `PUBLIC_KNOWN_LIMITATIONS` + `SCOPE_INCLUDES` constants from
// `lib/enterprise/trust-center/policy.ts` as text. Same
// regex-extraction pattern as the Phase 9I evidence pack.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const POLICY_PATH = join(
  ROOT,
  'lib',
  'enterprise',
  'trust-center',
  'policy.ts'
)
const REGISTRY_PATH = join(
  ROOT,
  'lib',
  'enterprise',
  'vendor-risk',
  'vendor-registry.ts'
)
const OUT_DIR = join(ROOT, 'artifacts', 'evidence', 'trust-center')

const DISCLAIMER =
  'Trust materials are provided for security review purposes and do not represent a third-party certification, legal advice, or contractual commitment unless separately agreed in writing.'

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

// ── Section extractor ────────────────────────────────────────────────────

function extractSections(src) {
  const arr = src.match(
    /PUBLIC_TRUST_SECTIONS[^=]*=\s*\[([\s\S]+?)\n\]\s*$/m
  )
  const body = arr ? arr[1] : src
  const chunks = body.split(/\n\s*\{\s*\n?\s*id:/).slice(1)
  const out = []
  for (const raw of chunks) {
    const chunk = 'id:' + raw
    const id = field(chunk, 'id')
    if (!id) continue
    const title = field(chunk, 'title') ?? ''
    const bodyText = field(chunk, 'body') ?? ''
    const bullets = listField(chunk, 'bullets')
    out.push({ id, title, body: bodyText, bullets })
  }
  return out
}

function extractHeadline(src) {
  return field(src, 'PUBLIC_TRUST_HEADLINE') ?? ''
}

function extractKnownLimitations(src) {
  // PUBLIC_KNOWN_LIMITATIONS = [ ... ]
  const idx = src.indexOf('PUBLIC_KNOWN_LIMITATIONS')
  if (idx === -1) return []
  return listField(src.slice(idx), 'PUBLIC_KNOWN_LIMITATIONS')
}

function extractScopeIncludes(src) {
  // SCOPE_INCLUDES: Record<...> = { summary_only: [...], standard_packet: [...], full_packet: [...], custom: [...] }
  const idx = src.indexOf('SCOPE_INCLUDES')
  if (idx === -1) return null
  const open = src.indexOf('{', idx)
  if (open === -1) return null
  let depth = 0
  let close = -1
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1) return null
  const body = src.slice(open + 1, close)
  return {
    summary_only: listField(body, 'summary_only'),
    standard_packet: listField(body, 'standard_packet'),
    full_packet: listField(body, 'full_packet'),
  }
}

function extractPublicSubprocessors(registrySrc) {
  // Walk vendor blocks and pick those whose disclosureStatus
  // === 'public' for their name.
  const chunks = registrySrc.split(/\n\s*\{\s*\n?\s*\/\/[^\n]*\n?\s*id:/).slice(1)
  const fallback = registrySrc.split(/\n\s*\{\s*\n\s*id:/).slice(1)
  const source = chunks.length > 0 ? chunks : fallback
  const names = []
  for (const raw of source) {
    const chunk = 'id:' + raw
    const disclosure = field(chunk, 'disclosureStatus')
    if (disclosure !== 'public') continue
    const name = field(chunk, 'name')
    if (name) names.push(name)
  }
  return names
}

// ── Renderers ────────────────────────────────────────────────────────────

function renderPublicSummary(generatedAt, headline, sections, subprocessors, limitations) {
  const lines = []
  lines.push('# VenueRise Trust Center (public)')
  lines.push('')
  lines.push(`_Generated: ${generatedAt}_`)
  lines.push('')
  lines.push('> ' + DISCLAIMER)
  lines.push('')
  lines.push(headline)
  lines.push('')
  for (const s of sections) {
    lines.push(`## ${s.title}`)
    lines.push('')
    lines.push(s.body)
    if (s.bullets && s.bullets.length > 0) {
      lines.push('')
      for (const b of s.bullets) lines.push(`- ${b}`)
    }
    lines.push('')
  }
  lines.push('## Production subprocessors')
  lines.push('')
  for (const n of subprocessors) lines.push(`- ${n}`)
  lines.push('')
  lines.push('## Known limitations')
  lines.push('')
  for (const k of limitations) lines.push(`- ${k}`)
  return lines.join('\n')
}

function renderPacket(generatedAt, scope, included) {
  const lines = []
  lines.push(`# VenueRise Trust Packet — ${scope}`)
  lines.push('')
  lines.push(`_Generated: ${generatedAt}_`)
  lines.push('')
  lines.push('> ' + DISCLAIMER)
  lines.push('')
  lines.push('## Manifest')
  lines.push('')
  if (included.length === 0) {
    lines.push('No artifacts in this scope.')
  } else {
    for (const t of included) lines.push(`- ${t}`)
  }
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- This is a STATIC manifest. The live packet builder lives behind /api/admin/security/trust-center/packet.')
  lines.push('- Internal-only artifacts (custom) are never emitted to a buyer-facing scope.')
  lines.push('- Operator must review every artifact body before sharing externally.')
  lines.push('- This packet does NOT represent a SOC 2 certification.')
  return lines.join('\n')
}

function renderSummaryJson(generatedAt, headline, sections, subprocessors, limitations, scopes) {
  return (
    JSON.stringify(
      {
        generatedAt,
        disclaimer: DISCLAIMER,
        headline,
        sectionCount: sections.length,
        publicSubprocessors: subprocessors,
        publicKnownLimitations: limitations,
        scopeIncludes: scopes,
      },
      null,
      2
    ) + '\n'
  )
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(POLICY_PATH) || !existsSync(REGISTRY_PATH)) {
    console.error(
      `✗ trust-center policy or vendor registry not found (${POLICY_PATH}, ${REGISTRY_PATH})`
    )
    process.exit(1)
  }
  const policySrc = readFileSync(POLICY_PATH, 'utf8')
  const registrySrc = readFileSync(REGISTRY_PATH, 'utf8')

  const sections = extractSections(policySrc)
  const headline = extractHeadline(policySrc)
  const limitations = extractKnownLimitations(policySrc)
  const scopes = extractScopeIncludes(policySrc) ?? {
    summary_only: [],
    standard_packet: [],
    full_packet: [],
  }
  const subprocessors = extractPublicSubprocessors(registrySrc)

  if (sections.length === 0) {
    console.error('✗ no public sections extracted — extractor likely broken')
    process.exit(1)
  }

  const generatedAt = new Date().toISOString()
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  const publicPath = join(OUT_DIR, 'public-trust-summary.md')
  const standardPath = join(OUT_DIR, 'standard-trust-packet.md')
  const fullPath = join(OUT_DIR, 'full-trust-packet.md')
  const jsonPath = join(OUT_DIR, 'trust-center-summary.json')

  writeFileSync(
    publicPath,
    renderPublicSummary(
      generatedAt,
      headline,
      sections,
      subprocessors,
      limitations
    )
  )
  writeFileSync(
    standardPath,
    renderPacket(generatedAt, 'standard_packet', scopes.standard_packet)
  )
  writeFileSync(
    fullPath,
    renderPacket(generatedAt, 'full_packet', scopes.full_packet)
  )
  writeFileSync(
    jsonPath,
    renderSummaryJson(
      generatedAt,
      headline,
      sections,
      subprocessors,
      limitations,
      scopes
    )
  )

  console.log('✓ Trust Center pack generated')
  console.log(`  ${publicPath}`)
  console.log(`  ${standardPath}`)
  console.log(`  ${fullPath}`)
  console.log(`  ${jsonPath}`)
  console.log('')
  console.log(
    `  ${sections.length} public sections · ${subprocessors.length} public subprocessors · ${limitations.length} known limitations`
  )
  console.log('')
  console.log(
    'Note: this is a STATIC pack. The live Trust Center lives at /trust + /api/admin/security/trust-center/packet.'
  )
}

main()
