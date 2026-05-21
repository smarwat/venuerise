import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAdmin } from '@/lib/auth/require-admin'
import {
  requireVenueRole,
  TenantAccessError,
} from '@/lib/auth/tenant-access'
import { ADMIN_ROLES } from '@/lib/auth/roles'
import { rateLimitUserAction, rateLimitedResponse } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import { recordAuditEvent } from '@/lib/enterprise/audit-events'
import { AUDIT_ACTIONS } from '@/lib/enterprise/audit-actions'
import {
  redactLeadPiiSnapshot,
  buildLeadPiiRedactionPatch,
  buildRedactedEmail,
  dropPiiMetadataKeys,
} from '@/lib/enterprise/pii-redaction'

/**
 * POST /api/admin/leads/[leadId]/redact-pii  (Phase 9D)
 *
 * Soft-redacts a single lead's PII while preserving every related
 * row (conversations, messages, tours, ai_actions, audit_events).
 * The lead row stays — only the PII columns + PII metadata change.
 *
 * Why soft (not hard delete):
 *   - Hard delete would cascade through conversations + messages,
 *     erasing operational history the venue still wants for
 *     funnel analytics.
 *   - Hard delete would erase the very audit_events rows we use to
 *     prove the redaction happened.
 *   - The "right to be forgotten" obligation is to remove PII, not
 *     to remove the existence of the record. Soft redaction meets
 *     that bar while keeping the audit chain intact.
 *
 * Body:
 *   {
 *     "reason": "customer_request" | "duplicate" | "test_data" | "other",
 *     "note": "optional <= 500 chars"
 *   }
 *
 * Response (200 success):
 *   { "success": true, "lead_id": "...", "redacted_at": "..." }
 *
 * The route deliberately does NOT echo the before-snapshot back to
 * the client. The audit row IS the forensic record; the response is
 * just confirmation.
 *
 * ── SECURITY POSTURE ─────────────────────────────────────────────────────
 *   - `requireAdmin`.
 *   - Lead's venue cross-checked via `requireVenueRole(ADMIN_ROLES)`.
 *     Cross-tenant 403 collapses to 404.
 *   - Per-user rate limit: `admin:lead-redact-pii:{userId}`.
 *   - If the lead is already redacted (idempotency), we return 200
 *     with `already_redacted: true` and write a fresh audit row
 *     (the operator clicked again on purpose — record it).
 */

const ReasonSchema = z.enum([
  'customer_request',
  'duplicate',
  'test_data',
  'other',
])

const BodySchema = z.object({
  reason: ReasonSchema,
  note: z.string().max(500).optional(),
})

interface RouteContext {
  params: Promise<{ leadId: string }>
}

