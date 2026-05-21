import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import {
  COMPLIANCE_REVIEW_AREAS,
  COMPLIANCE_REVIEW_CADENCES,
  type ComplianceEventSource,
  type ComplianceReviewArea,
  type ComplianceReviewCadence,
  type ComplianceReviewCompletionInput,
  type ComplianceReviewEvent,
  type ComplianceReviewStatus,
  type ComplianceReviewUpdateInput,
  type ComplianceReviewWaiverInput,
  type CustomComplianceReviewInput,
} from '@/lib/enterprise/compliance-ops/types'
import {
  COMPLIANCE_REVIEW_POLICY,
  cadenceDays,
} from '@/lib/enterprise/compliance-ops/policy'

/**
 * Phase 9O — Compliance review calendar helpers.
 *
 * Server-only. Uses the service-role client so seeding +
 * completion + waiver writes succeed regardless of RLS
 * direction-of-write rules. Callers MUST perform RBAC checks
 * first (admin/owner via requireAdmin + requireVenueRole).
 *
 * Honesty:
 *   - Seeding only INSERTS missing upcoming events; it never
 *     mutates an existing row.
 *   - Completion + waiver are explicit operator actions; no
 *     auto-completion path exists.
 *   - Best-effort writes: failures log + Sentry but never
 *     throw, so a busy admin card can't be denied by a
 *     transient DB error.
 */

type RowEvent = {
  id: string
  venue_id: string | null
  policy_id: string
  area: string
  title: string
  cadence: string
  status: string
  source: string
  due_at: string
  completed_at: string | null
  completed_by: string | null
  waived_at: string | null
  waived_by: string | null
  waiver_reason: string | null
  review_notes: string | null
  evidence_url: string | null
  metadata: Record<string, unknown> | null
  created_by: string | null
  created_at: string
  updated_at: string
}

