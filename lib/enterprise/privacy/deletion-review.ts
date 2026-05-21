import 'server-only'
import { PRIVACY_DATA_INVENTORY } from '@/lib/enterprise/privacy/data-inventory'
import { RETENTION_POLICY_ITEMS } from '@/lib/enterprise/privacy/retention-policy'
import type {
  DsrDeletionReview,
  DsrDeletionReviewItem,
} from '@/lib/enterprise/privacy/types'

/**
 * Phase 9M — DSR deletion review (non-destructive).
 *
 * Produces an operator + legal review checklist for a deletion
 * DSR. NEVER deletes anything. The output enumerates:
 *
 *   - Which categories are deletable today.
 *   - Which categories support anonymization (e.g. lead-level
 *     soft redaction) when full deletion isn't appropriate.
 *   - Which categories have a retention exception that may
 *     override the deletion request (security logs, billing
 *     metadata).
 *
 * Operators run real deletion via the appropriate existing
 * endpoints (lead PII redaction, account removal workflow, etc.)
 * under legal review.
 */

export const DSR_DELETION_REVIEW_DISCLAIMER =
  'This deletion review is non-destructive. It enumerates what COULD be deleted, anonymized, or retained for the subject; it does NOT delete anything. Real deletion requires operator action + legal review and must honor security/billing retention exceptions.'

export interface DsrDeletionReviewInput {
  dsrRequestId: string
  subjectEmail: string | null
  subjectUserId: string | null
}

export async function buildDsrDeletionReview(
  input: DsrDeletionReviewInput
): Promise<DsrDeletionReview> {
  const warnings: string[] = []
  const items: DsrDeletionReviewItem[] = []

  if (!input.subjectEmail && !input.subjectUserId) {
    warnings.push(
      'No subject email or user id supplied — review shows the full inventory scope; narrow the DSR row before initiating real deletion.'
    )
  }

  for (const item of PRIVACY_DATA_INVENTORY) {
    const policy = RETENTION_POLICY_ITEMS.find(
      (r) => r.category === item.category
    )
    const retentionExceptionApplies =
      item.retentionBasis === 'security' ||
      item.retentionBasis === 'billing' ||
      item.retentionBasis === 'legal'
    const retentionExceptionReason = retentionExceptionApplies
      ? `Retention basis "${item.retentionBasis}" — ${policy?.reason ?? 'see retention policy table'}.`
      : null

    // A category is anonymizable today only when an actual
    // anonymization path exists. We treat lead-level PII soft
    // redaction (Phase 9D) as anonymization for lead_contact
    // and lead_event_details.
    const anonymizable =
      item.category === 'lead_contact' ||
      item.category === 'lead_event_details'

    items.push({
      category: item.category,
      displayName: item.displayName,
      sources: item.sources,
      deletable: item.deletable,
      anonymizable,
      retentionExceptionApplies,
      retentionExceptionReason,
      note: item.deletable
        ? anonymizable
          ? 'Deletable via existing flow; anonymization (soft redact) may be preferred when conversations must be retained.'
          : 'Deletable via existing operator flow.'
        : retentionExceptionApplies
          ? 'Not deletable today — retention exception applies. Operator + legal review required.'
          : 'Not deletable today — see data inventory note.',
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    dsrRequestId: input.dsrRequestId,
    subjectEmail: input.subjectEmail,
    subjectUserId: input.subjectUserId,
    items,
    warnings,
    disclaimer: DSR_DELETION_REVIEW_DISCLAIMER,
  }
}
