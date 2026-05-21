/**
 * Phase 9M — Privacy + DSR types.
 *
 * Shape for the static data inventory + retention policy + the
 * operator-facing Data Subject Request (DSR) workflow.
 *
 * Honesty rules carried throughout:
 *   - This module does NOT claim GDPR / CCPA / LGPD compliance.
 *     It packages controls a legal reviewer can map to a
 *     framework.
 *   - DSRs are tracked, NOT auto-fulfilled. Every export +
 *     deletion routes through operator + legal review.
 *   - Security/audit logs are flagged restricted-deletion;
 *     retention may be required for security or legal reasons
 *     that override a deletion request.
 *   - The AI/vendor processing answer in the questionnaire is
 *     cautious — vendor contract terms (zero-retention,
 *     training exclusion) require legal verification.
 */

// ── Data inventory taxonomy ──────────────────────────────────────────────

export type PrivacyDataCategory =
  | 'account_identity'
  | 'venue_profile'
  | 'lead_contact'
  | 'lead_event_details'
  | 'conversation_content'
  | 'tour_scheduling'
  | 'billing_metadata'
  | 'auth_security_metadata'
  | 'audit_metadata'
  | 'abuse_security_metadata'
  | 'sso_security_metadata'
  | 'incident_metadata'
  | 'vendor_metadata'
  | 'support_metadata'
  | 'system_logs'

export const PRIVACY_DATA_CATEGORIES: ReadonlyArray<PrivacyDataCategory> = [
  'account_identity',
  'venue_profile',
  'lead_contact',
  'lead_event_details',
  'conversation_content',
  'tour_scheduling',
  'billing_metadata',
  'auth_security_metadata',
  'audit_metadata',
  'abuse_security_metadata',
  'sso_security_metadata',
  'incident_metadata',
  'vendor_metadata',
  'support_metadata',
  'system_logs',
]

export type PrivacySensitivity = 'low' | 'moderate' | 'high' | 'restricted'

export type PrivacyRetentionBasis =
  | 'operational'
  | 'security'
  | 'billing'
  | 'legal'
  | 'customer_request'
  | 'manual_review'

export type PrivacyControlStatus =
  | 'implemented'
  | 'manual'
  | 'partial'
  | 'planned'
  | 'unknown'

/**
 * Per-data-class row in the inventory. Buyer-readable + legal-
 * reviewer-readable. Source references point at the table / route
 * / module where the data is processed so a reviewer can trace
 * the data flow back to code.
 */
export interface PrivacyDataInventoryItem {
  id: string
  category: PrivacyDataCategory
  displayName: string
  description: string
  /** Example field names. NOT a schema — illustrative only. */
  exampleFields: string[]
  /** Repo-relative source pointers (tables, routes, modules). */
  sources: string[]
  sensitivity: PrivacySensitivity
  /** Plain-language purpose for processing. */
  purpose: string
  /**
   * Operational basis (e.g. "tenant operates lead pipeline").
   * NOT a legal basis under GDPR Art. 6; legal review needed.
   */
  operationalBasis: string
  retentionBasis: PrivacyRetentionBasis
  /** Plain-language default retention target. */
  defaultRetention: string
  exportable: boolean
  deletable: boolean
  /** Whether a correction / rectification flow exists. */
  correctionSupported: boolean
  /** Subprocessor vendor ids (from vendor-registry) involved. */
  vendorIds: string[]
  controlStatus: PrivacyControlStatus
  knownLimitations: string[]
  recommendedNext: string[]
}

// ── Retention policy map ─────────────────────────────────────────────────

export interface RetentionPolicyItem {
  category: PrivacyDataCategory
  /** Plain-language target window (e.g. "365 days", "until subscription ends"). */
  defaultWindow: string
  reason: string
  /** Plain-language deletion behaviour today. */
  deletionBehavior: string
  exportBehavior: string
  /** Operational exceptions (legal hold, billing, security). */
  exceptions: string[]
  /** Whether a cron / job enforces the window today. */
  automationStatus: PrivacyControlStatus
}

// ── DSR workflow ─────────────────────────────────────────────────────────

export type DsrType =
  | 'access'
  | 'export'
  | 'delete'
  | 'correct'
  | 'restrict_processing'
  | 'opt_out'
  | 'other'

export type DsrStatus =
  | 'received'
  | 'triage'
  | 'identity_verification'
  | 'in_progress'
  | 'awaiting_legal_review'
  | 'fulfilled'
  | 'denied'
  | 'cancelled'

export type DsrRiskLevel = 'low' | 'medium' | 'high'