function rowToEvent(row: RowEvent): ComplianceReviewEvent {
  return {
    id: row.id,
    venueId: row.venue_id,
    policyId: row.policy_id,
    area: row.area as ComplianceReviewArea,
    title: row.title,
    cadence: row.cadence as ComplianceReviewCadence,
    status: row.status as ComplianceReviewStatus,
    source: row.source as ComplianceEventSource,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    waivedAt: row.waived_at,
    waivedBy: row.waived_by,
    waiverReason: row.waiver_reason,
    reviewNotes: row.review_notes,
    evidenceUrl: row.evidence_url,
    metadata: row.metadata ?? {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function validateEnum<T extends string>(
  value: string,
  allowed: ReadonlyArray<T>
): value is T {
  return (allowed as ReadonlyArray<string>).includes(value)
}

// ── Next-due math ────────────────────────────────────────────────────────

export function calculateNextDueAt(
  cadence: ComplianceReviewCadence,
  fromDate: Date = new Date()
): Date {
  const days = cadenceDays(cadence)
  return new Date(fromDate.getTime() + days * 24 * 60 * 60 * 1000)
}

// ── Seed ─────────────────────────────────────────────────────────────────

export interface SeedResult {
  ok: boolean
  inserted: number
  skipped: number
  warnings: string[]
}

/**
 * Seed missing upcoming events for a venue. For each policy
 * item, looks for an active (upcoming/due/overdue) event and
 * inserts a fresh one only when none exists.
 *
 * Idempotent — re-seeding when every policy item already has
 * an active event returns `inserted: 0`.
 */
export async function seedComplianceEventsForVenue(
  venueId: string,
  createdBy: string | null
): Promise<SeedResult> {
  const warnings: string[] = []
  if (!venueId) {
    return { ok: false, inserted: 0, skipped: 0, warnings: ['venue_required'] }
  }
  const supabase = createServiceClient()
  try {
    // Load existing active events for the venue keyed by policy.
    const { data: existing, error: exErr } = await supabase
      .from('compliance_review_events')
      .select('policy_id, status')
      .eq('venue_id', venueId)
      .in('status', ['upcoming', 'due', 'overdue'])
      .limit(1000)
    if (exErr) {
      log.error({ err: exErr, venueId }, 'compliance.seed.load_failed')
      captureApiError(exErr, { venueId })
      return {
        ok: false,
        inserted: 0,
        skipped: 0,
        warnings: [`load_failed:${exErr.message}`],
      }
    }
    const activePolicyIds = new Set(
      (existing ?? []).map((r) => (r as { policy_id: string }).policy_id)
    )
    const now = new Date()
    let inserted = 0
    let skipped = 0
    for (const item of COMPLIANCE_REVIEW_POLICY) {
      if (activePolicyIds.has(item.id)) {
        skipped += 1
        continue
      }
      const dueAt = calculateNextDueAt(item.cadence, now).toISOString()
      const { error: insErr } = await supabase
        .from('compliance_review_events')
        .insert({
          venue_id: venueId,
          policy_id: item.id,
          area: item.area,
          title: item.title,
          cadence: item.cadence,
          status: 'upcoming',
          source: 'system_seeded',
          due_at: dueAt,
          created_by: createdBy,
          metadata: {
            recommended_action: item.recommendedAction,
            owner_role: item.ownerRole,
          },
        })
      if (insErr) {
        // The partial unique index on (venue, policy, due_at)
        // can race; we treat that as a benign "already there"
        // outcome.
        if ((insErr.code ?? '').toString() === '23505') {
          skipped += 1
        } else {
          warnings.push(`insert_failed:${item.id}:${insErr.message}`)
          log.warn(
            { err: insErr, policyId: item.id, venueId },
            'compliance.seed.insert_failed'
          )
        }
        continue
      }
      inserted += 1
    }
    return { ok: true, inserted, skipped, warnings }
  } catch (err) {
    log.error({ err, venueId }, 'compliance.seed.unexpected')
    captureApiError(err, { venueId })
    return {
      ok: false,
      inserted: 0,
      skipped: 0,
      warnings: ['unexpected_error'],
    }
  }
}

// ── Custom review ────────────────────────────────────────────────────────

export async function createCustomComplianceReview(
  input: CustomComplianceReviewInput
): Promise<
  | { ok: true; event: ComplianceReviewEvent }
  | { ok: false; code: string; message: string }
> {
  if (!input.venueId) {
    return { ok: false, code: 'validation_failed', message: 'venueId' }
  }
  if (!validateEnum(input.area, COMPLIANCE_REVIEW_AREAS)) {
    return { ok: false, code: 'validation_failed', message: 'area' }
  }
  if (!validateEnum(input.cadence, COMPLIANCE_REVIEW_CADENCES)) {
    return { ok: false, code: 'validation_failed', message: 'cadence' }
  }
  if (!input.title || input.title.length === 0 || input.title.length > 200) {
    return { ok: false, code: 'validation_failed', message: 'title' }
  }
  if (!input.dueAt || Number.isNaN(Date.parse(input.dueAt))) {
    return { ok: false, code: 'validation_failed', message: 'due_at' }
  }
  const supabase = createServiceClient()
  try {
    // Operator-created events use a `custom:` prefix so the
    // freshness evaluator can identify them.
    const policyId = `custom:${input.area}:${Date.now()}`
    const { data, error } = await supabase
      .from('compliance_review_events')
      .insert({
        venue_id: input.venueId,
        policy_id: policyId,
        area: input.area,
        title: input.title,
        cadence: input.cadence,
        status: 'upcoming',
        source: 'operator_created',
        due_at: input.dueAt,
        review_notes: input.reviewNotes ?? null,
        metadata: input.metadata ?? {},
        created_by: input.createdBy,
      })
      .select('*')
      .single()
    if (error || !data) {
      log.error(
        { err: error, venueId: input.venueId },
        'compliance.custom.insert_failed'
      )
      captureApiError(error ?? new Error('insert_failed'))
      return {
        ok: false,
        code: 'insert_failed',
        message: error?.message ?? 'unknown',
      }
    }
    return { ok: true, event: rowToEvent(data as RowEvent) }
  } catch (err) {
    log.error({ err }, 'compliance.custom.unexpected')
    captureApiError(err)
    return { ok: false, code: 'unexpected_error', message: 'create_failed' }
  }
}

// ── Complete / waive / update ────────────────────────────────────────────

export async function markComplianceReviewCompleted(
  input: ComplianceReviewCompletionInput
): Promise<
  | { ok: true; event: ComplianceReviewEvent }
  | { ok: false; code: string; message: string }
> {
  if (!input.eventId) {
    return { ok: false, code: 'validation_failed', message: 'eventId' }
  }
  const supabase = createServiceClient()
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('compliance_review_events')
      .update({
        status: 'completed',
        completed_at: now,
        completed_by: input.actorUserId,
        review_notes:
          input.reviewNotes !== undefined ? input.reviewNotes : undefined,
        evidence_url:
          input.evidenceUrl !== undefined ? input.evidenceUrl : undefined,
        metadata: input.metadata !== undefined ? input.metadata : undefined,
      })
      .eq('id', input.eventId)
      .select('*')
      .single()
    if (error || !data) {
      log.error(
        { err: error, eventId: input.eventId },
        'compliance.complete.failed'
      )
      captureApiError(error ?? new Error('update_failed'))
      return {
        ok: false,
        code: 'update_failed',
        message: error?.message ?? 'unknown',
      }
    }
    return { ok: true, event: rowToEvent(data as RowEvent) }
  } catch (err) {
    log.error({ err }, 'compliance.complete.unexpected')
    captureApiError(err)
    return { ok: false, code: 'unexpected_error', message: 'complete_failed' }
  }
}

export async function waiveComplianceReview(
  input: ComplianceReviewWaiverInput
): Promise<
  | { ok: true; event: ComplianceReviewEvent }
  | { ok: false; code: string; message: string }
> {
  if (!input.eventId) {
    return { ok: false, code: 'validation_failed', message: 'eventId' }
  }
  if (!input.waiverReason || input.waiverReason.length === 0) {
    return { ok: false, code: 'validation_failed', message: 'waiverReason' }
  }
  const supabase = createServiceClient()
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('compliance_review_events')
      .update({
        status: 'waived',
        waived_at: now,
        waived_by: input.actorUserId,
        waiver_reason: input.waiverReason.slice(0, 4000),
        metadata: input.metadata !== undefined ? input.metadata : undefined,
      })
      .eq('id', input.eventId)
      .select('*')
      .single()
    if (error || !data) {
      log.error(
        { err: error, eventId: input.eventId },
        'compliance.waive.failed'
      )
      captureApiError(error ?? new Error('update_failed'))
      return {
        ok: false,
        code: 'update_failed',
        message: error?.message ?? 'unknown',
      }
    }
    return { ok: true, event: rowToEvent(data as RowEvent) }
  } catch (err) {
    log.error({ err }, 'compliance.waive.unexpected')
    captureApiError(err)
    return { ok: false, code: 'unexpected_error', message: 'waive_failed' }
  }
}

export async function updateComplianceReview(
  input: ComplianceReviewUpdateInput
): Promise<
  | { ok: true; event: ComplianceReviewEvent }
  | { ok: false; code: string; message: string }
> {
  if (!input.eventId) {
    return { ok: false, code: 'validation_failed', message: 'eventId' }
  }
  const patch: Record<string, unknown> = {}
  if (input.reviewNotes !== undefined) patch.review_notes = input.reviewNotes
  if (input.evidenceUrl !== undefined) patch.evidence_url = input.evidenceUrl
  if (input.metadata !== undefined) patch.metadata = input.metadata
  if (Object.keys(patch).length === 0) {
    return { ok: false, code: 'validation_failed', message: 'no_changes' }
  }
  const supabase = createServiceClient()
  try {
    const { data, error } = await supabase
      .from('compliance_review_events')
      .update(patch)
      .eq('id', input.eventId)
      .select('*')
      .single()
    if (error || !data) {
      log.error(
        { err: error, eventId: input.eventId },
        'compliance.update.failed'
      )
      captureApiError(error ?? new Error('update_failed'))
      return {
        ok: false,
        code: 'update_failed',
        message: error?.message ?? 'unknown',
      }
    }
    return { ok: true, event: rowToEvent(data as RowEvent) }
  } catch (err) {
    log.error({ err }, 'compliance.update.unexpected')
    captureApiError(err)
    return { ok: false, code: 'unexpected_error', message: 'update_failed' }
  }
}

// ── List ─────────────────────────────────────────────────────────────────

export interface ListEventFilters {
  venueId: string | null
  status?: ComplianceReviewStatus | null
  area?: ComplianceReviewArea | null
  since?: string | null
  dueBefore?: string | null
  limit?: number
}

export interface ComplianceListSummary {
  generatedAt: string
  counts: {
    total: number
    upcoming: number
    due: number
    overdue: number
    completedLast30d: number
    waived: number
  }
  events: ComplianceReviewEvent[]
  warnings: string[]
}

function computeListCounts(
  events: ReadonlyArray<ComplianceReviewEvent>
): ComplianceListSummary['counts'] {
  const now = Date.now()
  const cutoff = now - 30 * 24 * 60 * 60 * 1000
  const counts = {
    total: events.length,
    upcoming: 0,
    due: 0,
    overdue: 0,
    completedLast30d: 0,
    waived: 0,
  }
  for (const e of events) {
    // Reflect "due" / "overdue" derived from due_at even when
    // the DB row still says "upcoming" — that gives the admin
    // card a more useful real-time stat without a background
    // sweeper.
    if (e.status === 'waived') {
      counts.waived += 1
      continue
    }
    if (e.status === 'completed') {
      if (e.completedAt && Date.parse(e.completedAt) >= cutoff) {
        counts.completedLast30d += 1
      }
      continue
    }
    const dueMs = Date.parse(e.dueAt)
    const overdueWindow = 24 * 60 * 60 * 1000
    if (dueMs <= now - overdueWindow) {
      counts.overdue += 1
    } else if (dueMs <= now) {
      counts.due += 1
    } else {
      counts.upcoming += 1
    }
  }
  return counts
}

export async function listComplianceEvents(
  filters: ListEventFilters
): Promise<ComplianceListSummary> {
  const warnings: string[] = []
  const supabase = createServiceClient()
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000)
  try {
    let q = supabase
      .from('compliance_review_events')
      .select('*')
      .order('due_at', { ascending: true })
      .limit(limit)
    if (filters.venueId) q = q.eq('venue_id', filters.venueId)
    if (filters.status) q = q.eq('status', filters.status)
    if (filters.area) q = q.eq('area', filters.area)
    if (filters.since) q = q.gte('created_at', filters.since)
    if (filters.dueBefore) q = q.lte('due_at', filters.dueBefore)
    const { data, error } = await q
    if (error) {
      warnings.push(`list_failed:${error.message}`)
      log.error({ err: error }, 'compliance.list.failed')
      return {
        generatedAt: new Date().toISOString(),
        counts: {
          total: 0,
          upcoming: 0,
          due: 0,
          overdue: 0,
          completedLast30d: 0,
          waived: 0,
        },
        events: [],
        warnings,
      }
    }
    const events = (data ?? []).map((r) => rowToEvent(r as RowEvent))
    return {
      generatedAt: new Date().toISOString(),
      counts: computeListCounts(events),
      events,
      warnings,
    }
  } catch (err) {
    log.error({ err }, 'compliance.list.unexpected')
    captureApiError(err)
    return {
      generatedAt: new Date().toISOString(),
      counts: {
        total: 0,
        upcoming: 0,
        due: 0,
        overdue: 0,
        completedLast30d: 0,
        waived: 0,
      },
      events: [],
      warnings: ['unexpected_error'],
    }
  }
}

export async function getComplianceEvent(
  eventId: string
): Promise<ComplianceReviewEvent | null> {
  const supabase = createServiceClient()
  try {
    const { data, error } = await supabase
      .from('compliance_review_events')
      .select('*')
      .eq('id', eventId)
      .maybeSingle()
    if (error || !data) return null
    return rowToEvent(data as RowEvent)
  } catch (err) {
    log.warn({ err }, 'compliance.get.unexpected')
    return null
  }
}
