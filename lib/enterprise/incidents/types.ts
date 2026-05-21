/**
 * Phase 9L — Incident response types.
 *
 * Shape for the operator-facing incident record + timeline +
 * alert delivery state. Mirrors the patterns established by
 * Phase 9I (evidence), 9J (sales readiness), and 9K (vendor
 * risk):
 *
 *   - Stable string literal unions for status / severity /
 *     source / category so the values match the DB CHECK
 *     constraints + the static checker scripts.
 *   - Best-effort writers — incident creation never blocks the
 *     originating request; alert routing degrades to "skipped"
 *     when env vars are absent.
 *   - We never claim 24/7 monitoring. Detectors are
 *     conservative + operator-triggered. No autonomous
 *     remediation, no auto-resolve.
 *
 * Read `docs/INCIDENT-RESPONSE.md` for the full operator
 * runbook + severity matrix + post-incident review template.
 */

export type IncidentSeverity = 'sev1' | 'sev2' | 'sev3' | 'sev4'

export type IncidentStatus =
  | 'open'
  | 'investigating'
  | 'mitigated'
  | 'resolved'
  | 'false_positive'

export type IncidentSource =
  | 'manual'
  | 'abuse_events'
  | 'audit_events'
  | 'sso_login_events'
  | 'backup_posture'
  | 'csp_reports'
  | 'vendor_risk'
  | 'health_check'
  | 'other'

export type IncidentCategory =
  | 'security'
  | 'availability'
  | 'data_integrity'
  | 'access_control'
  | 'billing'
  | 'vendor'
  | 'privacy'
  | 'operational'

export const INCIDENT_SEVERITIES: ReadonlyArray<IncidentSeverity> = [
  'sev1',
  'sev2',
  'sev3',
  'sev4',
]
export const INCIDENT_STATUSES: ReadonlyArray<IncidentStatus> = [
  'open',
  'investigating',
  'mitigated',
  'resolved',
  'false_positive',
]
export const INCIDENT_SOURCES: ReadonlyArray<IncidentSource> = [
  'manual',
  'abuse_events',
  'audit_events',
  'sso_login_events',
  'backup_posture',
  'csp_reports',
  'vendor_risk',
  'health_check',
  'other',
]
export const INCIDENT_CATEGORIES: ReadonlyArray<IncidentCategory> = [
  'security',
  'availability',
  'data_integrity',
  'access_control',
  'billing',
  'vendor',
  'privacy',
  'operational',
]

// ── Record + timeline ────────────────────────────────────────────────────

export interface IncidentRecord {
  id: string
  venueId: string | null
  title: string
  description: string | null
  severity: IncidentSeverity
  status: IncidentStatus
  category: IncidentCategory
  source: IncidentSource
  detectedAt: string
  openedAt: string
  mitigatedAt: string | null
  resolvedAt: string | null
  assignedTo: string | null
  openedBy: string | null
  resolvedBy: string | null
  relatedResourceType: string | null
  relatedResourceId: string | null
  externalReference: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type IncidentTimelineEventType =
  | 'created'
  | 'status_changed'
  | 'assigned'
  | 'note_added'
  | 'alert_sent'
  | 'alert_failed'
  | 'evidence_attached'
  | 'postmortem_added'

export interface IncidentTimelineEvent {
  id: string
  incidentId: string
  eventType: IncidentTimelineEventType
  actorUserId: string | null
  message: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

// ── Inputs ───────────────────────────────────────────────────────────────

export interface IncidentCreateInput {
  venueId: string | null
  title: string
  description?: string | null
  severity: IncidentSeverity
  category: IncidentCategory
  source?: IncidentSource
  detectedAt?: string | null
  relatedResourceType?: string | null
  relatedResourceId?: string | null
  externalReference?: string | null
  metadata?: Record<string, unknown> | null
  /** Who is opening the incident. Required for audit lineage. */
  openedBy: string | null
}

export interface IncidentUpdateInput {
  incidentId: string
  status?: IncidentStatus
  severity?: IncidentSeverity
  assignedTo?: string | null
  description?: string | null
  metadata?: Record<string, unknown> | null
  /** Free-form note appended as a timeline event. */
  note?: string | null
  /** Post-incident review markdown blob. Appended as a timeline event. */
  postmortem?: string | null
  /** Actor performing the update. */
  actorUserId: string | null
}

// ── Summary roll-up ──────────────────────────────────────────────────────

export interface IncidentCounts {
  total: number
  open: number
  investigating: number
  mitigated: number
  resolved: number
  falsePositive: number
  sev1: number
  sev2: number
  sev3: number
  sev4: number
  resolvedLast30d: number
}

export interface IncidentSummary {
  generatedAt: string
  counts: IncidentCounts
  incidents: IncidentRecord[]
  /** Non-fatal warnings emitted during list assembly. */
  warnings: string[]
}

// ── Alert routing ────────────────────────────────────────────────────────

export type AlertChannel = 'slack' | 'pagerduty' | 'sentry'

export type AlertDeliveryOutcome =
  | 'sent'
  | 'failed'
  | 'skipped_disabled'
  | 'skipped_unconfigured'
  | 'skipped_severity'

export interface AlertRoute {
  channel: AlertChannel
  /** Visible operator-readable target (e.g. "#security-alerts"). NEVER the secret. */
  targetLabel: string
  /** Minimum severity (inclusive) that triggers this route. */
  minSeverity: IncidentSeverity
}

export interface AlertDeliveryStatus {
  channel: AlertChannel
  outcome: AlertDeliveryOutcome
  /** Operator-readable target. NEVER the webhook URL. */
  target: string | null
  /** Short error message when outcome=failed. NEVER the raw response body. */
  error: string | null
  /** Timestamp the helper attempted delivery. */
  attemptedAt: string
}

// ── Detector candidates ──────────────────────────────────────────────────

/**
 * Detectors return CANDIDATE incidents. Operators decide
 * whether to materialise them. The detector ALWAYS leaves the
 * `venueId`, `openedBy`, and final severity choice to the
 * caller — every detector is conservative and operator-
 * triggered.
 */
export interface IncidentCandidate {
  /** Stable id derived from source + window so duplicates collapse. */
  fingerprint: string
  source: IncidentSource
  category: IncidentCategory
  /** Detector's recommended severity. Operator can override. */
  suggestedSeverity: IncidentSeverity
  title: string
  description: string
  /** Structural context — counts, route, limiter key. NEVER raw payloads. */
  evidence: Record<string, unknown>
}

export interface DetectorRunResult {
  source: IncidentSource
  /** Empty when env missing or source unavailable. */
  candidates: IncidentCandidate[]
  /** Non-fatal warnings. Examples: "abuse_events table unavailable". */
  warnings: string[]
  /** Detector-internal observation window (ms). */
  windowMs: number
}
