/**
 * Phase 9O — Compliance operations types.
 *
 * Shape for the operator-controlled compliance review calendar +
 * evidence freshness tracking. Builds on 9I (evidence), 9J (sales
 * readiness), 9K (vendor risk), 9L (incident response), 9M
 * (privacy + DSR), and 9N (trust center).
 *
 * Honesty rules carried throughout:
 *   - The calendar tracks OPERATOR-INITIATED reviews. It does
 *     NOT prove continuous compliance.
 *   - Every "completion" is an explicit operator action; nothing
 *     is auto-marked.
 *   - No autonomous rotation, no autonomous artifact refresh,
 *     no external alerting in this phase.
 *   - Freshness is derived from completed event records, not
 *     from real-time attestation of the underlying control.
 */

export type ComplianceReviewArea =
  | 'vendor_risk'
  | 'subprocessors'
  | 'privacy_dsr'
  | 'retention_policy'
  | 'disaster_recovery'
  | 'backup_posture'
  | 'incident_response'
  | 'trust_center'
  | 'security_questionnaire'
  | 'evidence_pack'
  | 'sso_readiness'
  | 'rate_limit_coverage'
  | 'audit_coverage'
  | 'access_control'
  | 'security_headers'
  | 'data_lifecycle'
  | 'custom'

export const COMPLIANCE_REVIEW_AREAS: ReadonlyArray<ComplianceReviewArea> = [
  'vendor_risk',
  'subprocessors',
  'privacy_dsr',
  'retention_policy',
  'disaster_recovery',
  'backup_posture',
  'incident_response',
  'trust_center',
  'security_questionnaire',
  'evidence_pack',
  'sso_readiness',
  'rate_limit_coverage',
  'audit_coverage',
  'access_control',
  'security_headers',
  'data_lifecycle',
  'custom',
]

export type ComplianceReviewCadence =
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual'
  | 'ad_hoc'

export const COMPLIANCE_REVIEW_CADENCES: ReadonlyArray<ComplianceReviewCadence> = [
  'monthly',
  'quarterly',
  'semiannual',
  'annual',
  'ad_hoc',
]

export type ComplianceReviewStatus =
  | 'upcoming'
  | 'due'
  | 'overdue'
  | 'completed'
  | 'waived'

export const COMPLIANCE_REVIEW_STATUSES: ReadonlyArray<ComplianceReviewStatus> = [
  'upcoming',
  'due',
  'overdue',
  'completed',
  'waived',
]

export type ComplianceEventSource =
  | 'system_seeded'
  | 'operator_created'
  | 'script_generated'

export const COMPLIANCE_EVENT_SOURCES: ReadonlyArray<ComplianceEventSource> = [
  'system_seeded',
  'operator_created',
  'script_generated',
]

// ── Event row ────────────────────────────────────────────────────────────

export interface ComplianceReviewEvent {
  id: string
  venueId: string | null
  policyId: string
  area: ComplianceReviewArea
  title: string
  cadence: ComplianceReviewCadence
  status: ComplianceReviewStatus
  source: ComplianceEventSource
  dueAt: string
  completedAt: string | null
  completedBy: string | null
  waivedAt: string | null
  waivedBy: string | null
  waiverReason: string | null
  reviewNotes: string | null
  evidenceUrl: string | null
  metadata: Record<string, unknown>
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

// ── Inputs ───────────────────────────────────────────────────────────────

export interface ComplianceReviewCompletionInput {
  eventId: string
  /** Required if the policy has buyer impact or for SEV-class areas. */
  reviewNotes?: string | null
  evidenceUrl?: string | null
  metadata?: Record<string, unknown> | null
  actorUserId: string | null
}

export interface ComplianceReviewWaiverInput {
  eventId: string
  waiverReason: string
  metadata?: Record<string, unknown> | null
  actorUserId: string | null
}

export interface ComplianceReviewUpdateInput {
  eventId: string
  reviewNotes?: string | null
  evidenceUrl?: string | null
  metadata?: Record<string, unknown> | null
  actorUserId: string | null
}

export interface CustomComplianceReviewInput {
  venueId: string
  area: ComplianceReviewArea
  title: string
  cadence: ComplianceReviewCadence
  dueAt: string
  reviewNotes?: string | null
  metadata?: Record<string, unknown> | null
  createdBy: string | null
}

// ── Policy row ───────────────────────────────────────────────────────────

/**
 * Per-area policy entry. Hand-maintained in
 * `lib/enterprise/compliance-ops/policy.ts`. The calendar
 * helper iterates these rows when seeding events for a venue.
 *
 * `staleAfterDays` is the soft "this review is now stale even
 * before the next due date hits" threshold — for fast-moving
 * areas (trust center copy) operators may want to refresh
 * sooner than the calendar window suggests.
 */
export interface ComplianceReviewPolicyItem {
  id: string
  area: ComplianceReviewArea
  title: string
  cadence: ComplianceReviewCadence
  description: string
  /** Human-readable owner role (e.g. "platform", "legal", "owner"). */
  ownerRole: string
  /**
   * Repo-relative or runbook pointers an operator follows when
   * performing the review.
   */
  evidenceReferences: string[]
  recommendedAction: string
  /**
   * Days past the last completion before the area is flagged
   * stale in the freshness summary even if the next due date
   * has not yet hit.
   */
  staleAfterDays: number
  /** Plain-language description of what a buyer would see. */
  buyerImpactIfStale: string
}

// ── Freshness summary ────────────────────────────────────────────────────

export interface ComplianceCounts {
  totalPolicyItems: number
  upcoming: number
  due: number
  overdue: number
  completedLast30d: number
  waived: number
  staleAreas: number
}

export interface ComplianceFreshnessRow {
  policyId: string
  area: ComplianceReviewArea
  title: string
  cadence: ComplianceReviewCadence
  ownerRole: string
  /** Most recent completed event timestamp, or null if never reviewed. */
  lastCompletedAt: string | null
  /** Next scheduled due date, or null if no upcoming/due/overdue event. */
  nextDueAt: string | null
  /** Aggregate status across the policy item's open events. */
  status: ComplianceReviewStatus
  /** True when stale-after-days threshold has elapsed since lastCompletedAt. */
  stale: boolean
  buyerImpactIfStale: string
}

export interface ComplianceFreshnessSummary {
  generatedAt: string
  /** Identical disclaimer carried in every render. */
  disclaimer: string
  counts: ComplianceCounts
  rows: ComplianceFreshnessRow[]
  warnings: string[]
}
