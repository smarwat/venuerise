import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import {
  DSR_RISK_LEVELS,
  DSR_STATUSES,
  DSR_TYPES,
  type DsrCounts,
  type DsrCreateInput,
  type DsrRequest,
  type DsrRiskLevel,
  type DsrStatus,
  type DsrTimelineEvent,
  type DsrTimelineEventType,
  type DsrType,
  type DsrUpdateInput,
} from '@/lib/enterprise/privacy/types'

/**
 * Phase 9M — DSR workflow helpers.
 *
 * All functions are server-only and use the SERVICE-role client.
 * Callers MUST perform their own RBAC check first (admin/owner
 * via requireAdmin + requireVenueRole). The service role is
 * used so timeline events can be appended with an authoritative
 * actor_user_id regardless of RLS direction-of-write rules.
 *
 * Honesty rules carried throughout:
 *   - DSRs are TRACKED, not auto-fulfilled. Every export and
 *     deletion requires operator approval; the timeline carries
 *     the decision trail.
 *   - `legalReviewRequired` defaults to TRUE — opting out is an
 *     operator decision recorded in the audit feed.
 *   - The helper never writes raw subject content to the DB.
 *     `metadata` carries small operator-supplied context only.
 *   - Timeline writes are best-effort. A failed timeline write
 *     never undoes a successful status change.
 */

