import type { PrivacyDataInventoryItem } from '@/lib/enterprise/privacy/types'

/**
 * Phase 9M — Static privacy data inventory.
 *
 * Single source of truth for "what categories of personal /
 * customer data does VenueRise process, and where is each
 * processed." Hand-maintained. Every row reflects a data class
 * that ACTUALLY exists in the codebase + corresponding
 * Supabase tables.
 *
 * Honesty rules:
 *   - `operationalBasis` is plain-language and is NOT a GDPR
 *     Art. 6 legal basis. Legal review required before any
 *     contractual claim.
 *   - `exportable` / `deletable` reflect what the current code
 *     SUPPORTS today. Operator workflow is still required.
 *   - `correctionSupported` is true only where a first-class
 *     update flow exists (e.g. lead PATCH); not a synthetic
 *     promise.
 *   - Security-class rows (audit / abuse / SSO / incident)
 *     carry `deletable: false` because retention may be
 *     required for security / legal reasons. Operator + legal
 *     review override on a per-request basis.
 *   - `vendorIds` map to `lib/enterprise/vendor-risk/
 *     vendor-registry.ts` ids so the data flow is traceable
 *     through to subprocessors.
 *
 * Adding a row here without the matching code is a lie;
 * reviewers should be able to follow every `sources` entry to
 * a real path.
 */

