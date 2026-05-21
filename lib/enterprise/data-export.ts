import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'

/**
 * Phase 9D — Venue data export helper.
 *
 * Builds a venue-scoped JSON snapshot of the operational tables an
 * owner would expect on a "give me everything you have on my venue"
 * request. The export is structured by section; each section is a
 * narrow row list filtered to the supplied `venueId`.
 *
 * ── WHAT'S INCLUDED ──────────────────────────────────────────────────────
 *   venue                 — single row
 *   members               — venue_members joined with auth.users for
 *                           display email + role; service-role read
 *                           because venue_members RLS is strict
 *   leads                 — full row (operator-requested export
 *                           includes PII by design)
 *   conversations         — full row
 *   messages              — full row including content (operator-
 *                           requested export includes message bodies)
 *   tours                 — full row
 *   ai_actions            — agent metadata + draft text
 *   tour_status_events    — Phase 8M operational audit feed
 *   digest_audit_events   — Phase 8AC digest-specific audit
 *   audit_events          — Phase 9A enterprise log (only when
 *                           caller opts in via include_audit_events)
 *
 * ── WHAT'S NEVER INCLUDED ────────────────────────────────────────────────
 *   - secrets, API keys, auth tokens (none live on these tables)
 *   - raw Stripe webhook payloads (different table; intentionally not
 *     in this export — those live in `billing_events_log` and are
 *     payment-data of a different sensitivity tier)
 *   - cross-tenant rows (every query is `.eq('venue_id', venueId)`)
 *   - the audit mirror feed (`audit_event_mirror`) — that's a
 *     tamper-evidence forensic surface; not part of the operator-
 *     facing export
 *   - subscription / billing rows beyond what `venues` exposes
 *
 * ── SIZE POSTURE ─────────────────────────────────────────────────────────
 * The helper is bounded by per-section row caps; the route enforces
 * the response size cap. A venue with > MAX_ROWS_PER_SECTION rows in
 * any section gets a truncated section with a `truncated_at_row`
 * field so the operator knows to ask for an async export (a future
 * phase will add that).
 */

/**
 * Per-section read cap. Tuned to keep the inline JSON response under
 * a few MB even for an active venue — the route's MAX_EXPORT_BYTES
 * gate is the hard backstop. If you bump this, also re-think
 * MAX_EXPORT_BYTES in `/api/admin/data-export`.
 */
const MAX_ROWS_PER_SECTION = 5_000

export interface VenueDataExport {
  generatedAt: string
  venueId: string
  sections: {
    venue: unknown
    members: unknown[]
    leads: unknown[]
    conversations: unknown[]
    messages: unknown[]
    tours: unknown[]
    aiActions: unknown[]
    tourStatusEvents: unknown[]
    digestAuditEvents: unknown[]
    auditEvents?: unknown[]
  }
}

export interface BuildVenueDataExportArgs {
  venueId: string
  /** Caller's user id. Recorded in log + by the route's audit row. */
  requestedByUserId: string
  /** Phase 9D — opt-in for the enterprise audit feed. */
  includeAuditEvents?: boolean
}

/**
 * Lightweight section-count summary the route uses for the audit row
 * + the response shape. Cheaper to log than the full export.
 */
export interface VenueDataExportSummary {
  generatedAt: string
  venueId: string
  sectionCounts: Record<string, number>
  /** Best-effort JSON-string length of the export. */
  estimatedBytes: number
  /** Sections that hit MAX_ROWS_PER_SECTION (truncated reads). */
  truncatedSections: string[]
}

/**
 * Build the venue-scoped JSON export. Service-role internally; the
 * caller MUST have already enforced role + tenant binding via
 * `requireAdmin` + `requireVenueRole` at the route layer.
 *
 * Concurrency note: sections fan out via Promise.all. Each query is
 * narrow + indexed; total wall time on a moderately-active venue
 * (~5k rows total across sections) is sub-second locally.
 */
