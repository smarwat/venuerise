// AUDIT_EXEMPT: anonymous security telemetry endpoint; no operator
// mutation. CSP-violation reports flow here from browsers running
// the Phase 9E Content-Security-Policy-Report-Only header. The
// endpoint is unauthenticated by design (browsers fire it on
// CSP-violations from any page, including the public widget) and
// per-IP rate-limited. We log structured events for operator
// review; we do NOT write `audit_events` rows here because the
// payload is anonymous + browser-supplied, not an operator action.
// Documented in docs/AUDIT-COVERAGE.md.

import { NextRequest, NextResponse } from 'next/server'
import { rateLimitCspReport, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'

/**
 * POST /api/security/csp-report  (Phase 9E)
 *
 * Anonymous sink for browser CSP-violation reports. Three payload
 * shapes are accepted in the wild:
 *
 *   1. `application/csp-report`           (Chrome/Safari level-2)
 *      `{ "csp-report": { ... } }`
 *   2. `application/reports+json`         (Reporting API v1+)
 *      `[{ "type": "csp-violation", "body": { ... } }, ...]`
 *   3. plain `application/json`           (legacy / curl / dev)
 *
 * All three are parsed into the SAME normalized shape before
 * logging, so the operator's structured-log search hits every
 * variant.
 *
 * ── PRIVACY POSTURE ─────────────────────────────────────────────────────
 *   - We do NOT read cookies. The handler never reads `req.headers.get('cookie')`.
 *   - We do NOT log the raw request body — only the normalized,
 *     allowlisted fields below.
 *   - User-Agent is truncated to 240 chars (same cap as audit
 *     events) so a pathological client can't blow log lines.
 *   - The `document-uri` and `blocked-uri` fields are STRING-capped
 *     at 1 KB each; a CSP violation pointing at a URL with a 64 KB
 *     query string shouldn't fill the log.
 *   - IP is extracted only for the rate-limit key (via `extractIp`
 *     inside the limiter) and is NOT included in the log line —
 *     the limiter's prefix is the audit trail for "this IP burst".
 *
 * ── RATE LIMIT ──────────────────────────────────────────────────────────
 * `rateLimitCspReport` keys on IP via the Phase 9E `vr:csp` prefix
 * (60/min/IP). Over-limit returns 429 from the standard helper —
 * we do NOT 204 silently on overflow because a real flood is a
 * signal the operator should see.
 *
 * ── RESPONSE ────────────────────────────────────────────────────────────
 * Always 204 on accepted reports. The CSP spec lets the browser
 * ignore the response body; 204 keeps the wire small.
 */

// Per-field caps. Keep these defensive — browsers occasionally emit
// pathological URIs (data: URLs that are themselves multi-MB).
const MAX_STRING_FIELD = 1_024
const MAX_USER_AGENT = 240
const MAX_BODY_BYTES = 32 * 1_024 // hard cap on the parsed JSON body

interface NormalizedCspReport {
  documentUri: string | null
  referrer: string | null
  blockedUri: string | null
  violatedDirective: string | null
  effectiveDirective: string | null
  originalPolicy: string | null
  disposition: string | null
  scriptSample: string | null
  statusCode: number | null
  sourceFile: string | null
  lineNumber: number | null
  columnNumber: number | null
}

function clampString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0) return null
  return value.length > max ? value.slice(0, max) : value
}

function clampNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/**
 * Map an arbitrary CSP report payload (level-2 csp-report shape OR
 * reports-api body shape) to the normalized form we log. We never
 * pass through unknown keys — allowlist is the only safe posture
 * for a public endpoint.
 */
