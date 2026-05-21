import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import {
  COMMITMENT_AREAS,
  COMMITMENT_RISK_LEVELS,
  COMMITMENT_SOURCE_TYPES,
  COMMITMENT_STATUSES,
  type CommitmentArea,
  type CommitmentCreateInput,
  type CommitmentEvent,
  type CommitmentEventType,
  type CommitmentListSummary,
  type CommitmentRecord,
  type CommitmentRiskLevel,
  type CommitmentSourceType,
  type CommitmentStatus,
  type CommitmentUpdateInput,
  type CommitmentWithTimeline,
} from '@/lib/enterprise/commitments/types'

/**
 * Phase 9P — Contract commitments helpers.
 *
 * Server-only. Uses the service-role client so timeline writes
 * succeed regardless of RLS write direction. Callers MUST
 * perform RBAC checks first (admin/owner via requireAdmin +
 * requireVenueRole).
 *
 * Honesty:
 *   - Nothing is auto-marked. Every status / risk / fulfilment
 *     transition is an explicit operator action.
 *   - Timeline events are append-only, service-role write.
 *   - Best-effort writes — failures log + Sentry but never
 *     throw.
 */

type RowCommitment = {
  id: string
  venue_id: string | null
  buyer_name: string | null
  buyer_company: string | null
  buyer_email: string | null
  source_type: string
  commitment_area: string
  title: string
  description: string
  status: string
  risk_level: string
  owner_user_id: string | null
  due_at: string | null
  review_at: string | null
  fulfilled_at: string | null
  fulfilled_by: string | null
  evidence_url: string | null
  internal_notes: string | null
  metadata: Record<string, unknown> | null
  created_by: string | null
  created_at: string
  updated_at: string
}

