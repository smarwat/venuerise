/**
 * Phase 9P — Contract commitments types.
 *
 * Operator-recorded register for customer-specific
 * contractual / security / privacy commitments. Lets the
 * platform answer "what did we actually promise this buyer?"
 * without becoming a legal system of record.
 *
 * Honesty rules carried throughout:
 *   - Commitments are OPERATOR-RECORDED. No autonomous
 *     contract parsing, no auto-creation from uploaded docs.
 *   - Unsupported-risk warnings surface commitments that
 *     reference capabilities we do not currently offer (real
 *     SSO, SCIM, SOC 2 certification, 24/7 monitoring,
 *     automated DSR fulfilment, autonomous sending).
 *     Operators are NOT blocked from recording them — the
 *     warning exists so the operator can rectify with the
 *     buyer.
 *   - This is a tracking / readiness workflow, not legal
 *     advice and not contractual compliance proof.
 */

export type CommitmentSourceType =
  | 'msa'
  | 'dpa'
  | 'security_addendum'
  | 'order_form'
  | 'trust_grant'
  | 'email'
  | 'other'

export const COMMITMENT_SOURCE_TYPES: ReadonlyArray<CommitmentSourceType> = [
  'msa',
  'dpa',
  'security_addendum',
  'order_form',
  'trust_grant',
  'email',
  'other',
]

export type CommitmentArea =
  | 'security'
  | 'privacy'
  | 'availability'
  | 'support'
  | 'data_retention'
  | 'subprocessor'
  | 'sso'
  | 'scim'
  | 'incident_response'
  | 'backup_dr'
  | 'ai_use'
  | 'data_residency'
  | 'other'

export const COMMITMENT_AREAS: ReadonlyArray<CommitmentArea> = [
  'security',
  'privacy',
  'availability',
  'support',
  'data_retention',
  'subprocessor',
  'sso',
  'scim',
  'incident_response',
  'backup_dr',
  'ai_use',
  'data_residency',
  'other',
]

export type CommitmentStatus =
  | 'draft'
  | 'active'
  | 'fulfilled'
  | 'at_risk'
  | 'expired'
  | 'withdrawn'

export const COMMITMENT_STATUSES: ReadonlyArray<CommitmentStatus> = [
  'draft',
  'active',
  'fulfilled',
  'at_risk',
  'expired',
  'withdrawn',
]

export type CommitmentRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export const COMMITMENT_RISK_LEVELS: ReadonlyArray<CommitmentRiskLevel> = [
  'low',
  'medium',
  'high',
  'critical',
]

export type CommitmentEventType =
  | 'created'
  | 'updated'
  | 'status_changed'
  | 'fulfilled'
  | 'risk_changed'
  | 'reviewed'
  | 'note_added'

export const COMMITMENT_EVENT_TYPES: ReadonlyArray<CommitmentEventType> = [
  'created',
  'updated',
  'status_changed',
  'fulfilled',
  'risk_changed',
  'reviewed',
  'note_added',
]

// ── Record + event row ───────────────────────────────────────────────────

export interface CommitmentRecord {
  id: string
  venueId: string | null
  buyerName: string | null
  buyerCompany: string | null
  buyerEmail: string | null
  sourceType: CommitmentSourceType
  commitmentArea: CommitmentArea
  title: string
  description: string
  status: CommitmentStatus
  riskLevel: CommitmentRiskLevel
  ownerUserId: string | null
  dueAt: string | null
  reviewAt: string | null
  fulfilledAt: string | null
  fulfilledBy: string | null
  evidenceUrl: string | null
  internalNotes: string | null
  metadata: Record<string, unknown>
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface CommitmentEvent {
  id: string
  commitmentId: string
  venueId: string | null
  actorUserId: string | null
  eventType: CommitmentEventType
  note: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

// ── Inputs ───────────────────────────────────────────────────────────────

export interface CommitmentCreateInput {
  venueId: string
  buyerName?: string | null
  buyerCompany?: string | null
  buyerEmail?: string | null
  sourceType: CommitmentSourceType
  commitmentArea: CommitmentArea
  title: string
  description: string
  status?: CommitmentStatus
  riskLevel?: CommitmentRiskLevel
  ownerUserId?: string | null
  dueAt?: string | null
  reviewAt?: string | null
  evidenceUrl?: string | null
  internalNotes?: string | null
  metadata?: Record<string, unknown> | null
  createdBy: string | null
}

export interface CommitmentUpdateInput {
  commitmentId: string
  buyerName?: string | null
  buyerCompany?: string | null
  buyerEmail?: string | null
  sourceType?: CommitmentSourceType
  commitmentArea?: CommitmentArea
  title?: string
  description?: string
  status?: CommitmentStatus
  riskLevel?: CommitmentRiskLevel
  ownerUserId?: string | null
  dueAt?: string | null
  reviewAt?: string | null
  evidenceUrl?: string | null
  internalNotes?: string | null
  metadata?: Record<string, unknown> | null
  /** Free-form note appended as a timeline event. */
  note?: string | null
  /** Convenience flag — sets status=fulfilled + stamps fulfilled_at. */
  markFulfilled?: boolean
  /** Convenience flag — stamps a `reviewed` timeline event. */
  markReviewed?: boolean
  actorUserId: string | null
}

// ── Counts + readiness summary ───────────────────────────────────────────

export interface CommitmentCounts {
  total: number
  draft: number
  active: number
  fulfilled: number
  atRisk: number
  expired: number
  withdrawn: number
  highRisk: number
  criticalRisk: number
  overdueReview: number
  dueWithin30Days: number
  unsupportedRiskFlags: number
}

/**
 * Soft warning surfaced when a recorded commitment references
 * an area the current product does not fully support today.
 * Operators are not blocked from recording; the flag exists
 * so the operator can rectify with the buyer.
 */
export interface UnsupportedRiskFlag {
  commitmentId: string
  area: CommitmentArea
  title: string
  riskLevel: CommitmentRiskLevel
  reason: string
}

export interface CommitmentsReadinessSummary {
  generatedAt: string
  /** Identical disclaimer carried in every render. */
  disclaimer: string
  counts: CommitmentCounts
  /** Open commitments ordered by review_at ascending, capped. */
  upcomingReviews: CommitmentRecord[]
  /** Commitments flagged at_risk or matching unsupported policy. */
  unsupportedRiskFlags: UnsupportedRiskFlag[]
  warnings: string[]
}

// ── List summary ─────────────────────────────────────────────────────────

export interface CommitmentListSummary {
  generatedAt: string
  counts: CommitmentCounts
  commitments: CommitmentRecord[]
  warnings: string[]
}

export interface CommitmentWithTimeline {
  commitment: CommitmentRecord | null
  timeline: CommitmentEvent[]
  warnings: string[]
}