export const DSR_TYPES: ReadonlyArray<DsrType> = [
  'access',
  'export',
  'delete',
  'correct',
  'restrict_processing',
  'opt_out',
  'other',
]
export const DSR_STATUSES: ReadonlyArray<DsrStatus> = [
  'received',
  'triage',
  'identity_verification',
  'in_progress',
  'awaiting_legal_review',
  'fulfilled',
  'denied',
  'cancelled',
]
export const DSR_RISK_LEVELS: ReadonlyArray<DsrRiskLevel> = [
  'low',
  'medium',
  'high',
]

export type DsrTimelineEventType =
  | 'created'
  | 'status_changed'
  | 'assigned'
  | 'identity_verified'
  | 'legal_review_added'
  | 'note_added'
  | 'export_prepared'
  | 'deletion_reviewed'
  | 'fulfilled'
  | 'denied'
  | 'cancelled'

export interface DsrRequest {
  id: string
  venueId: string | null
  requestType: DsrType
  status: DsrStatus
  riskLevel: DsrRiskLevel
  subjectEmail: string | null
  subjectName: string | null
  subjectUserId: string | null
  requestedByEmail: string | null
  requestedByUserId: string | null
  identityVerifiedAt: string | null
  legalReviewRequired: boolean
  legalReviewNotes: string | null
  description: string | null
  scope: string | null
  dueAt: string | null
  fulfilledAt: string | null
  deniedAt: string | null
  cancelledAt: string | null
  assignedTo: string | null
  createdBy: string | null
  closedBy: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface DsrTimelineEvent {
  id: string
  dsrRequestId: string
  eventType: DsrTimelineEventType
  actorUserId: string | null
  message: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface DsrCreateInput {
  venueId: string | null
  requestType: DsrType
  riskLevel?: DsrRiskLevel
  subjectEmail?: string | null
  subjectName?: string | null
  subjectUserId?: string | null
  requestedByEmail?: string | null
  description?: string | null
  scope?: string | null
  dueAt?: string | null
  legalReviewRequired?: boolean
  metadata?: Record<string, unknown> | null
  createdBy: string | null
}

export interface DsrUpdateInput {
  dsrRequestId: string
  status?: DsrStatus
  riskLevel?: DsrRiskLevel
  assignedTo?: string | null
  legalReviewNotes?: string | null
  legalReviewRequired?: boolean
  description?: string | null
  scope?: string | null
  dueAt?: string | null
  metadata?: Record<string, unknown> | null
  /** Free-form note appended as a timeline event. */
  note?: string | null
  /**
   * When set, the helper stamps `identity_verified_at` to now
   * and writes an `identity_verified` timeline event.
   */
  markIdentityVerified?: boolean
  actorUserId: string | null
}

// ── Summary roll-ups ─────────────────────────────────────────────────────

export interface DsrCounts {
  total: number
  open: number
  awaitingLegalReview: number
  fulfilled: number
  denied: number
  cancelled: number
  overdue: number
}

export interface PrivacyReadinessCounts {
  totalCategories: number
  highOrRestrictedSensitivity: number
  exportReady: number
  deletionReady: number
  manualReview: number
  retentionPolicyRows: number
}

export interface PrivacyReadinessSummary {
  generatedAt: string
  /** Identical disclaimer carried in every render. */
  disclaimer: string
  counts: PrivacyReadinessCounts
  dsrCounts: DsrCounts
  inventory: PrivacyDataInventoryItem[]
  retentionPolicy: RetentionPolicyItem[]
  warnings: string[]
}

// ── Non-destructive review shapes ────────────────────────────────────────

export interface DsrExportPreviewItem {
  category: PrivacyDataCategory
  displayName: string
  sources: string[]
  exportable: boolean
  manualReviewRequired: boolean
  vendorIds: string[]
  note: string
}

export interface DsrExportPreview {
  generatedAt: string
  dsrRequestId: string
  subjectEmail: string | null
  subjectUserId: string | null
  items: DsrExportPreviewItem[]
  excludedRestricted: PrivacyDataCategory[]
  warnings: string[]
  /** Operator-readable disclaimer. */
  disclaimer: string
}

export interface DsrDeletionReviewItem {
  category: PrivacyDataCategory
  displayName: string
  sources: string[]
  deletable: boolean
  anonymizable: boolean
  retentionExceptionApplies: boolean
  retentionExceptionReason: string | null
  note: string
}

export interface DsrDeletionReview {
  generatedAt: string
  dsrRequestId: string
  subjectEmail: string | null
  subjectUserId: string | null
  items: DsrDeletionReviewItem[]
  warnings: string[]
  disclaimer: string
}
