import type { RetentionPolicyItem } from '@/lib/enterprise/privacy/types'

/**
 * Phase 9M — Retention policy map.
 *
 * Per-category retention TARGETS + the operational reason +
 * what is enforced today.
 *
 * Honesty rules:
 *   - Targets are policy INTENT; only categories whose
 *     `automationStatus === 'implemented'` actually have a
 *     cron/job enforcing the window today. Everything else is
 *     `partial` / `manual` / `planned`.
 *   - Security/audit logs default to manual review because
 *     retention may be required to satisfy security or legal
 *     obligations that override a deletion request.
 *   - Billing metadata has long retention windows driven by
 *     financial / tax requirements; legal review required
 *     before deletion.
 */

export const RETENTION_POLICY_ITEMS: ReadonlyArray<RetentionPolicyItem> = [
  {
    category: 'account_identity',
    defaultWindow:
      'For the lifetime of the subscription + 30-day grace after cancellation.',
    reason: 'Tenant operator continuity + reactivation window.',
    deletionBehavior:
      'Operator-initiated via Supabase auth + cascading venue_members removal. DSR workflow tracks the request.',
    exportBehavior:
      'Operator export via /api/admin/data-export (Phase 9D) returns venue-scoped JSON.',
    exceptions: [
      'Active subscription with outstanding invoice → defer until billing settled.',
    ],
    automationStatus: 'manual',
  },
  {
    category: 'venue_profile',
    defaultWindow: 'For the lifetime of the tenant.',
    reason: 'Required to operate the tenant dashboard.',
    deletionBehavior:
      'Removed when the tenant is deleted; demo-mode flag is a visual marker only and does NOT anonymize.',
    exportBehavior: 'Included in operator data export.',
    exceptions: [],
    automationStatus: 'manual',
  },
  {
    category: 'lead_contact',
    defaultWindow:
      '90 days after the lead is marked lost (reactivation window) by default; operator-configurable in a future phase.',
    reason: 'Operational lead pipeline + reactivation analytics.',
    deletionBehavior:
      'Lead-level soft redaction via /api/admin/leads/[leadId]/redact-pii (Phase 9D). Anonymizes name/email/phone/notes while preserving conversations/tours/audit lineage.',
    exportBehavior: 'Included in operator data export.',
    exceptions: [
      'Open booking with billing impact → retain until resolved.',
      'Active DSR → retain until DSR is closed.',
    ],
    automationStatus: 'partial',
  },
  {
    category: 'lead_event_details',
    defaultWindow: 'Mirrors lead_contact.',
    reason: 'Operational analytics + RevenueOS leakage signals.',
    deletionBehavior: 'Cascades with lead redaction.',
    exportBehavior: 'Included in operator data export.',
    exceptions: [],
    automationStatus: 'partial',
  },
  {
    category: 'conversation_content',
    defaultWindow: 'Mirrors lead_contact.',
    reason: 'Operator review + AI calibration history.',
    deletionBehavior:
      'Lead-level redaction does NOT remove conversation bodies today. Conversation-level redaction is on the planned-improvements list.',
    exportBehavior: 'Included in operator data export.',
    exceptions: [
      'Pending DSR requests → message bodies retained until reviewed.',
    ],
    automationStatus: 'partial',
  },
  {
    category: 'tour_scheduling',
    defaultWindow: 'Mirrors lead retention; tokens auto-expire.',
    reason: 'Operational calendar.',
    deletionBehavior:
      'Cascades with lead deletion. Tour-action tokens are single-use and auto-expire.',
    exportBehavior: 'Included in operator data export.',
    exceptions: [],
    automationStatus: 'partial',
  },
  {
    category: 'billing_metadata',
    defaultWindow:
      'For the lifetime of the subscription + applicable financial/tax retention requirements (multi-year typical).',
    reason: 'Billing reconciliation + statutory financial retention.',
    deletionBehavior:
      'Not deleted from VenueRise during normal lifecycle. Stripe retains its own customer + invoice records per Stripe policy.',
    exportBehavior:
      'Billing-events export is admin-readable; raw invoice PDFs are downloaded from Stripe directly.',
    exceptions: [
      'Statutory financial retention overrides DSR deletion until the window passes.',
    ],
    automationStatus: 'manual',
  },
  {
    category: 'auth_security_metadata',
    defaultWindow:
      'For the duration of the active session / invitation. Tokens are single-use or short-lived.',
    reason: 'Security access control.',
    deletionBehavior:
      'Sessions expire automatically; SSO connections are deleted via owner-only mutation.',
    exportBehavior:
      'NOT exported. Returning live session/SSO tokens would itself be a security incident.',
    exceptions: [],
    automationStatus: 'implemented',
  },
  {
    category: 'audit_metadata',
    defaultWindow:
      '365 days target. No automated sweeper today; rows currently accumulate.',
    reason: 'Security investigation + tamper evidence.',
    deletionBehavior:
      'Deletion is restricted. Audit rows may be required for legal/security review. Operator + legal review on a per-request basis.',
    exportBehavior:
      'Not directly exportable via DSR. Aggregate audit export is admin-readable via /api/admin/audit-events.',
    exceptions: [
      'Legal hold → retain past the window.',
      'Active incident or DSR → retain until closed.',
    ],
    automationStatus: 'manual',
  },
  {
    category: 'abuse_security_metadata',
    defaultWindow: '365 days target.',
    reason: 'Detect repeat abusive patterns.',
    deletionBehavior:
      'Deletion is restricted. Operator + legal review per request.',
    exportBehavior: 'NOT exportable to subjects; admin-readable for ops.',
    exceptions: [
      'Active investigation → retain until closed.',
    ],
    automationStatus: 'manual',
  },
  {
    category: 'sso_security_metadata',
    defaultWindow: '365 days target.',
    reason: 'SSO failure pattern analysis.',
    deletionBehavior:
      'Deletion is restricted. Operator + legal review per request.',
    exportBehavior: 'NOT exportable to subjects; admin-readable for ops.',
    exceptions: [],
    automationStatus: 'manual',
  },
  {
    category: 'incident_metadata',
    defaultWindow: '365 days target.',
    reason: 'Security + availability incident history; post-incident review evidence.',
    deletionBehavior:
      'Restricted. Incident records may be required for security / compliance audits.',
    exportBehavior: 'NOT exportable to subjects; admin-readable.',
    exceptions: [],
    automationStatus: 'manual',
  },
  {
    category: 'vendor_metadata',
    defaultWindow: 'For the lifetime of the vendor relationship.',
    reason: 'Subprocessor disclosure + procurement readiness.',
    deletionBehavior:
      'Operator removes a vendor row when the relationship ends.',
    exportBehavior:
      'Exportable via /api/admin/security/vendor-risk-report (admin) + /api/admin/security/subprocessor-disclosure (buyer-safe).',
    exceptions: [],
    automationStatus: 'manual',
  },
  {
    category: 'support_metadata',
    defaultWindow:
      'Suppressions retained as long as needed to honor opt-out. Digest send rows: 365-day target, with the Phase 8AA retention sweeper pruning archived rows.',
    reason:
      'Honor opt-out commitments + operator visibility into recent digests.',
    deletionBehavior:
      'Suppressions only removed when the operator explicitly resubscribes (Phase 8AA). Digest rows pruned by the existing weekly sweeper.',
    exportBehavior: 'Admin-readable via digest preferences/sends APIs.',
    exceptions: [],
    automationStatus: 'implemented',
  },
  {
    category: 'system_logs',
    defaultWindow:
      'Vendor-governed. Application pino logs are stream-only (not persisted by VenueRise).',
    reason: 'Operational debugging + error triage.',
    deletionBehavior:
      'Sentry + Vercel retention is set in the vendor dashboard. Application pino logs disappear with the runtime.',
    exportBehavior:
      'Sentry events are exportable from the Sentry dashboard. Vercel logs from the Vercel dashboard.',
    exceptions: [],
    automationStatus: 'partial',
  },
]