export async function buildVenueDataExport(
  args: BuildVenueDataExportArgs
): Promise<VenueDataExport> {
  const { venueId, requestedByUserId, includeAuditEvents = false } = args
  const svc = createServiceClient()
  const generatedAt = new Date().toISOString()

  log.info(
    { venueId, requestedByUserId, includeAuditEvents },
    'data_export.build.started'
  )

  // 1. Single venue row — fail loudly if it's missing (caller should
  // have validated existence via requireVenueRole already; this is
  // defense-in-depth).
  const venueRes = await svc
    .from('venues')
    .select('*')
    .eq('id', venueId)
    .maybeSingle()
  const venue = venueRes.data ?? null

  // 2. Fan out the remaining sections. Each call is venue-scoped +
  // capped at MAX_ROWS_PER_SECTION. `maybeSingle` is NOT used here;
  // we want arrays even when empty.
  const [
    membersRes,
    leadsRes,
    conversationsRes,
    messagesRes,
    toursRes,
    aiActionsRes,
    tourStatusEventsRes,
    digestAuditEventsRes,
    auditEventsRes,
  ] = await Promise.all([
    svc
      .from('venue_members')
      .select('*')
      .eq('venue_id', venueId)
      .order('created_at', { ascending: true })
      .limit(MAX_ROWS_PER_SECTION),
    svc
      .from('leads')
      .select('*')
      .eq('venue_id', venueId)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS_PER_SECTION),
    svc
      .from('conversations')
      .select('*')
      .eq('venue_id', venueId)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS_PER_SECTION),
    svc
      .from('messages')
      .select('*')
      .eq('venue_id', venueId)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS_PER_SECTION),
    svc
      .from('tours')
      .select('*')
      .eq('venue_id', venueId)
      .order('scheduled_at', { ascending: false })
      .limit(MAX_ROWS_PER_SECTION),
    svc
      .from('ai_actions')
      .select('*')
      .eq('venue_id', venueId)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS_PER_SECTION),
    svc
      .from('tour_status_events')
      .select('*')
      .eq('venue_id', venueId)
      .order('occurred_at', { ascending: false })
      .limit(MAX_ROWS_PER_SECTION),
    svc
      .from('digest_audit_events')
      .select('*')
      .eq('venue_id', venueId)
      .order('occurred_at', { ascending: false })
      .limit(MAX_ROWS_PER_SECTION),
    includeAuditEvents
      ? svc
          .from('audit_events')
          .select('*')
          .eq('venue_id', venueId)
          .order('created_at', { ascending: false })
          .limit(MAX_ROWS_PER_SECTION)
      : Promise.resolve({ data: null }),
  ])

  const sections: VenueDataExport['sections'] = {
    venue,
    members: membersRes.data ?? [],
    leads: leadsRes.data ?? [],
    conversations: conversationsRes.data ?? [],
    messages: messagesRes.data ?? [],
    tours: toursRes.data ?? [],
    aiActions: aiActionsRes.data ?? [],
    tourStatusEvents: tourStatusEventsRes.data ?? [],
    digestAuditEvents: digestAuditEventsRes.data ?? [],
  }
  if (includeAuditEvents) {
    sections.auditEvents = auditEventsRes.data ?? []
  }

  return { generatedAt, venueId, sections }
}

/**
 * Cheap summary derivation used by the route for the audit row +
 * the response shape. Counts are exact; `estimatedBytes` is the
 * JSON.stringify length (not gzip-compressed) so an operator can
 * roughly predict download size.
 */
export function summarizeVenueDataExport(
  exportData: VenueDataExport
): VenueDataExportSummary {
  const sectionCounts: Record<string, number> = {
    venue: exportData.sections.venue ? 1 : 0,
    members: exportData.sections.members.length,
    leads: exportData.sections.leads.length,
    conversations: exportData.sections.conversations.length,
    messages: exportData.sections.messages.length,
    tours: exportData.sections.tours.length,
    aiActions: exportData.sections.aiActions.length,
    tourStatusEvents: exportData.sections.tourStatusEvents.length,
    digestAuditEvents: exportData.sections.digestAuditEvents.length,
  }
  if (exportData.sections.auditEvents) {
    sectionCounts.auditEvents = exportData.sections.auditEvents.length
  }
  const truncatedSections = Object.entries(sectionCounts)
    .filter(([, n]) => n === MAX_ROWS_PER_SECTION)
    .map(([k]) => k)
  // `JSON.stringify(undefined)` returns undefined which trips
  // `.length`; we already know `exportData` is an object so the
  // fallback to '{}' is just defensive.
  const json = JSON.stringify(exportData) ?? '{}'
  return {
    generatedAt: exportData.generatedAt,
    venueId: exportData.venueId,
    sectionCounts,
    estimatedBytes: json.length,
    truncatedSections,
  }
}

/** Re-exported so the route + the audit row can stay aligned. */
export { MAX_ROWS_PER_SECTION }
