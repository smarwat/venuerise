#!/usr/bin/env node
/* eslint-disable */
/**
 * Phase 9S — UI interaction scanner.
 *
 * Best-effort grep over `components/` and `app/` looking for suspicious
 * UI patterns. The scanner is deliberately conservative: it errs on the
 * side of "warn the author" rather than producing a long machine-only
 * report. It is NOT a replacement for runtime QA — see
 * docs/UI-INTERACTION-AUDIT.md for the full audit.
 *
 * Detected categories (kept narrow so the signal stays high):
 *
 *  1. `href="#"` or `href=""` — placeholder anchors. Usually a dead
 *     control or a leftover stub.
 *  2. `onClick={() => {}}` / `onClick={()=>{}}` — empty click handler.
 *  3. `alert(` or `window.confirm(` — both should be replaced with
 *     in-product dialogs in real flows (admin one-shots are exempt
 *     when the line carries `// UI_INTERACTION_EXEMPT: ...`).
 *  4. `console.log(` in client interaction code (`'use client'` files
 *     under `components/`). Operator-facing surfaces should never log
 *     to the browser console.
 *  5. UI text like `TODO` / `Coming soon` / `Placeholder` / `Not wired`
 *     / `Wiring pending` rendered inside a JSX text node — fine if the
 *     control is also disabled, otherwise a 9S follow-up.
 *
 * Exemption: any line containing `UI_INTERACTION_EXEMPT` is skipped
 * with its reason captured in the summary. Keep exemptions narrow.
 *
 * Exit code is 0 when no findings; 1 otherwise so CI can gate.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SCAN_DIRS = ['components', 'app']
// Skip generated / vendored / build artefacts.
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', 'coverage'])

const findings = []
let exemptCount = 0

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (stat.isDirectory()) {
      walk(full)
      continue
    }
    if (!/\.(tsx|jsx)$/.test(entry)) continue
    scanFile(full)
  }
}

function record(file, line, category, snippet) {
  findings.push({
    file: relative(ROOT, file),
    line,
    category,
    snippet: snippet.trim().slice(0, 200),
  })
}

function scanFile(file) {
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const isClient = /^\s*['"]use client['"]/m.test(source)
  const lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw
    // Honor `UI_INTERACTION_EXEMPT` either on the same line OR on
    // the immediately preceding non-blank line. That lets authors
    // keep the destructive call clean and the exemption rationale
    // on its own comment line above.
    if (line.includes('UI_INTERACTION_EXEMPT')) {
      exemptCount++
      continue
    }
    let prevIdx = i - 1
    while (prevIdx >= 0 && lines[prevIdx].trim().length === 0) prevIdx--
    if (prevIdx >= 0 && lines[prevIdx].includes('UI_INTERACTION_EXEMPT')) {
      exemptCount++
      continue
    }
    const stripped = stripStringsAndComments(line)

    // 1. href="#" / href=""
    if (/href\s*=\s*["'](?:#|)["']/.test(line)) {
      record(file, i + 1, 'href_placeholder', line)
    }

    // 2. empty onClick handler
    if (/onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/.test(line)) {
      record(file, i + 1, 'empty_onclick', line)
    }

    // 3. alert( / window.confirm(
    // Skip lines that are clearly JSX text content (between > and <)
    // so button copy like "Send alert (env-gated)" doesn't trip the
    // regex.
    const inJsxText = /^[^<>]*>[^<]*\b(alert|confirm)\b[^<]*</.test(line)
    if (!inJsxText && /(^|[^.\w])alert\s*\(/.test(stripped)) {
      record(file, i + 1, 'alert_usage', line)
    }
    if (!inJsxText && /window\.confirm\s*\(/.test(stripped)) {
      record(file, i + 1, 'window_confirm', line)
    }

    // 4. console.log in client components (warn / error are ok for
    //    legitimate observability; we focus on `log`).
    if (isClient && /(^|[^.\w])console\.log\s*\(/.test(stripped)) {
      record(file, i + 1, 'console_log_client', line)
    }

    // 5. placeholder text inside JSX text node. We require the trigger
    //    word to appear between > and < to reduce comment noise.
    if (/>[^<]*\b(TODO|Coming soon|Placeholder|Not wired|Wiring pending)\b[^<]*</i.test(line)) {
      record(file, i + 1, 'placeholder_text_in_jsx', line)
    }
  }
}

/** Crude string + line-comment stripper so a literal `'alert('` in
 *  text doesn't trip alert_usage. We deliberately don't run a real
 *  parser — the scanner stays in one file with zero deps. */
function stripStringsAndComments(line) {
  let out = ''
  let i = 0
  let inSingle = false
  let inDouble = false
  let inBack = false
  while (i < line.length) {
    const ch = line[i]
    const next = line[i + 1]
    if (!inSingle && !inDouble && !inBack && ch === '/' && next === '/') break
    if (!inDouble && !inBack && ch === "'" && line[i - 1] !== '\\') { inSingle = !inSingle; i++; continue }
    if (!inSingle && !inBack && ch === '"' && line[i - 1] !== '\\') { inDouble = !inDouble; i++; continue }
    if (!inSingle && !inDouble && ch === '`' && line[i - 1] !== '\\') { inBack = !inBack; i++; continue }
    if (!inSingle && !inDouble && !inBack) out += ch
    i++
  }
  return out
}

for (const dir of SCAN_DIRS) walk(join(ROOT, dir))

if (findings.length === 0) {
  console.log(`✓ UI interaction scan clean — 0 findings (${exemptCount} exempt).`)
  process.exit(0)
}

const grouped = new Map()
for (const f of findings) {
  if (!grouped.has(f.category)) grouped.set(f.category, [])
  grouped.get(f.category).push(f)
}

const CATEGORY_LABELS = {
  href_placeholder: 'Placeholder href ("#" or empty)',
  empty_onclick: 'Empty onClick handler',
  alert_usage: 'alert() usage',
  window_confirm: 'window.confirm() usage',
  console_log_client: 'console.log in client component',
  placeholder_text_in_jsx: 'Placeholder text in JSX',
}

console.log(`✗ UI interaction scan — ${findings.length} finding(s) (${exemptCount} exempt).\n`)
for (const [cat, items] of grouped) {
  console.log(`  [${cat}] ${CATEGORY_LABELS[cat] ?? cat} — ${items.length}`)
  for (const it of items) {
    console.log(`    ${it.file}:${it.line}  ${it.snippet}`)
  }
  console.log()
}
console.log('Add `// UI_INTERACTION_EXEMPT: <reason>` on the offending line if intentional.')
process.exit(1)
