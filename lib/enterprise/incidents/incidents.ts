import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { captureApiError } from '@/lib/observability/sentry'
import {
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_SOURCES,
  INCIDENT_STATUSES,
  type IncidentCategory,
  type IncidentCounts,
  type IncidentCreateInput,
  type IncidentRecord,
  type IncidentSeverity,
  type IncidentSource,
  type IncidentStatus,
  type IncidentSummary,
  type IncidentTimelineEvent,
  type IncidentTimelineEventType,
  type IncidentUpdateInput,
} from '@/lib/enterprise/incidents/types'

/**
 * Phase 9L — Incident response helpers.
 *
 * All functions are server-only and use the SERVICE-role client.
 * Callers MUST perform their own RBAC check first (via
 * `requireAdmin` + `requireVenueRole(['owner','admin'])` at the
 * route). The service role is used so timeline events can be
 * appended with an authoritative `actor_user_id` regardless of
 * RLS direction-of-write rules.
 *
 * Operator discipline:
 *   - Creation never blocks the originating request — failures
 *     log + Sentry + return a structured error code; the caller
 *     decides whether to surface the failure.
 *   - Timeline append is best-effort. A failed timeline write
 *     never undoes a successful status change.
 *   - We never auto-resolve. Status moves to `resolved` ONLY
 *     when the operator sets it via PATCH.
 *
 * The audit-trail discipline is enforced at the ROUTE layer
 * (AUDIT_ACTIONS.INCIDENT_*) — this helper only writes the
 * incident + timeline rows.
 */

