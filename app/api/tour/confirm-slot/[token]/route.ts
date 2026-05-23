import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  validateTourSlotConfirmationToken,
  markTourSlotConfirmationTokenUsed,
  TourSlotConfirmationTokenError,
  redactSlotConfirmationToken,
  type TourSlotConfirmationTokenErrorCode,
} from '@/lib/revenue-os/tour-slot-confirmation-token'
import { checkTourSlotStillAvailable } from '@/lib/revenue-os/tour-slot-availability-check'
import {
  rateLimitUserAction,
  extractIp,
  rateLimitedResponse,
} from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { recordTourStatusEvent } from '@/lib/integrations/tour-status-events'
import {
  readSourceIp,
  maskIp,
} from '@/lib/integrations/tour-action-token'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import { RATE_LIMIT_DOMAINS } from '@/lib/rate-limit-catalog'

/**
 * Phase 8BL — POST /api/tour/confirm-slot/[token]
 *
 * Public, anonymous endpoint. The lead's browser POSTs here when
 * they click "Confirm this time" on the page rendered at
 * /tour/confirm-slot/[token]. We:
 *
 *   1. Rate-limit per IP.
 *   2. Validate the token (HMAC + DB row + status + expiry +
 *      field coherence).
 *   3. Re-check that the slot is still available at click time
 *      (blackouts, conflicts, availability-window membership).
 *   4. Atomically flip the token to `used` — this is the
 *      single-use claim. If we lose the race (concurrent click)
 *      we short-circuit to 409 already_used.
 *   5. Create the `tours` row (status='scheduled', source tagged
 *      with metadata.source = 'lead_confirmation_link').
 *   6. Write a system message in the conversation so the
 *      operator sees what happened in the inbox thread.
 *   7. Record `tour_status_events` + `audit_events` rows for
 *      the unified activity feed.
 *   8. Return JSON `{ success: true, tour_id }`.
 *
 * Idempotency: built into step 4 — the second concurrent click
 * loses the status-active claim and gets `already_used`. The
 * first click is the only one that creates a tour.
 *
 * Honesty contract: this route NEVER sends an external message
 * autonomously. The lead's confirmation triggers a tour row +
 * a system message visible to the operator; outbound channels
 * are still operator-approved.
 */

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ token: string }>
}

type FailureKind =
  | 'expired'
  | 'already_used'
  | 'revoked'
  | 'not_found'
  | 'invalid_link'
  | 'slot_unavailable'
  | 'server_error'

function mapTokenErrorToFailure(
  code: TourSlotConfirmationTokenErrorCode
): { kind: FailureKind; status: number } {
  switch (code) {
    case 'expired':
      return { kind: 'expired', status: 410 }
    case 'already_used':
      return { kind: 'already_used', status: 409 }
    case 'revoked':
      return { kind: 'revoked', status: 410 }
    case 'not_found':
      return { kind: 'not_found', status: 404 }
    case 'malformed_token':
    case 'invalid_signature':
    case 'invalid_payload':
    case 'slot_mismatch':
    case 'lead_mismatch':
      return { kind: 'invalid_link', status: 400 }
    case 'secret_missing':
      return { kind: 'server_error', status: 500 }
  }
}

function failureMessage(kind: FailureKind): string {
  switch (kind) {
    case 'expired':
      return 'This confirmation link has expired. Please reply to the original message for a fresh time.'
    case 'already_used':
      return "This time slot has already been confirmed. There's nothing more to do from this link."
    case 'revoked':
      return 'This link was replaced by a newer one. Please use the most recent message from the venue.'
    case 'not_found':
      return "We couldn't find that tour time. Reply to the original message and the team will help."
    case 'invalid_link':
      return 'This link is no longer valid. Please use the exact link from your last message.'
    case 'slot_unavailable':
      return 'This time slot is no longer available. Please pick another from the original message.'
    case 'server_error':
      return "We couldn't process this confirmation right now. Please try again in a moment, or reply to the original message."
  }
}

