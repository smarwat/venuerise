import 'server-only'
import { PRIVACY_DATA_INVENTORY } from '@/lib/enterprise/privacy/data-inventory'
import type {
  DsrExportPreview,
  DsrExportPreviewItem,
  PrivacyDataCategory,
} from '@/lib/enterprise/privacy/types'

/**
 * Phase 9M — DSR export preview (metadata-only).
 *
 * Given a subject email + user id, returns the LIST of data
 * categories that would be searched for that subject. Does NOT
 * fetch any subject data. Operators use this to scope a real
 * export they then perform via the appropriate existing
 * endpoints (operator data export, lead redaction reference,
 * etc.) under legal review.
 *
 * Restricted-deletion / restricted-export categories (audit /
 * abuse / SSO / incident / system logs / auth metadata) are
 * EXCLUDED from the export list and surfaced separately in
 * `excludedRestricted` so the operator understands why those
 * are not present in the preview.
 */

export const DSR_EXPORT_PREVIEW_DISCLAIMER =
  'This export preview is metadata-only. It enumerates categories that WOULD be searched for the subject; it does NOT fetch or export any subject content. Real exports require operator action + legal review.'

export interface DsrExportPreviewInput {
  dsrRequestId: string
  subjectEmail: string | null
  subjectUserId: string | null
}

export async function buildDsrExportPreview(
  input: DsrExportPreviewInput
): Promise<DsrExportPreview> {
  const items: DsrExportPreviewItem[] = []
  const excludedRestricted: PrivacyDataCategory[] = []
  const warnings: string[] = []

  if (!input.subjectEmail && !input.subjectUserId) {
    warnings.push(
      'No subject email or user id supplied — preview shows the full inventory scope; narrow the DSR row before producing a real export.'
    )
  }

  for (const item of PRIVACY_DATA_INVENTORY) {
    if (item.exportable) {
      items.push({
        category: item.category,
        displayName: item.displayName,
        sources: item.sources,
        exportable: true,
        manualReviewRequired:
          item.controlStatus !== 'implemented' ||
          item.sensitivity === 'high' ||
          item.sensitivity === 'restricted',
        vendorIds: item.vendorIds,
        note:
          item.controlStatus === 'implemented'
            ? 'Export supported via existing operator export flow.'
            : 'Export requires manual operator action per the data inventory note.',
      })
    } else {
      excludedRestricted.push(item.category)
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    dsrRequestId: input.dsrRequestId,
    subjectEmail: input.subjectEmail,
    subjectUserId: input.subjectUserId,
    items,
    excludedRestricted,
    warnings,
    disclaimer: DSR_EXPORT_PREVIEW_DISCLAIMER,
  }
}