function normalize(body: unknown): NormalizedCspReport | null {
  if (!body || typeof body !== 'object') return null

  // Level-2: { "csp-report": {...} }
  const wrapped = (body as Record<string, unknown>)['csp-report']
  // Reports-API entry: { type: 'csp-violation', body: {...} }
  const apiBody = (body as Record<string, unknown>).body
  const inner =
    wrapped && typeof wrapped === 'object'
      ? (wrapped as Record<string, unknown>)
      : apiBody && typeof apiBody === 'object'
        ? (apiBody as Record<string, unknown>)
        : (body as Record<string, unknown>)

  return {
    // Level-2 uses kebab-case (`document-uri`), Reports-API uses
    // camelCase (`documentURL`). Try both for every field.
    documentUri: clampString(
      inner['document-uri'] ?? inner.documentURL,
      MAX_STRING_FIELD
    ),
    referrer: clampString(inner.referrer, MAX_STRING_FIELD),
    blockedUri: clampString(
      inner['blocked-uri'] ?? inner.blockedURL,
      MAX_STRING_FIELD
    ),
    violatedDirective: clampString(
      inner['violated-directive'] ?? inner.violatedDirective,
      MAX_STRING_FIELD
    ),
    effectiveDirective: clampString(
      inner['effective-directive'] ?? inner.effectiveDirective,
      MAX_STRING_FIELD
    ),
    originalPolicy: clampString(
      inner['original-policy'] ?? inner.originalPolicy,
      MAX_STRING_FIELD
    ),
    disposition: clampString(inner.disposition, 32),
    scriptSample: clampString(
      inner['script-sample'] ?? inner.sample,
      MAX_STRING_FIELD
    ),
    statusCode: clampNumber(inner['status-code'] ?? inner.statusCode),
    sourceFile: clampString(
      inner['source-file'] ?? inner.sourceFile,
      MAX_STRING_FIELD
    ),
    lineNumber: clampNumber(inner['line-number'] ?? inner.lineNumber),
    columnNumber: clampNumber(inner['column-number'] ?? inner.columnNumber),
  }
}

/**
 * Reports-API ships an ARRAY of reports per POST. Wrap the
 * normalizer so callers can iterate either shape uniformly.
 */
function normalizeBatch(body: unknown): NormalizedCspReport[] {
  if (Array.isArray(body)) {
    return body
      .map((entry) => normalize(entry))
      .filter((entry): entry is NormalizedCspReport => entry !== null)
  }
  const single = normalize(body)
  return single ? [single] : []
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/security/csp-report',
    op: 'security.csp_report',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  // 1. Rate limit — per-IP. CSP reports are anonymous; the IP is
  // the only available identity dimension.
  const rl = await rateLimitCspReport(request)
  if (!rl.allowed) {
    reqLog.warn({ retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  // 2. Parse the body defensively. We cap the bytes read so a
  // malicious client can't OOM the process with a 50 MB JSON blob.
  // (Next.js's default body parser already caps requests at ~1 MB
  // for app router routes; this is belt-and-braces.)
  let raw: string
  try {
    raw = await request.text()
  } catch {
    return respond(new NextResponse(null, { status: 204 }))
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    // Silently 204 — we don't want to give a fingerprint to a
    // probing client about WHY we ignored their report.
    if (raw.length > MAX_BODY_BYTES) {
      reqLog.warn({ size: raw.length }, 'security.csp_report.body_too_large')
    }
    return respond(new NextResponse(null, { status: 204 }))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Browsers can occasionally send malformed JSON; don't let it
    // pollute Sentry. Silent 204.
    return respond(new NextResponse(null, { status: 204 }))
  }

  const reports = normalizeBatch(parsed)
  if (reports.length === 0) {
    // Body had no recognizable CSP report shape. Probably a probe.
    return respond(new NextResponse(null, { status: 204 }))
  }

  // 3. Extract operator-useful context. NO cookies. NO IP — that's
  // the rate-limit key, not a logged dimension.
  const userAgent = clampString(
    request.headers.get('user-agent'),
    MAX_USER_AGENT
  )
  const contentType = clampString(request.headers.get('content-type'), 80)

  // 4. Log one structured line per report. Deliberately NOT
  // Sentry-captured at this level — every CSP rollout produces a
  // burst of legitimate reports, and we don't want to drown Sentry
  // in noise. Operators investigating a CSP issue grep the logs;
  // operators investigating an outage look at Sentry.
  for (const r of reports) {
    reqLog.info(
      {
        documentUri: r.documentUri,
        blockedUri: r.blockedUri,
        violatedDirective: r.violatedDirective,
        effectiveDirective: r.effectiveDirective,
        disposition: r.disposition,
        statusCode: r.statusCode,
        sourceFile: r.sourceFile,
        lineNumber: r.lineNumber,
        columnNumber: r.columnNumber,
        userAgent,
        contentType,
      },
      'security.csp_report.received'
    )
  }

  return respond(new NextResponse(null, { status: 204 }))
}
