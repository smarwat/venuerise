import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/require-admin'
import { sendEmail } from '@/lib/integrations/email'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { z } from 'zod'

/**
 * POST /api/admin/test-send
 *
 * Sends a real outbound email *to the authenticated user's own address only*
 * — not an arbitrary recipient. This is the closed-loop test for "is our
 * Resend setup actually delivering?".
 *
 * Body (all optional):
 *   { subject?, text? }
 *
 * Writes an `outbound_messages` row tagged `related_table='admin_test'` so
 * the call appears in the outbound log.
 */

const BodySchema = z.object({
  subject: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(10_000).optional(),
})

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({ requestId, route: '/api/admin/test-send' })
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
  }
  const { user, venueId } = admin

  // Require an inbox address on the authenticated user — cookie/magic-link
  // users without an email primary can't receive the test send.
  if (!user.email) {
    return respond(NextResponse.json({ error: 'no_user_email' }, { status: 400 }))
  }

  // Rate limit — same userAction limiter (30/min). The destination is fixed
  // to the user's own inbox so per-recipient ceilings don't help here.
  const rl = await rateLimitUserAction(request, `admin:test-send:${user.id}`)
  if (!rl.allowed) {
    reqLog.warn({ userId: user.id, retryMs: rl.retryAfterMs }, 'rate_limit.blocked')
    return respond(rateLimitedResponse(rl))
  }

  const body = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }))
  }

  const subject = parsed.data.subject ?? 'VenueRise admin test send'
  const text =
    parsed.data.text ??
    `This is a closed-loop test send from /api/admin/test-send.\n\nIf you received this, your Resend + suppression + outbound-log pipeline is working.\n\nrequestId: ${requestId}`

  try {
    const result = await sendEmail({
      to: user.email,
      subject,
      text,
      venueId,
      relatedTable: 'admin_test',
      metadata: {
        admin_user: user.id,
        request_id: requestId,
      },
    })

    reqLog.info(
      {
        userId: user.id,
        venueId,
        delivered: result.delivered,
        provider: result.provider,
        outboundMessageId: result.outboundMessageId,
      },
      'admin.test_send.completed'
    )

    return respond(NextResponse.json({
      success: true,
      delivered: result.delivered,
      provider: result.provider,
      outbound_message_id: result.outboundMessageId ?? null,
      error: result.error ?? null,
    }))
  } catch (err) {
    reqLog.error({ err, userId: user.id, venueId }, 'admin.test_send.failed')
    captureApiError(err, { requestId, route: '/api/admin/test-send', venueId, userId: user.id })
    const message = err instanceof Error ? err.message : 'Test send failed'
    return respond(NextResponse.json({ error: message }, { status: 500 }))
  }
}
