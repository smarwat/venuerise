// AUDIT_EXEMPT: diagnostic probe — issues a 1-token Anthropic
// completion to verify the API key + retry path. Reads no
// customer data, mutates no rows. Operator hits this routinely
// during incident triage; an audit row per probe would create
// pure noise. Pino logs capture invocation. Documented in
// docs/AUDIT-COVERAGE.md.
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/require-admin'
import { anthropic, MODEL } from '@/lib/anthropic'
import { withAnthropicRetry } from '@/lib/anthropic-retry'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * POST /api/admin/anthropic-probe
 *
 * Fires a single tiny Anthropic call to verify Claude is reachable and tokens
 * are flowing. Useful for ops: "is Anthropic down or is my prompt broken?"
 *
 * The prompt is minimal and the max_tokens cap is small — typical cost is
 * sub-cent per call. The retry wrapper applies so transient 429/5xx still
 * resolves to ok=true.
 *
 * Returns:
 *   { ok, model, latency_ms, input_tokens?, output_tokens? }
 */

const PROBE_SYSTEM = 'Reply with the single word "OK" and nothing else.'
const PROBE_USER = 'ping'
const PROBE_MAX_TOKENS = 4 // upper bound on output cost

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/admin/anthropic-probe' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user } = admin

  const rl = await rateLimitUserAction(request, `admin:anthropic-probe:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const startedAt = Date.now()
  try {
    const response = await withAnthropicRetry(
      (signal) =>
        anthropic.messages.create(
          {
            model: MODEL,
            max_tokens: PROBE_MAX_TOKENS,
            system: PROBE_SYSTEM,
            messages: [{ role: 'user', content: PROBE_USER }],
          },
          { signal }
        ),
      { agent: 'admin-probe', requestId, model: MODEL }
    )
    const latencyMs = Date.now() - startedAt

    reqLog.info(
      {
        userId: user.id,
        model: MODEL,
        latencyMs,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      'admin.anthropic_probe.completed'
    )

    return respond(NextResponse.json({
      ok: true,
      model: MODEL,
      latency_ms: latencyMs,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    }))
  } catch (err) {
    const latencyMs = Date.now() - startedAt
    reqLog.error({ err, userId: user.id, latencyMs }, 'admin.anthropic_probe.failed')
    captureApiError(err, { requestId, route: '/api/admin/anthropic-probe', userId: user.id })
    const message = err instanceof Error ? err.message : 'Anthropic probe failed'
    return respond(NextResponse.json({ ok: false, error: message, latency_ms: latencyMs }, { status: 502 }))
  }
}