type RowEvent = {
  id: string
  commitment_id: string
  venue_id: string | null
  actor_user_id: string | null
  event_type: string
  note: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

function rowToCommitment(row: RowCommitment): CommitmentRecord {
  return {
    id: row.id,
    venueId: row.venue_id,
    buyerName: row.buyer_name,
    buyerCompany: row.buyer_company,
    buyerEmail: row.buyer_email,
    sourceType: row.source_type as CommitmentSourceType,
    commitmentArea: row.commitment_area as CommitmentArea,
    title: row.title,
    description: row.description,
    status: row.status as CommitmentStatus,
    riskLevel: row.risk_level as CommitmentRiskLevel,
    ownerUserId: row.owner_user_id,
    dueAt: row.due_at,
    reviewAt: row.review_at,
    fulfilledAt: row.fulfilled_at,
    fulfilledBy: row.fulfilled_by,
    evidenceUrl: row.evidence_url,
    internalNotes: row.internal_notes,
    metadata: row.metadata ?? {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToEvent(row: RowEvent): CommitmentEvent {
  return {
    id: row.id,
    commitmentId: row.commitment_id,
    venueId: row.venue_id,
    actorUserId: row.actor_user_id,
    eventType: row.event_type as CommitmentEventType,
    note: row.note,
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

// ── Counts ───────────────────────────────────────────────────────────────

function computeCounts(
  commitments: ReadonlyArray<CommitmentRecord>,
  unsupportedFlagCount: number
): CommitmentListSummary['counts'] {
  const now = Date.now()
  const soon = now + 30 * 24 * 60 * 60 * 1000
  const counts: CommitmentListSummary['counts'] = {
    total: commitments.length,
    draft: 0,
    active: 0,
    fulfilled: 0,
    atRisk: 0,
    expired: 0,
    withdrawn: 0,
    highRisk: 0,
    criticalRisk: 0,
    overdueReview: 0,
    dueWithin30Days: 0,
    unsupportedRiskFlags: unsupportedFlagCount,
  }
  for (const c of commitments) {
    if (c.status === 'draft') counts.draft += 1
    else if (c.status === 'active') counts.active += 1
    else if (c.status === 'fulfilled') counts.fulfilled += 1
    else if (c.status === 'at_risk') counts.atRisk += 1
    else if (c.status === 'expired') counts.expired += 1
    else if (c.status === 'withdrawn') counts.withdrawn += 1
    if (c.riskLevel === 'high') counts.highRisk += 1
    else if (c.riskLevel === 'critical') counts.criticalRisk += 1
    const open =
      c.status !== 'fulfilled' &&
      c.status !== 'expired' &&
      c.status !== 'withdrawn'
    if (open && c.reviewAt && Date.parse(c.reviewAt) < now) {
      counts.overdueReview += 1
    }
    if (open && c.dueAt) {
      const due = Date.parse(c.dueAt)
      if (due >= now && due <= soon) counts.dueWithin30Days += 1
    }
  }
  return counts
}

// ── Create ───────────────────────────────────────────────────────────────

export async function createCommitment(
  input: CommitmentCreateInput
): Promise<
  | { ok: true; commitment: CommitmentRecord }
  | { ok: false; code: string; message: string }
> {
  if (!input.venueId) {
    return { ok: false, code: 'validation_failed', message: 'venueId' }
  }
  if (!validateEnum(input.sourceType, COMMITMENT_SOURCE_TYPES)) {
    return { ok: false, code: 'validation_failed', message: 'sourceType' }
  }
  if (!validateEnum(input.commitmentArea, COMMITMENT_AREAS)) {
    return { ok: false, code: 'validation_failed', message: 'commitmentArea' }
  }
  if (!input.title || input.title.length === 0 || input.title.length > 240) {
    return { ok: false, code: 'validation_failed', message: 'title' }
  }
  if (!input.description || input.description.length === 0) {
    return { ok: false, code: 'validation_failed', message: 'description' }
  }
  const status: CommitmentStatus = input.status ?? 'draft'
  if (!validateEnum(status, COMMITMENT_STATUSES)) {
    return { ok: false, code: 'validation_failed', message: 'status' }
  }
  const riskLevel: CommitmentRiskLevel = input.riskLevel ?? 'medium'
  if (!validateEnum(riskLevel, COMMITMENT_RISK_LEVELS)) {
    return { ok: false, code: 'validation_failed', message: 'riskLevel' }
  }

  const supabase = createServiceClient()
  try {
    const { data, error } = await supabase
      .from('contract_commitments')
      .insert({
        venue_id: input.venueId,
        buyer_name: input.buyerName ?? null,
        buyer_company: input.buyerCompany ?? null,
        buyer_email: input.buyerEmail ?? null,
        source_type: input.sourceType,
        commitment_area: input.commitmentArea,
        title: input.title,
        description: input.description,
        status,
        risk_level: riskLevel,
        owner_user_id: input.ownerUserId ?? null,
        due_at: input.dueAt ?? null,
        review_at: input.reviewAt ?? null,
        evidence_url: input.evidenceUrl ?? null,
        internal_notes: input.internalNotes ?? null,
        metadata: input.metadata ?? {},
        created_by: input.createdBy,
      })
      .select('*')
      .single()
    if (error || !data) {
      log.error(
        { err: error, venueId: input.venueId },
        'commitments.create.insert_failed'
      )
      captureApiError(error ?? new Error('insert_failed'), {
        venueId: input.venueId,
      })
      return {
        ok: false,
        code: 'insert_failed',
        message: error?.message ?? 'unknown',
      }
    }
    const commitment = rowToCommitment(data as RowCommitment)
    void appendCommitmentEvent({
      commitmentId: commitment.id,
      venueId: commitment.venueId,
      actorUserId: input.createdBy,
      eventType: 'created',
      note: `Commitment recorded (${commitment.commitmentArea}, ${commitment.status}, risk=${commitment.riskLevel}).`,
      metadata: {
        source_type: commitment.sourceType,
        commitment_area: commitment.commitmentArea,
        risk_level: commitment.riskLevel,
      },
    })
    return { ok: true, commitment }
  } catch (err) {
    log.error({ err }, 'commitments.create.unexpected')
    captureApiError(err)
    return { ok: false, code: 'unexpected_error', message: 'create_failed' }
  }
}

// ── Update ───────────────────────────────────────────────────────────────

export async function updateCommitment(
  input: CommitmentUpdateInput
): Promise<
  | {
      ok: true
      commitment: CommitmentRecord
      statusChanged: boolean
      riskChanged: boolean
      fulfilledNow: boolean
    }
  | { ok: false; code: string; message: string }
> {
  if (!input.commitmentId) {
    return { ok: false, code: 'validation_failed', message: 'commitmentId' }
  }
  if (input.status && !validateEnum(input.status, COMMITMENT_STATUSES)) {
    return { ok: false, code: 'validation_failed', message: 'status' }
  }
  if (
    input.riskLevel &&
    !validateEnum(input.riskLevel, COMMITMENT_RISK_LEVELS)
  ) {
    return { ok: false, code: 'validation_failed', message: 'riskLevel' }
  }
  if (input.sourceType && !validateEnum(input.sourceType, COMMITMENT_SOURCE_TYPES)) {
    return { ok: false, code: 'validation_failed', message: 'sourceType' }
  }
  if (
    input.commitmentArea &&
    !validateEnum(input.commitmentArea, COMMITMENT_AREAS)
  ) {
    return { ok: false, code: 'validation_failed', message: 'commitmentArea' }
  }

  const supabase = createServiceClient()
  try {
    const { data: before, error: beforeErr } = await supabase
      .from('contract_commitments')
      .select('*')
      .eq('id', input.commitmentId)
      .maybeSingle()
    if (beforeErr || !before) {
      return { ok: false, code: 'not_found', message: 'commitment' }
    }
    const beforeRow = before as RowCommitment

    const patch: Record<string, unknown> = {}
    if (input.buyerName !== undefined) patch.buyer_name = input.buyerName
    if (input.buyerCompany !== undefined) patch.buyer_company = input.buyerCompany
    if (input.buyerEmail !== undefined) patch.buyer_email = input.buyerEmail
    if (input.sourceType !== undefined) patch.source_type = input.sourceType
    if (input.commitmentArea !== undefined) patch.commitment_area = input.commitmentArea
    if (input.title !== undefined) patch.title = input.title
    if (input.description !== undefined) patch.description = input.description
    if (input.status !== undefined) patch.status = input.status
    if (input.riskLevel !== undefined) patch.risk_level = input.riskLevel
    if (input.ownerUserId !== undefined) patch.owner_user_id = input.ownerUserId
    if (input.dueAt !== undefined) patch.due_at = input.dueAt
    if (input.reviewAt !== undefined) patch.review_at = input.reviewAt
    if (input.evidenceUrl !== undefined) patch.evidence_url = input.evidenceUrl
    if (input.internalNotes !== undefined) patch.internal_notes = input.internalNotes
    if (input.metadata !== undefined) patch.metadata = input.metadata

    const now = new Date().toISOString()
    let fulfilledNow = false
    if (input.markFulfilled && beforeRow.status !== 'fulfilled') {
      patch.status = 'fulfilled'
      patch.fulfilled_at = now
      patch.fulfilled_by = input.actorUserId
      fulfilledNow = true
    } else if (input.status === 'fulfilled' && beforeRow.status !== 'fulfilled') {
      patch.fulfilled_at = now
      patch.fulfilled_by = input.actorUserId
      fulfilledNow = true
    }

    if (
      Object.keys(patch).length === 0 &&
      !input.note &&
      !input.markReviewed
    ) {
      return { ok: false, code: 'validation_failed', message: 'no_changes' }
    }

    let updated = beforeRow
    if (Object.keys(patch).length > 0) {
      const { data: afterRow, error: updErr } = await supabase
        .from('contract_commitments')
        .update(patch)
        .eq('id', input.commitmentId)
        .select('*')
        .single()
      if (updErr || !afterRow) {
        log.error(
          { err: updErr, commitmentId: input.commitmentId },
          'commitments.update.failed'
        )
        captureApiError(updErr ?? new Error('update_failed'))
        return {
          ok: false,
          code: 'update_failed',
          message: updErr?.message ?? 'unknown',
        }
      }
      updated = afterRow as RowCommitment
    }

    const commitment = rowToCommitment(updated)
    const statusChanged =
      Boolean(input.status) && input.status !== beforeRow.status
    const riskChanged =
      Boolean(input.riskLevel) && input.riskLevel !== beforeRow.risk_level

    if (statusChanged) {
      void appendCommitmentEvent({
        commitmentId: commitment.id,
        venueId: commitment.venueId,
        actorUserId: input.actorUserId,
        eventType: 'status_changed',
        note: `Status: ${beforeRow.status} → ${commitment.status}`,
        metadata: { from: beforeRow.status, to: commitment.status },
      })
    }
    if (riskChanged) {
      void appendCommitmentEvent({
        commitmentId: commitment.id,
        venueId: commitment.venueId,
        actorUserId: input.actorUserId,
        eventType: 'risk_changed',
        note: `Risk: ${beforeRow.risk_level} → ${commitment.riskLevel}`,
        metadata: { from: beforeRow.risk_level, to: commitment.riskLevel },
      })
    }
    if (fulfilledNow) {
      void appendCommitmentEvent({
        commitmentId: commitment.id,
        venueId: commitment.venueId,
        actorUserId: input.actorUserId,
        eventType: 'fulfilled',
        note: 'Commitment marked fulfilled.',
        metadata: {},
      })
    }
    if (input.markReviewed) {
      void appendCommitmentEvent({
        commitmentId: commitment.id,
        venueId: commitment.venueId,
        actorUserId: input.actorUserId,
        eventType: 'reviewed',
        note: 'Operator review recorded.',
        metadata: {},
      })
    }
    if (input.note) {
      void appendCommitmentEvent({
        commitmentId: commitment.id,
        venueId: commitment.venueId,
        actorUserId: input.actorUserId,
        eventType: 'note_added',
        note: input.note.slice(0, 4000),
        metadata: {},
      })
    }
    // Generic "updated" trail entry when something changed but
    // none of the typed transitions fired (e.g. evidence URL,
    // due_at, owner).
    if (
      !statusChanged &&
      !riskChanged &&
      !fulfilledNow &&
      !input.markReviewed &&
      Object.keys(patch).length > 0
    ) {
      void appendCommitmentEvent({
        commitmentId: commitment.id,
        venueId: commitment.venueId,
        actorUserId: input.actorUserId,
        eventType: 'updated',
        note: null,
        metadata: { fields: Object.keys(patch) },
      })
    }

    return {
      ok: true,
      commitment,
      statusChanged,
      riskChanged,
      fulfilledNow,
    }
  } catch (err) {
    log.error({ err }, 'commitments.update.unexpected')
    captureApiError(err)
    return { ok: false, code: 'unexpected_error', message: 'update_failed' }
  }
}

// ── List ─────────────────────────────────────────────────────────────────

export interface ListCommitmentsFilters {
  venueId: string | null
  status?: CommitmentStatus | null
  riskLevel?: CommitmentRiskLevel | null
  commitmentArea?: CommitmentArea | null
  dueBefore?: string | null
  reviewBefore?: string | null
  occurredBefore?: string | null
  limit?: number
}

export async function listCommitments(
  filters: ListCommitmentsFilters
): Promise<CommitmentListSummary> {
  const warnings: string[] = []
  const supabase = createServiceClient()
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000)
  try {
    let q = supabase
      .from('contract_commitments')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (filters.venueId) q = q.eq('venue_id', filters.venueId)
    if (filters.status) q = q.eq('status', filters.status)
    if (filters.riskLevel) q = q.eq('risk_level', filters.riskLevel)
    if (filters.commitmentArea) q = q.eq('commitment_area', filters.commitmentArea)
    if (filters.dueBefore) q = q.lte('due_at', filters.dueBefore)
    if (filters.reviewBefore) q = q.lte('review_at', filters.reviewBefore)
    if (filters.occurredBefore) q = q.lte('created_at', filters.occurredBefore)
    const { data, error } = await q
    if (error) {
      warnings.push(`list_failed:${error.message}`)
      log.error({ err: error }, 'commitments.list.failed')
      return emptySummary(warnings)
    }
    const commitments = (data ?? []).map((r) =>
      rowToCommitment(r as RowCommitment)
    )
    return {
      generatedAt: new Date().toISOString(),
      counts: computeCounts(commitments, 0),
      commitments,
      warnings,
    }
  } catch (err) {
    log.error({ err }, 'commitments.list.unexpected')
    captureApiError(err)
    return emptySummary(['unexpected_error'])
  }
}

function emptySummary(warnings: string[]): CommitmentListSummary {
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      total: 0,
      draft: 0,
      active: 0,
      fulfilled: 0,
      atRisk: 0,
      expired: 0,
      withdrawn: 0,
      highRisk: 0,
      criticalRisk: 0,
      overdueReview: 0,
      dueWithin30Days: 0,
      unsupportedRiskFlags: 0,
    },
    commitments: [],
    warnings,
  }
}

// ── Get one + timeline ───────────────────────────────────────────────────

export async function getCommitmentWithTimeline(
  commitmentId: string
): Promise<CommitmentWithTimeline> {
  const warnings: string[] = []
  const supabase = createServiceClient()
  try {
    const { data: row, error } = await supabase
      .from('contract_commitments')
      .select('*')
      .eq('id', commitmentId)
      .maybeSingle()
    if (error || !row) {
      return { commitment: null, timeline: [], warnings: ['not_found'] }
    }
    const { data: timeline, error: tErr } = await supabase
      .from('contract_commitment_events')
      .select('*')
      .eq('commitment_id', commitmentId)
      .order('created_at', { ascending: true })
      .limit(500)
    if (tErr) warnings.push(`timeline_failed:${tErr.message}`)
    return {
      commitment: rowToCommitment(row as RowCommitment),
      timeline: ((timeline ?? []) as RowEvent[]).map(rowToEvent),
      warnings,
    }
  } catch (err) {
    log.error({ err }, 'commitments.get.unexpected')
    captureApiError(err)
    return { commitment: null, timeline: [], warnings: ['unexpected_error'] }
  }
}

// ── Timeline append ──────────────────────────────────────────────────────

export interface AppendCommitmentEventArgs {
  commitmentId: string
  venueId: string | null
  actorUserId: string | null
  eventType: CommitmentEventType
  note: string | null
  metadata?: Record<string, unknown>
}

export async function appendCommitmentEvent(
  args: AppendCommitmentEventArgs
): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase.from('contract_commitment_events').insert({
      commitment_id: args.commitmentId,
      venue_id: args.venueId,
      actor_user_id: args.actorUserId,
      event_type: args.eventType,
      note: args.note,
      metadata: args.metadata ?? {},
    })
    if (error) {
      log.warn(
        {
          err: error,
          commitmentId: args.commitmentId,
          eventType: args.eventType,
        },
        'commitment_event.insert_failed'
      )
    }
  } catch (err) {
    log.warn({ err }, 'commitment_event.unexpected')
  }
}