type RowIncident = {
  id: string
  venue_id: string | null
  title: string
  description: string | null
  severity: string
  status: string
  category: string
  source: string
  detected_at: string
  opened_at: string
  mitigated_at: string | null
  resolved_at: string | null
  assigned_to: string | null
  opened_by: string | null
  resolved_by: string | null
  related_resource_type: string | null
  related_resource_id: string | null
  external_reference: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

type RowTimeline = {
  id: string
  incident_id: string
  event_type: string
  actor_user_id: string | null
  message: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

function rowToIncident(row: RowIncident): IncidentRecord {
  return {
    id: row.id,
    venueId: row.venue_id,
    title: row.title,
    description: row.description,
    severity: row.severity as IncidentSeverity,
    status: row.status as IncidentStatus,
    category: row.category as IncidentCategory,
    source: row.source as IncidentSource,
    detectedAt: row.detected_at,
    openedAt: row.opened_at,
    mitigatedAt: row.mitigated_at,
    resolvedAt: row.resolved_at,
    assignedTo: row.assigned_to,
    openedBy: row.opened_by,
    resolvedBy: row.resolved_by,
    relatedResourceType: row.related_resource_type,
    relatedResourceId: row.related_resource_id,
    externalReference: row.external_reference,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToTimeline(row: RowTimeline): IncidentTimelineEvent {
  return {
    id: row.id,
    incidentId: row.incident_id,
    eventType: row.event_type as IncidentTimelineEventType,
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

export async function createIncident(
  input: IncidentCreateInput
): Promise<
  | { ok: true; incidentId: string; incident: IncidentRecord }
  | { ok: false; code: string; message: string }
> {
  if (!input.title || input.title.length === 0 || input.title.length > 200) {
    return { ok: false, code: 'validation_failed', message: 'title' }
  }
  if (!validateEnum(input.severity, INCIDENT_SEVERITIES)) {
    return { ok: false, code: 'validation_failed', message: 'severity' }
  }
  if (!validateEnum(input.category, INCIDENT_CATEGORIES)) {
    return { ok: false, code: 'validation_failed', message: 'category' }
  }
  const source: IncidentSource = input.source ?? 'manual'
  if (!validateEnum(source, INCIDENT_SOURCES)) {
    return { ok: false, code: 'validation_failed', message: 'source' }
  }

  const supabase = createServiceClient()
  const now = new Date().toISOString()
  const detectedAt = input.detectedAt ?? now

  try {
    const { data, error } = await supabase
      .from('incidents')
      .insert({
        venue_id: input.venueId,
        title: input.title,
        description: input.description ?? null,
        severity: input.severity,
        status: 'open',
        category: input.category,
        source,
        detected_at: detectedAt,
        opened_at: now,
        opened_by: input.openedBy,
        related_resource_type: input.relatedResourceType ?? null,
        related_resource_id: input.relatedResourceId ?? null,
        external_reference: input.externalReference ?? null,
        metadata: input.metadata ?? {},
      })
      .select('*')
      .single()
    if (error || !data) {
      log.error(
        { err: error, venueId: input.venueId },
        'incidents.create.insert_failed'
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
    const incident = rowToIncident(data as RowIncident)

    // Best-effort timeline append. A failure here does NOT roll
    // back the incident insert.
    void appendIncidentTimelineEvent({
      incidentId: incident.id,
      eventType: 'created',
      actorUserId: input.openedBy,
      message: `Incident opened (${input.severity}, ${input.category}, source=${source}).`,
      metadata: { source, severity: input.severity, category: input.category },
    })

    return { ok: true, incidentId: incident.id, incident }
  } catch (err) {
    log.error({ err }, 'incidents.create.unexpected')
    captureApiError(err, { venueId: input.venueId ?? undefined })
    return { ok: false, code: 'unexpected_error', message: 'create_failed' }
  }
}

// ── Update ───────────────────────────────────────────────────────────────

export async function updateIncident(
  input: IncidentUpdateInput
): Promise<
  | { ok: true; incident: IncidentRecord; statusChanged: boolean }
  | { ok: false; code: string; message: string }
> {
  if (!input.incidentId) {
    return { ok: false, code: 'validation_failed', message: 'incidentId' }
  }
  if (input.status && !validateEnum(input.status, INCIDENT_STATUSES)) {
    return { ok: false, code: 'validation_failed', message: 'status' }
  }
  if (input.severity && !validateEnum(input.severity, INCIDENT_SEVERITIES)) {
    return { ok: false, code: 'validation_failed', message: 'severity' }
  }

  const supabase = createServiceClient()

  try {
    const { data: before, error: beforeErr } = await supabase
      .from('incidents')
      .select('*')
      .eq('id', input.incidentId)
      .maybeSingle()
    if (beforeErr || !before) {
      return { ok: false, code: 'not_found', message: 'incident' }
    }
    const beforeRow = before as RowIncident

    const patch: Record<string, unknown> = {}
    if (input.status) patch.status = input.status
    if (input.severity) patch.severity = input.severity
    if (input.assignedTo !== undefined) patch.assigned_to = input.assignedTo
    if (input.description !== undefined) patch.description = input.description
    if (input.metadata !== undefined) patch.metadata = input.metadata

    // Stamp lifecycle timestamps on transitions.
    if (input.status === 'mitigated' && !beforeRow.mitigated_at) {
      patch.mitigated_at = new Date().toISOString()
    }
    if (input.status === 'resolved') {
      patch.resolved_at = new Date().toISOString()
      patch.resolved_by = input.actorUserId
      if (!beforeRow.mitigated_at) {
        patch.mitigated_at = patch.resolved_at
      }
    }

    if (Object.keys(patch).length === 0 && !input.note && !input.postmortem) {
      return { ok: false, code: 'validation_failed', message: 'no_changes' }
    }

    let updated = beforeRow
    if (Object.keys(patch).length > 0) {
      const { data: afterRow, error: updErr } = await supabase
        .from('incidents')
        .update(patch)
        .eq('id', input.incidentId)
        .select('*')
        .single()
      if (updErr || !afterRow) {
        log.error(
          { err: updErr, incidentId: input.incidentId },
          'incidents.update.failed'
        )
        captureApiError(updErr ?? new Error('update_failed'))
        return {
          ok: false,
          code: 'update_failed',
          message: updErr?.message ?? 'unknown',
        }
      }
      updated = afterRow as RowIncident
    }

    const incident = rowToIncident(updated)

    // Best-effort timeline events.
    if (input.status && input.status !== beforeRow.status) {
      void appendIncidentTimelineEvent({
        incidentId: incident.id,
        eventType: 'status_changed',
        actorUserId: input.actorUserId,
        message: `Status: ${beforeRow.status} → ${input.status}`,
        metadata: { from: beforeRow.status, to: input.status },
      })
    }
    if (input.assignedTo !== undefined && input.assignedTo !== beforeRow.assigned_to) {
      void appendIncidentTimelineEvent({
        incidentId: incident.id,
        eventType: 'assigned',
        actorUserId: input.actorUserId,
        message: input.assignedTo
          ? `Assigned to ${input.assignedTo}`
          : 'Unassigned',
        metadata: { assignedTo: input.assignedTo },
      })
    }
    if (input.note) {
      void appendIncidentTimelineEvent({
        incidentId: incident.id,
        eventType: 'note_added',
        actorUserId: input.actorUserId,
        message: input.note.slice(0, 4000),
        metadata: {},
      })
    }
    if (input.postmortem) {
      void appendIncidentTimelineEvent({
        incidentId: incident.id,
        eventType: 'postmortem_added',
        actorUserId: input.actorUserId,
        message: input.postmortem.slice(0, 8000),
        metadata: {},
      })
    }

    return {
      ok: true,
      incident,
      statusChanged:
        Boolean(input.status) && input.status !== beforeRow.status,
    }
  } catch (err) {
    log.error({ err }, 'incidents.update.unexpected')
    captureApiError(err)
    return { ok: false, code: 'unexpected_error', message: 'update_failed' }
  }
}

// ── List ─────────────────────────────────────────────────────────────────

export interface ListIncidentsFilters {
  venueId?: string | null
  status?: IncidentStatus | null
  severity?: IncidentSeverity | null
  category?: IncidentCategory | null
  source?: IncidentSource | null
  since?: string | null
  occurredBefore?: string | null
  limit?: number
}

export async function listIncidents(
  filters: ListIncidentsFilters
): Promise<IncidentSummary> {
  const warnings: string[] = []
  const supabase = createServiceClient()
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500)

  try {
    let q = supabase
      .from('incidents')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (filters.venueId !== undefined && filters.venueId !== null) {
      q = q.eq('venue_id', filters.venueId)
    }
    if (filters.status) q = q.eq('status', filters.status)
    if (filters.severity) q = q.eq('severity', filters.severity)
    if (filters.category) q = q.eq('category', filters.category)
    if (filters.source) q = q.eq('source', filters.source)
    if (filters.since) q = q.gte('created_at', filters.since)
    if (filters.occurredBefore) q = q.lte('created_at', filters.occurredBefore)

    const { data, error } = await q
    if (error) {
      warnings.push(`list_failed:${error.message}`)
      log.error({ err: error }, 'incidents.list.failed')
      return emptySummary(warnings)
    }
    const incidents = (data ?? []).map((r) => rowToIncident(r as RowIncident))
    const counts = await computeCounts(filters.venueId ?? null)
    return {
      generatedAt: new Date().toISOString(),
      counts,
      incidents,
      warnings,
    }
  } catch (err) {
    log.error({ err }, 'incidents.list.unexpected')
    captureApiError(err)
    warnings.push('unexpected_error')
    return emptySummary(warnings)
  }
}

function emptySummary(warnings: string[]): IncidentSummary {
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      total: 0,
      open: 0,
      investigating: 0,
      mitigated: 0,
      resolved: 0,
      falsePositive: 0,
      sev1: 0,
      sev2: 0,
      sev3: 0,
      sev4: 0,
      resolvedLast30d: 0,
    },
    incidents: [],
    warnings,
  }
}

async function computeCounts(
  venueId: string | null
): Promise<IncidentCounts> {
  const supabase = createServiceClient()
  const counts: IncidentCounts = {
    total: 0,
    open: 0,
    investigating: 0,
    mitigated: 0,
    resolved: 0,
    falsePositive: 0,
    sev1: 0,
    sev2: 0,
    sev3: 0,
    sev4: 0,
    resolvedLast30d: 0,
  }
  try {
    let q = supabase
      .from('incidents')
      .select('status,severity,resolved_at')
      .limit(2000)
    if (venueId) q = q.eq('venue_id', venueId)
    const { data, error } = await q
    if (error || !data) return counts
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    for (const row of data as Array<{
      status: string
      severity: string
      resolved_at: string | null
    }>) {
      counts.total += 1
      if (row.status === 'open') counts.open += 1
      else if (row.status === 'investigating') counts.investigating += 1
      else if (row.status === 'mitigated') counts.mitigated += 1
      else if (row.status === 'resolved') counts.resolved += 1
      else if (row.status === 'false_positive') counts.falsePositive += 1
      if (row.severity === 'sev1') counts.sev1 += 1
      else if (row.severity === 'sev2') counts.sev2 += 1
      else if (row.severity === 'sev3') counts.sev3 += 1
      else if (row.severity === 'sev4') counts.sev4 += 1
      if (
        row.status === 'resolved' &&
        row.resolved_at &&
        Date.parse(row.resolved_at) >= cutoff
      ) {
        counts.resolvedLast30d += 1
      }
    }
  } catch (err) {
    log.warn({ err }, 'incidents.counts.failed')
  }
  return counts
}

// ── Get one + timeline ───────────────────────────────────────────────────

export async function getIncidentWithTimeline(
  incidentId: string
): Promise<{
  incident: IncidentRecord | null
  timeline: IncidentTimelineEvent[]
  warnings: string[]
}> {
  const warnings: string[] = []
  const supabase = createServiceClient()
  try {
    const { data: row, error } = await supabase
      .from('incidents')
      .select('*')
      .eq('id', incidentId)
      .maybeSingle()
    if (error || !row) {
      return { incident: null, timeline: [], warnings: ['not_found'] }
    }
    const { data: timeline, error: tErr } = await supabase
      .from('incident_timeline_events')
      .select('*')
      .eq('incident_id', incidentId)
      .order('created_at', { ascending: true })
      .limit(500)
    if (tErr) warnings.push(`timeline_failed:${tErr.message}`)
    return {
      incident: rowToIncident(row as RowIncident),
      timeline: ((timeline ?? []) as RowTimeline[]).map(rowToTimeline),
      warnings,
    }
  } catch (err) {
    log.error({ err }, 'incidents.get.unexpected')
    captureApiError(err)
    return { incident: null, timeline: [], warnings: ['unexpected_error'] }
  }
}

// ── Timeline append ──────────────────────────────────────────────────────

export interface AppendTimelineArgs {
  incidentId: string
  eventType: IncidentTimelineEventType
  actorUserId: string | null
  message: string | null
  metadata?: Record<string, unknown>
}

export async function appendIncidentTimelineEvent(
  args: AppendTimelineArgs
): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase.from('incident_timeline_events').insert({
      incident_id: args.incidentId,
      event_type: args.eventType,
      actor_user_id: args.actorUserId,
      message: args.message,
      metadata: args.metadata ?? {},
    })
    if (error) {
      log.warn(
        { err: error, incidentId: args.incidentId, eventType: args.eventType },
        'incident_timeline.append_failed'
      )
    }
  } catch (err) {
    log.warn({ err }, 'incident_timeline.unexpected')
  }
}
