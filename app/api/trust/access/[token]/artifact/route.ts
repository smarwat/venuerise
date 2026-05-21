// Public route. Validates bearer token + scope before
// emitting the requested artifact. Records `artifact_downloaded`
// trust_access_event (NOT an audit_events row — the operator
// audit feed is admin-tenant-scoped; trust access events live
// in their own table). Rate-limited by token hash / IP.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { rateLimitWidget, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import {
  hashTrustToken,
  recordTrustAccessEvent,
  validateTrustAccessToken,
} from '@/lib/enterprise/trust-center/access'
import {
  renderTrustArtifactCsv,
  renderTrustArtifactMarkdown,
} from '@/lib/enterprise/trust-center/artifacts'
import { TRUST_CENTER_DISCLAIMER } from '@/lib/enterprise/trust-center/policy'
import {
  TRUST_ARTIFACT_TYPES,
  type TrustArtifactFormat,
  type TrustArtifactType,
} from '@/lib/enterprise/trust-center/types'

const QuerySchema = z.object({
  type: z.enum(
    TRUST_ARTIFACT_TYPES as unknown as [TrustArtifactType, ...TrustArtifactType[]]
  ),
  format: z.enum(['markdown', 'csv', 'json']).optional(),
})

type RouteContext = { params: Promise<{ token: string }> }

async function loadParams(ctx: RouteContext): Promise<{ token: string }> {
  return ctx.params
}

export async function GET(
  request: NextRequest,
  ctx: RouteContext
): Promise<Response> {
  const { token } = await loadParams(ctx)
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/trust/access/[token]/artifact',
    op: 'public.trust.artifact.download',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  // Rate-limit by token hash (NOT raw token) — bounds the
  // blast radius of a leaked token without exposing the
  // plaintext anywhere logger-adjacent.
  let tokenHash: string
  try {
    tokenHash = hashTrustToken(token ?? '')
  } catch {
    return respond(NextResponse.json({ error: 'invalid' }, { status: 401 }))
  }
  // rateLimitWidget keys on IP plus an optional pseudo-venueId
  // suffix. We pass the token-hash prefix so a leaked token is
  // bounded per-IP without exposing the token itself. The
  // abuse-event row carries the same identifier in the
  // limiterKey for cross-correlation.
  const rl = await rateLimitWidget(
    request,
    `trust-token:${tokenHash.slice(0, 16)}`,
    {
      route: '/api/trust/access/[token]/artifact',
      method: 'GET',
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn({ tokenHashPrefix: tokenHash.slice(0, 16) }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const validation = await validateTrustAccessToken(token)
  if (!validation.ok || !validation.grant) {
    void recordTrustAccessEvent({
      grantId: validation.grant?.id ?? null,
      venueId: validation.grant?.venueId ?? null,
      eventType: 'access_denied',
      artifactType: null,
      format: null,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: { reason: validation.reason },
    })
    return respond(NextResponse.json({ error: 'invalid' }, { status: 401 }))
  }
  const grant = validation.grant

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    type: url.searchParams.get('type') ?? undefined,
    format: url.searchParams.get('format') ?? undefined,
  })
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const type = parsed.data.type
  const format: TrustArtifactFormat = parsed.data.format ?? 'markdown'

  try {
    if (format === 'csv') {
      const body = await renderTrustArtifactCsv(type, grant.scope)
      if (!body) {
        return respond(
          NextResponse.json(
            { error: 'not_available_in_scope_or_format' },
            { status: 404 }
          )
        )
      }
      void recordTrustAccessEvent({
        grantId: grant.id,
        venueId: grant.venueId,
        eventType: 'artifact_downloaded',
        artifactType: type,
        format,
        ip:
          request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        userAgent: request.headers.get('user-agent'),
        metadata: { scope: grant.scope },
      })
      const date = new Date().toISOString().slice(0, 10)
      return respond(
        new NextResponse(body, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="venuerise-${type}-${date}.csv"`,
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow',
          },
        })
      )
    }
    if (format === 'json') {
      const md = await renderTrustArtifactMarkdown(type, grant.scope)
      void recordTrustAccessEvent({
        grantId: grant.id,
        venueId: grant.venueId,
        eventType: 'artifact_downloaded',
        artifactType: type,
        format,
        ip:
          request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        userAgent: request.headers.get('user-agent'),
        metadata: { scope: grant.scope },
      })
      return respond(
        NextResponse.json(
          {
            disclaimer: TRUST_CENTER_DISCLAIMER,
            type,
            scope: grant.scope,
            format,
            markdown: md,
          },
          { headers: { 'X-Robots-Tag': 'noindex, nofollow' } }
        )
      )
    }
    // markdown
    const body = await renderTrustArtifactMarkdown(type, grant.scope)
    void recordTrustAccessEvent({
      grantId: grant.id,
      venueId: grant.venueId,
      eventType: 'artifact_downloaded',
      artifactType: type,
      format,
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
      metadata: { scope: grant.scope },
    })
    const date = new Date().toISOString().slice(0, 10)
    return respond(
      new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="venuerise-${type}-${date}.md"`,
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
        },
      })
    )
  } catch (err) {
    reqLog.error({ err }, 'public.trust.artifact.download_failed')
    captureApiError(err, {
      requestId,
      route: '/api/trust/access/[token]/artifact',
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
}