type RowDsr = {
  id: string
  venue_id: string | null
  request_type: string
  status: string
  risk_level: string
  subject_email: string | null
  subject_name: string | null
  subject_user_id: string | null
  requested_by_email: string | null
  requested_by_user_id: string | null
  identity_verified_at: string | null
  legal_review_required: boolean
  legal_review_notes: string | null
  description: string | null
  scope: string | null
  due_at: string | null
  fulfilled_at: string | null
  denied_at: string | null
  cancelled_at: string | null
  assigned_to: string | null
  created_by: string | null
  closed_by: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

type RowTimeline = {
  id: string
  dsr_request_id: string
  event_type: string
  actor_user_id: string | null
  message: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

function rowToRequest(row: RowDsr): DsrRequest {
  return {
    id: row.id,
    venueId: row.venue_id,
    requestType: row.request_type as DsrType,
    status: row.status as DsrStatus,
    riskLevel: row.risk_level as DsrRiskLevel,
    subjectEmail: row.subject_email,
    subjectName: row.subject_name,
    subjectUserId: row.subject_user_id,
    requestedByEmail: row.requested_by_email,
    requestedByUserId: row.requested_by_user_id,
    identityVerifiedAt: row.identity_verified_at,
    legalReviewRequired: row.legal_review_required,
    legalReviewNotes: row.legal_review_notes,
    description: row.description,
    scope: row.scope,
    dueAt: row.due_at,
    fulfilledAt: row.fulfilled_at,
    deniedAt: row.denied_at,
    cancelledAt: row.cancelled_at,
    assignedTo: row.assigned_to,
    createdBy: row.created_by,
    closedBy: row.closed_by,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToTimeline(row: RowTimeline): DsrTimelineEvent {
  return {
    id: row.id,
    dsrRequestId: row.dsr_request_id,
    eventType: row.event_type as DsrTimelineEventType,
    actorUserId: row.actor_user_id,
    message: row.message,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  }
}

function validateEnum<T extends string>(
  value: string,
  allowed: ReadonlyArray<T>
): value is T {
  return (allowed as ReadonlyArray<string>).includes(value)
}

// ── Create ───────────────────────────────────────────────────────────────

export async function createDsrRequest(
  input: DsrCreateInput
): Promise<
  | { ok: true; dsrRequestId: string; request: DsrRequest }
  | { ok: false; code: string; message: string }
> {
  if (!validateEnum(input.requestType, DSR_TYPES)) {
    return { ok: false, code: 'validation_failed', message: 'request_type' }
  }
  const riskLevel: DsrRiskLevel = input.riskLevel ?? 'medium'
  if (!validateEnum(riskLevel, DSR_RISK_LEVELS)) {
    return { ok: false, code: 'validation_failed', message: 'risk_level' }
  }

  const supabase = createServiceClient()
  try {
    const { data, error } = await supabase
      .from('dsr_requests')
      .insert({
        venue_id: input.venueId,
        request_type: input.requestType,
        status: 'received',
        risk_level: riskLevel,
        subject_email: input.subjectEmail ?? null,
        subject_name: input.subjectName ?? null,
        subject_user_id: input.subjectUserId ?? null,
        requested_by_email: input.requestedByEmail ?? null,
        description: input.description ?? null,
        scope: input.scope ?? null,
        due_at: input.dueAt ?? null,
        legal_review_required: input.legalReviewRequired ?? true,
        metadata: input.metadata ?? {},
        created_by: input.createdBy,
      })
      .select('*')
      .single()
    if (error || !data) {
      log.error(
        { err: error, venueId: input.venueId },
        'dsr.create.insert_failed'
      )
      captureApiError(error ?? new Error('insert_failed'), {
        venueId: input.venueId ?? undefined,
      })
      return {
        ok: false,
        code: 'insert_failed',
        message: error?.message ?? 'unknown',
      }
    }
    const request = rowToRequest(data as RowDsr)
    void appendDsrTimelineEvent({
      dsrRequestId: request.id,
      eventType: 'created',
      actorUserId: input.createdBy,
      message: `DSR opened (${request.requestType}, risk=${request.riskLevel}).`,
      metadata: {
        request_type: request.requestType,
        risk_level: request.riskLevel,
        legal_review_required: request.legalReviewRequired,
      },
    })
    return { ok: true, dsrRequestId: request.id, request }
  } catch (err) {
    log.error({ err }, 'dsr.create.unexpected')
    captureApiError(err)
    return { ok: false, code: 'unexpected_error', message: 'create_failed' }
  }
}

// ── Update ───────────────────────────────────────────────────────────────

export async function updateDsrRequest(
  input: DsrUpdateInput
): Promise<
  | { ok: true; request: DsrRequest; statusChanged: boolean }
  | { ok: false; code: string; message: string }
> {
  if (!input.dsrRequestId) {
    return { ok: false, code: 'validation_failed', message: 'dsrRequestId' }
  }
  if (input.status && !validateEnum(input.status, DSR_STATUSES)) {
    return { ok: false, code: 'validation_failed', message: 'status' }
  }
  if (input.riskLevel && !validateEnum(input.riskLevel, DSR_RISK_LEVELS)) {
    return { ok: false, code: 'validation_failed', message: 'risk_level' }
  }

  const supabase = createServiceClient()
  try {
    const { data: before, error: beforeErr } = await supabase
      .from('dsr_requests')
      .select('*')
      .eq('id', input.dsrRequestId)
      .maybeSingle()
    if (beforeErr || !before) {
      return { ok: false, code: 'not_found', message: 'dsr_request' }
    }
    const beforeRow = before as RowDsr

    const patch: Record<string, unknown> = {}
    if (input.status) patch.status = input.status
    if (input.riskLevel) patch.risk_level = input.riskLevel
    if (input.assignedTo !== undefined) patch.assigned_to = input.assignedTo
    if (input.legalReviewNotes !== undefined) {
      patch.legal_review_notes = input.legalReviewNotes
    }
    if (input.legalReviewRequired !== undefined) {
      patch.legal_review_required = input.legalReviewRequired
    }
    if (input.description !== undefined) patch.description = input.description
    if (input.scope !== undefined) patch.scope = input.scope
    if (input.dueAt !== undefined) patch.due_at = input.dueAt
    if (input.metadata !== undefined) patch.metadata = input.metadata

    const now = new Date().toISOString()
    if (input.markIdentityVerified && !beforeRow.identity_verified_at) {
      patch.identity_verified_at = now
    }
    if (input.status === 'fulfilled' && !beforeRow.fulfilled_at) {
      patch.fulfilled_at = now
      patch.closed_by = input.actorUserId
    }
    if (input.status === 'denied' && !beforeRow.denied_at) {
      patch.denied_at = now
      patch.closed_by = input.actorUserId
    }
    if (input.status === 'cancelled' && !beforeRow.cancelled_at) {
      patch.cancelled_at = now
      patch.closed_by = input.actorUserId
    }

    if (
      Object.keys(patch).length === 0 &&
      !input.note &&
      !input.markIdentityVerified
    ) {
      return { ok: false, code: 'validation_failed', message: 'no_changes' }
    }

    let updated = beforeRow
    if (Object.keys(patch).length > 0) {
      const { data: afterRow, error: updErr } = await supabase
        .from('dsr_requests')
        .update(patch)
        .eq('id', input.dsrRequestId)
        .select('*')
        .single()
      if (updErr || !afterRow) {
        log.error(
          { err: updErr, dsrRequestId: input.dsrRequestId },
          'dsr.update.failed'
        )
        captureApiError(updErr ?? new Error('update_failed'))
        return {
          ok: false,
          code: 'update_failed',
          message: updErr?.message ?? 'unknown',
        }
      }
      updated = afterRow as RowDsr
    }

    const request = rowToRequest(updated)

    if (input.status && input.status !== beforeRow.status) {
      const eventType: DsrTimelineEventType =
        input.status === 'fulfilled'
          ? 'fulfilled'
          : input.status === 'denied'
            ? 'denied'
            : input.status === 'cancelled'
              ? 'cancelled'
              : 'status_changed'
      void appendDsrTimelineEvent({
        dsrRequestId: request.id,
        eventType,
        actorUserId: input.actorUserId,
        message: `Status: ${beforeRow.status} → ${input.status}`,
        metadata: { from: beforeRow.status, to: input.status },
      })
    }
    if (
      input.assignedTo !== undefined &&
      input.assignedTo !== beforeRow.assigned_to
    ) {
      void appendDsrTimelineEvent({
        dsrRequestId: request.id,
        eventType: 'assigned',
        actorUserId: input.actorUserId,
        message: input.assignedTo
          ? `Assigned to ${input.assignedTo}`
          : 'Unassigned',
        metadata: { assignedTo: input.assignedTo },
      })
    }
    if (input.markIdentityVerified && !beforeRow.identity_verified_at) {
      void appendDsrTimelineEvent({
        dsrRequestId: request.id,
        eventType: 'identity_verified',
        actorUserId: input.actorUserId,
        message: 'Identity verified.',
        metadata: {},
      })
    }
    if (input.legalReviewNotes) {
      void appendDsrTimelineEvent({
        dsrRequestId: request.id,
        eventType: 'legal_review_added',
        actorUserId: input.actorUserId,
        message: input.legalReviewNotes.slice(0, 4000),
        metadata: {},
      })
    }
    if (input.note) {
      void appendDsrTimelineEvent({
        dsrRequestId: request.id,
        eventType: 'note_added',
        actorUserId: input.actorUserId,
        message: input.note.slice(0, 4000),
        metadata: {},
      })
    }

    return {
      ok: true,
      request,
      statusChanged:
        Boolean(input.status) && input.status !== beforeRow.status,
    }
  } catch (err) {
    log.error({ err }, 'dsr.update.unexpected')
    captureApiError(err)
    return { ok: false, code: 'unexpected_error', message: 'update_failed' }
  }
}

// ── List ─────────────────────────────────────────────────────────────────

export interface ListDsrFilters {
  venueId?: string | null
  status?: DsrStatus | null
  requestType?: DsrType | null
  riskLevel?: DsrRiskLevel | null
  since?: string | null
  occurredBefore?: string | null
  limit?: number
}

export interface DsrListSummary {
  generatedAt: string
  counts: DsrCounts
  requests: DsrRequest[]
  warnings: string[]
}

export async function listDsrRequests(
  filters: ListDsrFilters
): Promise<DsrListSummary> {
  const warnings: string[] = []
  const supabase = createServiceClient()
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500)
  try {
    let q = supabase
      .from('dsr_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (filters.venueId !== undefined && filters.venueId !== null) {
      q = q.eq('venue_id', filters.venueId)
    }
    if (filters.status) q = q.eq('status', filters.status)
    if (filters.requestType) q = q.eq('request_type', filters.requestType)
    if (filters.riskLevel) q = q.eq('risk_level', filters.riskLevel)
    if (filters.since) q = q.gte('created_at', filters.since)
    if (filters.occurredBefore) q = q.lte('created_at', filters.occurredBefore)
    const { data, error } = await q
    if (error) {
      warnings.push(`list_failed:${error.message}`)
      log.error({ err: error }, 'dsr.list.failed')
      return emptyListSummary(warnings)
    }
    const requests = (data ?? []).map((r) => rowToRequest(r as RowDsr))
    const counts = await computeDsrCounts(filters.venueId ?? null)
    return {
      generatedAt: new Date().toISOString(),
      counts,
      requests,
      warnings,
    }
  } catch (err) {
    log.error({ err }, 'dsr.list.unexpected')
    captureApiError(err)
    warnings.push('unexpected_error')
    return emptyListSummary(warnings)
  }
}

function emptyListSummary(warnings: string[]): DsrListSummary {
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      total: 0,
      open: 0,
      awaitingLegalReview: 0,
      fulfilled: 0,
      denied: 0,
      cancelled: 0,
      overdue: 0,
    },
    requests: [],
    warnings,
  }
}

export async function computeDsrCounts(
  venueId: string | null
): Promise<DsrCounts> {
  const supabase = createServiceClient()
  const counts: DsrCounts = {
    total: 0,
    open: 0,
    awaitingLegalReview: 0,
    fulfilled: 0,
    denied: 0,
    cancelled: 0,
    overdue: 0,
  }
  try {
    let q = supabase
      .from('dsr_requests')
      .select('status,due_at,fulfilled_at,denied_at,cancelled_at')
      .limit(2000)
    if (venueId) q = q.eq('venue_id', venueId)
    const { data, error } = await q
    if (error || !data) return counts
    const now = Date.now()
    for (const row of data as Array<{
      status: string
      due_at: string | null
      fulfilled_at: string | null
      denied_at: string | null
      cancelled_at: string | null
    }>) {
      counts.total += 1
      const closed =
        row.status === 'fulfilled' ||
        row.status === 'denied' ||
        row.status === 'cancelled'
      if (!closed) counts.open += 1
      if (row.status === 'awaiting_legal_review') counts.awaitingLegalReview += 1
      if (row.status === 'fulfilled') counts.fulfilled += 1
      if (row.status === 'denied') counts.denied += 1
      if (row.status === 'cancelled') counts.cancelled += 1
      if (!closed && row.due_at && Date.parse(row.due_at) < now) {
        counts.overdue += 1
      }
    }
  } catch (err) {
    log.warn({ err }, 'dsr.counts.failed')
  }
  return counts
}

// ── Get one + timeline ───────────────────────────────────────────────────

export async function getDsrRequestWithTimeline(
  dsrRequestId: string
): Promise<{
  request: DsrRequest | null
  timeline: DsrTimelineEvent[]
  warnings: string[]
}> {
  const warnings: string[] = []
  const supabase = createServiceClient()
  try {
    const { data: row, error } = await supabase
      .from('dsr_requests')
      .select('*')
      .eq('id', dsrRequestId)
      .maybeSingle()
    if (error || !row) {
      return { request: null, timeline: [], warnings: ['not_found'] }
    }
    const { data: timeline, error: tErr } = await supabase
      .from('dsr_timeline_events')
      .select('*')
      .eq('dsr_request_id', dsrRequestId)
      .order('created_at', { ascending: true })
      .limit(500)
    if (tErr) warnings.push(`timeline_failed:${tErr.message}`)
    return {
      request: rowToRequest(row as RowDsr),
      timeline: ((timeline ?? []) as RowTimeline[]).map(rowToTimeline),
      warnings,
    }
  } catch (err) {
    log.error({ err }, 'dsr.get.unexpected')
    captureApiError(err)
    return { request: null, timeline: [], warnings: ['unexpected_error'] }
  }
}

// ── Timeline append ──────────────────────────────────────────────────────

export interface AppendDsrTimelineArgs {
  dsrRequestId: string
  eventType: DsrTimelineEventType
  actorUserId: string | null
  message: string | null
  metadata?: Record<string, unknown>
}

export async function appendDsrTimelineEvent(
  args: AppendDsrTimelineArgs
): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase.from('dsr_timeline_events').insert({
      dsr_request_id: args.dsrRequestId,
      event_type: args.eventType,
      actor_user_id: args.actorUserId,
      message: args.message,
      metadata: args.metadata ?? {},
    })
    if (error) {
      log.warn(
        {
          err: error,
          dsrRequestId: args.dsrRequestId,
          eventType: args.eventType,
        },
        'dsr_timeline.append_failed'
      )
    }
  } catch (err) {
    log.warn({ err }, 'dsr_timeline.unexpected')
  }
}