export const PRIVACY_DATA_INVENTORY: ReadonlyArray<PrivacyDataInventoryItem> = [
  {
    id: 'account-identity',
    category: 'account_identity',
    displayName: 'Operator account identity',
    description:
      'Operator user accounts that sign in to manage a venue. Includes auth identifiers and basic profile fields.',
    exampleFields: ['email', 'user_id', 'created_at', 'last_sign_in_at'],
    sources: [
      'auth.users (Supabase)',
      'public.venue_members (role + venue link)',
    ],
    sensitivity: 'moderate',
    purpose:
      'Authenticate operators + scope tenant access through venue_members.',
    operationalBasis:
      'Tenant onboarding + ongoing operator access to the venue workspace.',
    retentionBasis: 'operational',
    defaultRetention: 'Until tenant ends subscription + 30-day grace.',
    exportable: true,
    deletable: true,
    correctionSupported: true,
    vendorIds: ['supabase'],
    controlStatus: 'implemented',
    knownLimitations: [
      'Account deletion deletes the auth row + cascades venue_members; downstream data (leads, conversations) follows the venue\'s separate deletion workflow.',
    ],
    recommendedNext: [
      'Self-service operator deletion flow with grace period + cancel link.',
    ],
  },
  {
    id: 'venue-profile',
    category: 'venue_profile',
    displayName: 'Venue profile + settings',
    description:
      'Venue name, branding, availability, blackouts, tour duration, RevenueOS settings, demo-mode flags, and tenant-level configuration.',
    exampleFields: [
      'venue_id',
      'name',
      'demo_mode_enabled',
      'tour_duration_minutes',
      'metadata',
    ],
    sources: [
      'public.venues',
      'public.tour_blackouts',
      'public.availability_slots',
    ],
    sensitivity: 'low',
    purpose:
      'Render the dashboard + drive tour suggestions + power widget configuration.',
    operationalBasis: 'Operator-supplied tenant configuration.',
    retentionBasis: 'operational',
    defaultRetention: 'For the lifetime of the tenant.',
    exportable: true,
    deletable: true,
    correctionSupported: true,
    vendorIds: ['supabase'],
    controlStatus: 'implemented',
    knownLimitations: [],
    recommendedNext: [],
  },
  {
    id: 'lead-contact',
    category: 'lead_contact',
    displayName: 'Lead contact identity',
    description:
      'Personal contact details for the inquiring couple: name, email, phone, optional notes provided via the widget.',
    exampleFields: ['lead_id', 'name', 'email', 'phone', 'notes'],
    sources: [
      'public.leads',
      'app/api/widget/route.ts (intake)',
      'app/api/admin/leads/[leadId]/redact-pii/route.ts (soft redaction)',
    ],
    sensitivity: 'high',
    purpose:
      'Allow the operator to reply, schedule a tour, and follow up. Backs the inbox + Kanban.',
    operationalBasis:
      'Inquiry submitted by the lead via the public widget; consent inferred from inquiry.',
    retentionBasis: 'operational',
    defaultRetention:
      'Until the operator marks the lead lost + the reactivation window closes (default 90 days). Lead-level PII redaction is operator-triggered.',
    exportable: true,
    deletable: true,
    correctionSupported: true,
    vendorIds: ['supabase', 'anthropic'],
    controlStatus: 'partial',
    knownLimitations: [
      'No customer-facing self-service deletion flow today — DSR workflow is operator-routed.',
      'Anthropic processes lead text for qualification + drafting; vendor retention terms require legal verification.',
    ],
    recommendedNext: [
      'Subject-initiated deletion via DSR intake page (post-9M).',
    ],
  },
  {
    id: 'lead-event-details',
    category: 'lead_event_details',
    displayName: 'Lead event details',
    description:
      'Event-specific fields submitted by the lead: event date, guest count, budget, message, lost-reason metadata.',
    exampleFields: [
      'event_date',
      'guest_count',
      'budget',
      'message',
      'metadata.lost_reason',
    ],
    sources: ['public.leads (metadata jsonb)'],
    sensitivity: 'moderate',
    purpose: 'Drive AI qualification + tour readiness + revenue leakage signals.',
    operationalBasis:
      'Inquiry submitted by the lead via the public widget.',
    retentionBasis: 'operational',
    defaultRetention: 'Mirrors lead_contact retention.',
    exportable: true,
    deletable: true,
    correctionSupported: true,
    vendorIds: ['supabase', 'anthropic'],
    controlStatus: 'partial',
    knownLimitations: [
      'Free-text `message` may carry incidental PII the lead chose to volunteer; redaction is operator-triggered.',
    ],
    recommendedNext: [],
  },
  {
    id: 'conversation-content',
    category: 'conversation_content',
    displayName: 'Conversation messages',
    description:
      'Inbound + outbound message bodies + drafts + AI variant snapshots between operator and lead.',
    exampleFields: ['message_id', 'content', 'sender', 'created_at'],
    sources: [
      'public.messages',
      'public.conversations',
      'public.ai_actions (drafts + variant metadata)',
      'app/api/ai/draft/route.ts',
    ],
    sensitivity: 'high',
    purpose:
      'Operator-led customer conversation. Powers inbox + draft regeneration + brand-voice calibration.',
    operationalBasis: 'Operator-led customer support.',
    retentionBasis: 'operational',
    defaultRetention:
      'For the lifetime of the lead row; redaction is operator-triggered and CURRENTLY lead-level only (no conversation-level redaction yet).',
    exportable: true,
    deletable: false,
    correctionSupported: false,
    vendorIds: ['supabase', 'anthropic', 'resend'],
    controlStatus: 'partial',
    knownLimitations: [
      'No conversation-level PII redaction; lead-level redaction leaves message bodies intact.',
      'Outbound replies are sent via Resend; delivery metadata is retained there per vendor policy.',
      'AI drafting sends inbound message context to Anthropic for inference.',
    ],
    recommendedNext: [
      'Conversation-level redaction endpoint (operator-triggered).',
    ],
  },
  {
    id: 'tour-scheduling',
    category: 'tour_scheduling',
    displayName: 'Tour scheduling data',
    description:
      'Tour bookings, confirmation status, notification deliveries, and tour-action token usage.',
    exampleFields: ['tour_id', 'scheduled_at', 'status', 'lead_id'],
    sources: [
      'public.tours',
      'public.tour_status_events',
      'public.tour_notifications',
      'public.tour_action_tokens',
    ],
    sensitivity: 'moderate',
    purpose:
      'Operator-facing calendar + automated tour confirm/cancel + reminder emails.',
    operationalBasis:
      'Operator-led tour scheduling for a confirmed lead.',
    retentionBasis: 'operational',
    defaultRetention: 'Mirrors lead retention; tokens auto-expire.',
    exportable: true,
    deletable: true,
    correctionSupported: true,
    vendorIds: ['supabase', 'resend'],
    controlStatus: 'implemented',
    knownLimitations: [],
    recommendedNext: [],
  },
  {
    id: 'billing-metadata',
    category: 'billing_metadata',
    displayName: 'Billing + subscription metadata',
    description:
      'Stripe customer / subscription / invoice identifiers + status. Card data is captured by Stripe directly and never reaches VenueRise.',
    exampleFields: [
      'stripe_customer_id',
      'stripe_subscription_id',
      'status',
      'plan',
    ],
    sources: [
      'public.venues (stripe_customer_id, stripe_subscription_id)',
      'public.billing_events',
      'app/api/billing/checkout/route.ts',
      'app/api/billing/portal/route.ts',
      'app/api/stripe/webhook/route.ts',
    ],
    sensitivity: 'moderate',
    purpose:
      'Enforce subscription state + billing gates; reconcile webhook events.',
    operationalBasis: 'Contractual subscription billing.',
    retentionBasis: 'billing',
    defaultRetention:
      'For the lifetime of the subscription + applicable financial/tax retention requirements.',
    exportable: true,
    deletable: false,
    correctionSupported: false,
    vendorIds: ['stripe', 'supabase'],
    controlStatus: 'implemented',
    knownLimitations: [
      'Stripe retains its own customer + invoice record per its own policy; deletion in VenueRise does not delete the Stripe-side record.',
    ],
    recommendedNext: [],
  },
  {
    id: 'auth-security-metadata',
    category: 'auth_security_metadata',
    displayName: 'Authentication + session metadata',
    description:
      'Session tokens (server-managed), refresh tokens, SSO connection state, and team-invitation tokens. Token VALUES are never returned in any response after issuance.',
    exampleFields: ['session_id', 'sso_connection_id', 'invitation_id'],
    sources: [
      'auth.sessions (Supabase)',
      'public.sso_connections',
      'public.team_invitations',
    ],
    sensitivity: 'restricted',
    purpose: 'Authentication, session continuity, SSO scaffolding.',
    operationalBasis: 'Security-critical access control.',
    retentionBasis: 'security',
    defaultRetention:
      'For the duration of the active session / invitation window. Tokens are single-use or short-lived.',
    exportable: false,
    deletable: false,
    correctionSupported: false,
    vendorIds: ['supabase'],
    controlStatus: 'implemented',
    knownLimitations: [
      'Cannot be exported via DSR — exporting active session/SSO tokens would itself be a security incident.',
    ],
    recommendedNext: [],
  },
  {
    id: 'audit-metadata',
    category: 'audit_metadata',
    displayName: 'Audit event log',
    description:
      'Structured row per sensitive write: actor identity, route, action, before/after sanitized snapshots, salted-SHA-256 IP fingerprint, request id correlation.',
    exampleFields: [
      'audit_id',
      'action',
      'actor_user_id',
      'target_table',
      'target_id',
      'before',
      'after',
      'ip_hash',
      'request_id',
    ],
    sources: [
      'public.audit_events',
      'public.audit_event_mirror (tamper-evidence; Phase 9C)',
      'lib/enterprise/audit-events.ts',
    ],
    sensitivity: 'restricted',
    purpose:
      'Security investigation, change history, tamper evidence. Required for security/compliance review.',
    operationalBasis: 'Security + processing integrity.',
    retentionBasis: 'security',
    defaultRetention:
      '365 days target; deletion is restricted because the log may be required for security or legal review.',
    exportable: false,
    deletable: false,
    correctionSupported: false,
    vendorIds: ['supabase'],
    controlStatus: 'implemented',
    knownLimitations: [
      'No automated retention sweeper today; rows currently accumulate. Phase 9M reserves retention enforcement for a future phase per the retention policy table.',
      'Raw IPs never stored — only the salted-SHA-256 fingerprint via maskIpForAudit.',
    ],
    recommendedNext: [
      'Optional retention sweeper for audit_events after the policy window is finalised with legal.',
    ],
  },
  {
    id: 'abuse-security-metadata',
    category: 'abuse_security_metadata',
    displayName: 'Abuse event log',
    description:
      'One row per rate-limit BLOCK: route, method, limiter key, salted IP fingerprint, retry-after metadata. Used by AbuseMonitorCard.',
    exampleFields: [
      'route',
      'method',
      'limiter_key',
      'ip_hash',
      'reason',
      'metadata',
    ],
    sources: [
      'public.abuse_events',
      'lib/enterprise/abuse-events.ts',
    ],
    sensitivity: 'restricted',
    purpose: 'Detect + investigate abusive traffic patterns.',
    operationalBasis: 'Security operations.',
    retentionBasis: 'security',
    defaultRetention: '365 days target; deletion restricted.',
    exportable: false,
    deletable: false,
    correctionSupported: false,
    vendorIds: ['supabase', 'upstash'],
    controlStatus: 'implemented',
    knownLimitations: [
      'Retention sweeper not yet implemented.',
    ],
    recommendedNext: [],
  },
  {
    id: 'sso-security-metadata',
    category: 'sso_security_metadata',
    displayName: 'SSO login event log',
    description:
      'One row per SSO initiate/callback: outcome (initiated/success/failed/blocked), reason, domain, salted IP fingerprint.',
    exampleFields: ['outcome', 'reason', 'domain', 'ip_hash'],
    sources: [
      'public.sso_login_events',
      'public.sso_connections',
    ],
    sensitivity: 'restricted',
    purpose: 'SSO posture + failure analysis.',
    operationalBasis: 'Security operations.',
    retentionBasis: 'security',
    defaultRetention: '365 days target; deletion restricted.',
    exportable: false,
    deletable: false,
    correctionSupported: false,
    vendorIds: ['supabase'],
    controlStatus: 'implemented',
    knownLimitations: [
      'Adapter is placeholder today (Phase 9G); real SAML/OIDC exchange not yet wired.',
    ],
    recommendedNext: [],
  },
  {
    id: 'incident-metadata',
    category: 'incident_metadata',
    displayName: 'Incident records + timeline + alert deliveries',
    description:
      'First-class incident records, append-only timeline events, and operator-triggered alert delivery attempts. NEVER stores webhook URLs or routing keys.',
    exampleFields: [
      'incident_id',
      'severity',
      'status',
      'category',
      'source',
      'message',
    ],
    sources: [
      'public.incidents',
      'public.incident_timeline_events',
      'public.incident_alert_deliveries',
      'lib/enterprise/incidents/*',
    ],
    sensitivity: 'restricted',
    purpose: 'Incident lifecycle + post-incident review evidence.',
    operationalBasis: 'Security + availability operations.',
    retentionBasis: 'security',
    defaultRetention: '365 days target; deletion restricted.',
    exportable: false,
    deletable: false,
    correctionSupported: false,
    vendorIds: ['supabase'],
    controlStatus: 'implemented',
    knownLimitations: [
      'Webhook URLs + routing keys NEVER stored — only operator-readable labels.',
    ],
    recommendedNext: [],
  },
  {
    id: 'vendor-metadata',
    category: 'vendor_metadata',
    displayName: 'Vendor risk registry',
    description:
      'Static in-code registry of every third-party processor: name, purpose, criticality, data categories, assurance status, review cadence. No PII.',
    exampleFields: [
      'vendor_id',
      'name',
      'disclosureStatus',
      'assuranceStatus',
    ],
    sources: ['lib/enterprise/vendor-risk/vendor-registry.ts'],
    sensitivity: 'low',
    purpose: 'Procurement + subprocessor disclosure.',
    operationalBasis: 'Procurement readiness.',
    retentionBasis: 'operational',
    defaultRetention: 'For the lifetime of the vendor relationship.',
    exportable: true,
    deletable: false,
    correctionSupported: true,
    vendorIds: [],
    controlStatus: 'implemented',
    knownLimitations: [],
    recommendedNext: [],
  },
  {
    id: 'support-metadata',
    category: 'support_metadata',
    displayName: 'Email + digest preferences + suppressions',
    description:
      'Operator digest cadence + suppression list + tour-action token state + tour notification delivery records.',
    exampleFields: [
      'recipient',
      'cadence',
      'suppression_reason',
      'unsubscribe_token',
    ],
    sources: [
      'public.digest_preferences',
      'public.digest_sends',
      'public.suppressions',
      'public.tour_notifications',
      'public.tour_action_tokens',
    ],
    sensitivity: 'moderate',
    purpose:
      'Honor operator digest preferences + suppression list + tour notification delivery.',
    operationalBasis:
      'Honor opt-outs; deliver operator-requested + tour-related email.',
    retentionBasis: 'customer_request',
    defaultRetention:
      'Suppression rows retained as long as needed to honor opt-out. Digest rows: 365 days target; audit retention sweep (Phase 8AA) prunes older rows.',
    exportable: true,
    deletable: false,
    correctionSupported: true,
    vendorIds: ['resend', 'supabase'],
    controlStatus: 'partial',
    knownLimitations: [
      'Resend retains its own delivery + bounce records per vendor policy.',
    ],
    recommendedNext: [],
  },
  {
    id: 'system-logs',
    category: 'system_logs',
    displayName: 'Application + infrastructure logs',
    description:
      'Structured pino logs (server) + Sentry error captures + Vercel platform logs (method, path, status, latency). No raw IPs are persisted in any application table.',
    exampleFields: ['request_id', 'route', 'status', 'latency_ms'],
    sources: [
      'lib/log.ts',
      'lib/observability/sentry.ts',
      'Vercel platform logs (out of band)',
    ],
    sensitivity: 'restricted',
    purpose: 'Operational debugging + error triage.',
    operationalBasis: 'Operations + security.',
    retentionBasis: 'security',
    defaultRetention:
      'Sentry + Vercel governed by vendor retention policy (downloaded per cadence). Application pino logs are stream-only and not persisted by VenueRise.',
    exportable: false,
    deletable: false,
    correctionSupported: false,
    vendorIds: ['sentry', 'deployment-host'],
    controlStatus: 'partial',
    knownLimitations: [
      'Sentry retention is governed by the vendor plan; review with platform team.',
      'Vercel infrastructure logs are governed by the deploy provider.',
    ],
    recommendedNext: [
      'Document Sentry retention setting alongside the privacy posture.',
    ],
  },
]