export async function POST(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/admin/leads/[leadId]/redact-pii',
    op: 'admin.lead_pii_redact',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  // 1. Validate route param.
  const { leadId } = await params
  if (!z.string().uuid().safeParse(leadId).success) {
    return respond(
      NextResponse.json({ error: 'lead_id must be a UUID' }, { status: 400 })
    )
  }

  // 2. Auth.
  const admin = await requireAdmin()
  if (!admin.ok) {
    return respond(
      NextResponse.json({ error: admin.code }, { status: admin.status })
    )
  }
  const { user } = admin

  // 3. Rate limit.
  const rl = await rateLimitUserAction(
    request,
    `admin:lead-redact-pii:${user.id}`
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    return respond(rateLimitedResponse(rl))
  }

  // 4. Body.
  const body = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const { reason, note } = parsed.data

  // 5. Look up the lead. Service-role because the row may belong to
  // a venue the caller admins through ADMIN_ROLES; the role check
  // below is the auth ground truth.
  const svc = createServiceClient()
  const { data: leadRow, error: lookupErr } = await svc
    .from('leads')
    .select('id, venue_id, name, email, phone, notes, metadata')
    .eq('id', leadId)
    .maybeSingle()
  if (lookupErr) {
    reqLog.error(
      { err: lookupErr, leadId },
      'admin.lead_pii_redact.lookup_failed'
    )
    captureApiError(lookupErr, {
      requestId,
      route: '/api/admin/leads/[leadId]/redact-pii',
      userId: user.id,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }
  if (!leadRow) {
    // Missing row collapses to 404 — same shape as the cross-tenant
    // denial below, so the route can't enumerate lead ids.
    return respond(
      NextResponse.json({ error: 'not_found' }, { status: 404 })
    )
  }
  const lead = leadRow as {
    id: string
    venue_id: string
    name: string
    email: string
    phone: string | null
    notes: string | null
    metadata: Record<string, unknown> | null
  }

  // 6. Cross-tenant role check.
  try {
    await requireVenueRole(user.id, lead.venue_id, ADMIN_ROLES)
  } catch (err) {
    if (err instanceof TenantAccessError) {
      if (err.status === 403) {
        return respond(
          NextResponse.json({ error: 'not_found' }, { status: 404 })
        )
      }
      return respond(
        NextResponse.json({ error: err.code }, { status: err.status })
      )
    }
    throw err
  }

  // 7. Build the redaction. The patch helper returns scalar
  // replacements + the metadata stamp subtree; the route merges the
  // stamps into the existing metadata after `dropPiiMetadataKeys`
  // strips the PII-shaped keys.
  const before = redactLeadPiiSnapshot(lead)
  const patchCore = buildLeadPiiRedactionPatch({
    reason,
    requestedByUserId: user.id,
  })
  const stamps = patchCore.metadata_stamps as Record<string, unknown>
  const cleanedMetadata = dropPiiMetadataKeys(lead.metadata)
  const nextMetadata = {
    ...cleanedMetadata,
    ...stamps,
    // Operator's free-text reason note — capped 500 chars by the
    // Zod schema. Stored ALONGSIDE the structured reason for
    // forensic context (e.g. "verified via support ticket #1234").
    pii_redaction_note: note ?? null,
  }
  const alreadyRedacted = Boolean(
    cleanedMetadata.pii_redacted ||
      (lead.metadata && typeof lead.metadata === 'object' &&
        (lead.metadata as Record<string, unknown>).pii_redacted)
  )

  const redactedAtIso =
    typeof stamps.pii_redacted_at === 'string'
      ? stamps.pii_redacted_at
      : new Date().toISOString()

  // 8. Apply the update. Single round-trip. The synthetic email is
  // built from the lead id so re-redactions on the same row stay
  // stable (and so multiple redactions in a venue can't collide on
  // the email uniqueness constraint if one ever lands).
  const updatePatch = {
    name: patchCore.name,
    email: buildRedactedEmail(lead.id),
    phone: patchCore.phone,
    notes: patchCore.notes,
    metadata: nextMetadata,
  }
  const { error: updateErr } = await svc
    .from('leads')
    .update(updatePatch)
    .eq('id', lead.id)
  if (updateErr) {
    reqLog.error(
      { err: updateErr, leadId, venueId: lead.venue_id },
      'admin.lead_pii_redact.update_failed'
    )
    captureApiError(updateErr, {
      requestId,
      route: '/api/admin/leads/[leadId]/redact-pii',
      userId: user.id,
      venueId: lead.venue_id,
    })
    return respond(
      NextResponse.json({ error: 'unexpected_error' }, { status: 500 })
    )
  }

  reqLog.info(
    {
      leadId,
      venueId: lead.venue_id,
      userId: user.id,
      reason,
      alreadyRedacted,
      hadNote: Boolean(note),
    },
    'admin.lead_pii_redact.completed'
  )

  // 9. Audit row. `before` is the narrow PII snapshot; the helper's
  // sanitizer applies on top (sensitive-key drop + size cap). The
  // `after` is the scalar-only patch — we don't dump the merged
  // metadata to avoid duplicating the stamps (already in the
  // metadata block).
  void recordAuditEvent({
    venueId: lead.venue_id,
    actorUserId: user.id,
    actorKind: 'operator',
    route: '/api/admin/leads/[leadId]/redact-pii',
    action: AUDIT_ACTIONS.LEAD_PII_REDACTED,
    targetTable: 'leads',
    targetId: lead.id,
    requestId,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
    before,
    after: {
      name: updatePatch.name,
      email: updatePatch.email,
      phone: updatePatch.phone,
      notes: updatePatch.notes,
    },
    metadata: {
      reason,
      had_operator_note: Boolean(note),
      already_redacted: alreadyRedacted,
      redacted_at: redactedAtIso,
    },
  })

  return respond(
    NextResponse.json({
      success: true,
      lead_id: lead.id,
      redacted_at: redactedAtIso,
      already_redacted: alreadyRedacted,
    })
  )
}