export async function POST(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  const { token } = await params
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    op: 'public.tour.confirm_slot',
    route: '/api/tour/confirm-slot/[token]',
  })
  const redacted = redactSlotConfirmationToken(token)

  const respond = (status: number, body: unknown): Response =>
    withRequestIdHeader(
      NextResponse.json(body, {
        status,
        headers: {
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
        },
      }),
      requestId
    )

  // ── 1. Rate-limit per IP ───────────────────────────────────────────────
  // public route — no authenticated user; key on raw IP.
  const ip = extractIp(request)
  const rl = await rateLimitUserAction(
    request,
    `${RATE_LIMIT_DOMAINS.public.tourConfirmSlot}:${ip}`,
    {
      route: '/api/tour/confirm-slot/[token]',
      method: 'POST',
      venueId: null,
      requestId,
    }
  )
  if (!rl.allowed) {
    reqLog.warn({ ip, retryMs: rl.retryAfterMs }, 'public.tour.confirm_slot.rate_limited')
    return rateLimitedResponse(rl)
  }

  if (!token || typeof token !== 'string' || token.length < 16 || token.length > 4096) {
    return respond(400, {
      success: false,
      error: 'invalid_link',
      message: failureMessage('invalid_link'),
    })
  }

  const supabase = createServiceClient()

  // ── 2. Validate token ──────────────────────────────────────────────────
  let validated: Awaited<
    ReturnType<typeof validateTourSlotConfirmationToken>
  >
  try {
    validated = await validateTourSlotConfirmationToken({ supabase, token })
  } catch (err) {
    if (err instanceof TourSlotConfirmationTokenError) {
      const failure = mapTokenErrorToFailure(err.code)
      if (err.code === 'invalid_signature') {
        // Tamper attempt — escalate to warn + Sentry. Never log
        // the raw token; the redacted form is enough to correlate
        // repeated forgeries from one IP.
        reqLog.warn(
          { ip, token: redacted },
          'public.tour.confirm_slot.invalid_signature'
        )
        captureApiError(new Error('tour_confirm_slot_invalid_signature'), {
          requestId,
          route: '/api/tour/confirm-slot/[token]',
        })
      } else {
        reqLog.info(
          { ip, code: err.code, token: redacted },
          'public.tour.confirm_slot.token_rejected'
        )
      }
      return respond(failure.status, {
        success: false,
        error: failure.kind,
        message: failureMessage(failure.kind),
      })
    }
    // Unknown error → 500. Capture for operator visibility.
    reqLog.error(
      { err, token: redacted },
      'public.tour.confirm_slot.validate_unexpected'
    )
    captureApiError(err, {
      requestId,
      route: '/api/tour/confirm-slot/[token]',
    })
    return respond(500, {
      success: false,
      error: 'server_error',
      message: failureMessage('server_error'),
    })
  }

  // ── 3. Fetch venue metadata (for buffer/duration settings) ─────────────
  const { data: venueRow, error: venueErr } = await supabase
    .from('venues')
    .select('id, metadata, timezone')
    .eq('id', validated.venueId)
    .maybeSingle()
  if (venueErr || !venueRow) {
    reqLog.error(
      { err: venueErr, venueId: validated.venueId },
      'public.tour.confirm_slot.venue_lookup_failed'
    )
    return respond(500, {
      success: false,
      error: 'server_error',
      message: failureMessage('server_error'),
    })
  }
  const venue = venueRow as { id: string; metadata: unknown; timezone: string | null }

  // ── 4. Re-check slot availability ──────────────────────────────────────
  const recheck = await checkTourSlotStillAvailable({
    supabase,
    venueId: validated.venueId,
    venueMetadata: venue.metadata,
    slotStartsAt: validated.slotStartsAt,
    slotEndsAt: validated.slotEndsAt,
    timezone: validated.timezone ?? venue.timezone ?? null,
    requestId,
  })
  if (!recheck.ok) {
    reqLog.info(
      {
        tokenId: validated.tokenId,
        venueId: validated.venueId,
        reason: recheck.reason,
      },
      'public.tour.confirm_slot.slot_unavailable_at_click'
    )
    return respond(409, {
      success: false,
      error: 'slot_unavailable',
      reason: recheck.reason,
      message: failureMessage('slot_unavailable'),
    })
  }

  // ── 5. Single-use claim (flip status: active → used) ───────────────────
  // We do this BEFORE creating the tour so a lost race short-circuits
  // without leaving an orphan tour row. The flip and the tour insert
  // happen in this order:
  //   a) flip — wins the claim (active → used). On lose: 409.
  //   b) insert tour. If this fails, we still have the token in
  //      'used' status, which is acceptable: it's a one-time
  //      hand-off; the operator can manually create a tour from
  //      the conversation thread if needed.
  // The `used_tour_id` is back-filled on the token in step 6 once
  // the tour row exists.
  let flipResult: Awaited<ReturnType<typeof markTourSlotConfirmationTokenUsed>>
  try {
    flipResult = await markTourSlotConfirmationTokenUsed({
      supabase,
      tokenId: validated.tokenId,
      // Intentionally omit tourId on the claim — we don't have
      // the tour row yet. The helper accepts null/undefined and
      // sets status + used_at only; we back-fill used_tour_id
      // after the tour insert succeeds (step 6).
      tourId: null,
    })
  } catch (err) {
    reqLog.error(
      { err, tokenId: validated.tokenId },
      'public.tour.confirm_slot.mark_used_failed'
    )
    captureApiError(err, {
      requestId,
      route: '/api/tour/confirm-slot/[token]',
    })
    return respond(500, {
      success: false,
      error: 'server_error',
      message: failureMessage('server_error'),
    })
  }
  if (!flipResult.flipped) {
    reqLog.info(
      { tokenId: validated.tokenId },
      'public.tour.confirm_slot.race_lost'
    )
    return respond(409, {
      success: false,
      error: 'already_used',
      message: failureMessage('already_used'),
    })
  }

  // ── 6. Create the tour row ────────────────────────────────────────────
  // metadata.source = 'lead_confirmation_link' is the operator-side
  // signal that this row was created by a lead click, not by an
  // operator using the ScheduleTourDrawer. The LeadDetailDrawer +
  // TourAuditDrawer both surface this.
  const durationMinutes = Math.max(
    15,
    Math.round(
      (Date.parse(validated.slotEndsAt) - Date.parse(validated.slotStartsAt)) /
        60_000
    )
  )
  const { data: tourInserted, error: tourInsertErr } = await supabase
    .from('tours')
    .insert({
      venue_id: validated.venueId,
      lead_id: validated.leadId,
      scheduled_at: validated.slotStartsAt,
      duration_minutes: durationMinutes,
      status: 'scheduled',
      metadata: {
        source: 'lead_confirmation_link',
        confirmation_token_id: validated.tokenId,
        slot_label: validated.slotLabel ?? null,
        slot_rationale: validated.slotRationale ?? null,
        offered_by_message_id: validated.offeredByMessageId,
      },
    })
    .select('id')
    .single()

  if (tourInsertErr || !tourInserted) {
    // Token already flipped to `used` — we can't roll that back
    // without re-introducing replay risk. The operator sees the
    // failed-redemption in audit + the next reply to the lead
    // can manually schedule the tour from the drawer.
    reqLog.error(
      { err: tourInsertErr, tokenId: validated.tokenId },
      'public.tour.confirm_slot.tour_insert_failed'
    )
    captureApiError(tourInsertErr, {
      requestId,
      route: '/api/tour/confirm-slot/[token]',
    })
    // Best-effort audit row for the failed redemption.
    void recordAuditEvent({
      venueId: validated.venueId,
      actorKind: 'system',
      route: '/api/tour/confirm-slot/[token]',
      action: AUDIT_ACTIONS.TOUR_CONFIRMED_BY_PUBLIC_LINK,
      targetTable: 'tour_slot_confirmation_tokens',
      targetId: validated.tokenId,
      requestId,
      ip,
      metadata: {
        outcome: 'tour_insert_failed',
        slot_starts_at: validated.slotStartsAt,
        slot_label: validated.slotLabel,
        token_redacted: redacted,
      },
    })
    return respond(500, {
      success: false,
      error: 'server_error',
      message: failureMessage('server_error'),
    })
  }

  const tourId = (tourInserted as { id: string }).id

  // Back-fill the token's `used_tour_id` to point at the real tour.
  // The placeholder we wrote in step 5 above gets corrected here.
  try {
    await supabase
      .from('tour_slot_confirmation_tokens')
      .update({ used_tour_id: tourId })
      .eq('id', validated.tokenId)
  } catch (err) {
    // Best-effort — the tour exists, the audit row will point to
    // both, this is operator-cosmetic.
    reqLog.warn(
      { err, tokenId: validated.tokenId, tourId },
      'public.tour.confirm_slot.token_tour_backfill_failed'
    )
  }

  // ── 7. Write a system message into the conversation ───────────────────
  // metadata.source = 'lead_confirmation_link' lets ConversationThread
  // + LeadDetailDrawer render a distinct chip.
  if (validated.conversationId) {
    try {
      await supabase.from('messages').insert({
        conversation_id: validated.conversationId,
        lead_id: validated.leadId,
        venue_id: validated.venueId,
        role: 'system',
        content: `Lead confirmed tour for ${validated.slotLabel ?? validated.slotStartsAt} via confirmation link.`,
        metadata: {
          source: 'lead_confirmation_link',
          tour_id: tourId,
          token_id: validated.tokenId,
          slot_starts_at: validated.slotStartsAt,
          slot_ends_at: validated.slotEndsAt,
          slot_label: validated.slotLabel,
        },
      })
    } catch (err) {
      reqLog.warn(
        { err, conversationId: validated.conversationId },
        'public.tour.confirm_slot.system_message_failed'
      )
    }
  }

  // ── 8. Record tour_status_events for the unified feed ─────────────────
  const maskedIp = maskIp(readSourceIp(request))
  const userAgent = request.headers.get('user-agent')?.slice(0, 500) ?? null
  await recordTourStatusEvent({
    venueId: validated.venueId,
    tourId,
    leadId: validated.leadId,
    actorKind: 'lead_token',
    actorId: null,
    action: 'confirm',
    previousStatus: null,
    newStatus: 'scheduled',
    sourceIp: maskedIp,
    userAgent,
    metadata: {
      source: 'lead_confirmation_link',
      token_id: validated.tokenId,
      token_redacted: redacted,
      slot_label: validated.slotLabel,
    },
    requestId,
  })

  // ── 9. Audit event ────────────────────────────────────────────────────
  await recordAuditEvent({
    venueId: validated.venueId,
    actorKind: 'system',
    route: '/api/tour/confirm-slot/[token]',
    action: AUDIT_ACTIONS.TOUR_CONFIRMED_BY_PUBLIC_LINK,
    targetTable: 'tours',
    targetId: tourId,
    requestId,
    ip,
    userAgent,
    after: {
      tour_id: tourId,
      lead_id: validated.leadId,
      scheduled_at: validated.slotStartsAt,
      duration_minutes: durationMinutes,
      status: 'scheduled',
      source: 'lead_confirmation_link',
    },
    metadata: {
      token_id: validated.tokenId,
      token_redacted: redacted,
      slot_label: validated.slotLabel,
      slot_starts_at: validated.slotStartsAt,
      slot_ends_at: validated.slotEndsAt,
      conversation_id: validated.conversationId,
      offered_by_message_id: validated.offeredByMessageId,
    },
  })

  reqLog.info(
    {
      tokenId: validated.tokenId,
      tourId,
      venueId: validated.venueId,
      leadId: validated.leadId,
    },
    'public.tour.confirm_slot.completed'
  )

  return respond(200, {
    success: true,
    tour_id: tourId,
  })
}
