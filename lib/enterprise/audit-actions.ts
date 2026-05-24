/**
 * Phase 9B — Enterprise audit action vocabulary.
 *
 * Central catalog of every `action` string that can land in
 * `public.audit_events`. Centralizing the strings:
 *
 *   1. Prevents typo drift ("lead_updated" vs "lead_update").
 *   2. Gives `scripts/check-audit-coverage.ts` a single import to
 *      reflect-list known actions.
 *   3. Lets the EnterpriseAuditEventsCard derive its action chips
 *      (future polish) from a typed registry rather than a hardcoded
 *      string list.
 *
 * ── ADOPTION POLICY ───────────────────────────────────────────────────────
 * Routes added or modified in Phase 9B+ MUST import from this module.
 * Existing routes from Phase 9A keep their literal strings to avoid
 * scope-creep; they're left until the file is next opened for an
 * unrelated change. The literal strings and the constants resolve to
 * the same UTF-8 sequences — there is no behavior delta.
 *
 * ── NAMING CONVENTION ─────────────────────────────────────────────────────
 *   ${noun}_${verb}             — single-row CRUD writes
 *   ${noun}_${qualifier}_${verb} — qualified actions
 *                                 (e.g. `lead_lost_reason_set`)
 *   ${noun}_${scope}_${verb}    — bulk / fan-out actions
 *                                 (e.g. `tours_bulk_cancel`)
 *
 * Lowercase. Snake_case. No spaces, no slashes, no camelCase.
 *
 * Constants are grouped by domain so a code-reviewer can scan the
 * list and immediately see "is there a lead-* action I'm missing?".
 */

export const AUDIT_ACTIONS = {
  // ── Lead writes ─────────────────────────────────────────────────────────
  LEAD_CREATE: 'lead_create',
  LEAD_UPDATE: 'lead_update',
  LEAD_DELETE: 'lead_delete',
  LEAD_LOST_REASON_SET: 'lead_lost_reason_set',

  // ── Tour writes ─────────────────────────────────────────────────────────
  TOUR_CREATE: 'tour_create',
  TOUR_UPDATE: 'tour_update',
  TOUR_CONFIRM: 'tour_confirm',
  TOUR_CANCEL: 'tour_cancel',
  TOUR_RESCHEDULE: 'tour_reschedule',
  TOURS_BULK_CANCEL: 'tours_bulk_cancel',
  TOURS_PAUSE_CLEAR: 'tours_pause_clear',

  // ── Venue + settings writes ─────────────────────────────────────────────
  VENUE_UPDATE: 'venue_update',
  AVAILABILITY_CREATE: 'availability_create',
  AVAILABILITY_UPDATE: 'availability_update',
  AVAILABILITY_DELETE: 'availability_delete',
  TOUR_BLACKOUT_CREATE: 'tour_blackout_create',
  TOUR_BLACKOUT_DELETE: 'tour_blackout_delete',
  REVENUE_OS_SETTINGS_UPDATE: 'revenue_os_settings_update',
  // ── Knowledge base writes (Phase 9T-alt) ────────────────────────────────
  // Operator-edited rows the AI orchestrator reads at conversation time.
  // We log title / category / length / boolean is_active to the audit row;
  // full content is NOT mirrored — operators are warned via UI copy to keep
  // secrets out, and the audit feed is admin-readable.
  KNOWLEDGE_ENTRY_CREATED: 'knowledge_entry_created',
  KNOWLEDGE_ENTRY_UPDATED: 'knowledge_entry_updated',
  KNOWLEDGE_ENTRY_DELETED: 'knowledge_entry_deleted',
  KNOWLEDGE_ENTRY_TOGGLED: 'knowledge_entry_toggled',

  // ── GTM-0A Revenue Recovery Demo seed ───────────────────────────────────
  // Tagged demo dataset for sales/pilot setup. Separate from the legacy
  // `demo_seed` action so admins can tell the rich Revenue Recovery
  // dataset apart from the original Phase 8A fixture set in the audit
  // feed. Cleanup matches by `metadata.demo_seed = true` only — never
  // touches real venue data.
  REVENUE_RECOVERY_DEMO_SEEDED: 'revenue_recovery_demo_seeded',

  // ── GTM-0A.2 Revenue Recovery LOAD/STRESS Demo seed ─────────────────────
  // Sibling to REVENUE_RECOVERY_DEMO_SEEDED. Tagged separately so
  // the audit feed clearly distinguishes a 250-1000 lead load run
  // from the 24-lead hand-crafted demo. Reset matches `demo_seed_type
  // = 'load'` AND `demo_seed_version = 'gtm_0a_2'` only — never
  // touches GTM-0A hand-crafted rows.
  REVENUE_RECOVERY_LOAD_DEMO_SEEDED: 'revenue_recovery_load_demo_seeded',

  // ── AI safety + autopilot review writes ─────────────────────────────────
  AI_ACTION_REJECT: 'ai_action_reject',
  AI_DRAFT_GENERATE: 'ai_draft_generate',
  AUTOPILOT_REVIEW_LABEL: 'autopilot_review_label',

  // ── Conversation message writes ─────────────────────────────────────────
  OPERATOR_MESSAGE_SEND: 'operator_message_send',

  // ── Phase 8BP — email delivery lifecycle (per-message) ──────────────────
  // Retry actions are recorded on the messages row that owned the
  // original send. Manual fallback flips delivery_status without
  // claiming external delivery.
  EMAIL_DELIVERY_RETRY_ATTEMPTED: 'email_delivery_retry_attempted',
  EMAIL_DELIVERY_RETRY_SUCCEEDED: 'email_delivery_retry_succeeded',
  EMAIL_DELIVERY_RETRY_FAILED: 'email_delivery_retry_failed',
  EMAIL_DELIVERY_MANUAL_FALLBACK_MARKED: 'email_delivery_manual_fallback_marked',

  // ── Digest writes ───────────────────────────────────────────────────────
  DIGEST_PREFERENCES_UPDATE: 'digest_preferences_update',
  DIGEST_MANUAL_SEND: 'digest_manual_send',
  DIGEST_PREVIEW_SEND: 'digest_preview_send',

  // ── Suppression writes ──────────────────────────────────────────────────
  SUPPRESSION_ADD_MANUAL: 'suppression_add_manual',
  DIGEST_SUPPRESSION_REMOVE: 'digest_suppression_remove',
  DIGEST_SUPPRESSION_REMOVE_NOOP: 'digest_suppression_remove_noop',
  DIGEST_SUPPRESSION_REMOVE_ALL: 'digest_suppression_remove_all',

  // ── Billing writes ──────────────────────────────────────────────────────
  BILLING_CHECKOUT_SESSION_CREATE: 'billing_checkout_session_create',
  BILLING_PORTAL_SESSION_CREATE: 'billing_portal_session_create',
  BILLING_EVENT_CLEAR_DUNNING: 'billing_event_clear_dunning',
  BILLING_EVENT_REPLAY: 'billing_event_replay',

  // ── Team / RBAC writes ──────────────────────────────────────────────────
  TEAM_INVITATION_CREATE: 'team_invitation_create',
  TEAM_INVITATION_REVOKE: 'team_invitation_revoke',
  TEAM_INVITATION_ACCEPT: 'team_invitation_accept',
  TEAM_MEMBER_REMOVE: 'team_member_remove',
  TEAM_MEMBER_ROLE_UPDATE: 'team_member_role_update',

  // ── Onboarding writes ───────────────────────────────────────────────────
  WORKSPACE_CREATE: 'workspace_create',

  // ── Admin operations / diagnostics ──────────────────────────────────────
  DEMO_SEED: 'demo_seed',
  DEMO_RESET: 'demo_reset',
  ADMIN_TEST_SEND: 'admin_test_send',

  // ── Data lifecycle (Phase 9D) ───────────────────────────────────────────
  DATA_EXPORT_REQUESTED: 'data_export_requested',
  LEAD_PII_REDACTED: 'lead_pii_redacted',

  // ── SSO readiness (Phase 9G) ────────────────────────────────────────────
  SSO_CONNECTION_CREATE: 'sso_connection_create',
  SSO_CONNECTION_UPDATE: 'sso_connection_update',
  SSO_CONNECTION_DELETE: 'sso_connection_delete',

  // ── Disaster recovery (Phase 9H — audit only, NEVER executes restore) ──
  RESTORE_INTENT_RECORDED: 'restore_intent_recorded',
  RESTORE_INTENT_CANCELLED: 'restore_intent_cancelled',
  RESTORE_COMPLETED_OUTSIDE_APP: 'restore_completed_outside_app',

  // ── Evidence packaging (Phase 9I) ───────────────────────────────────────
  EVIDENCE_REPORT_EXPORTED: 'evidence_report_exported',
  EVIDENCE_PACK_GENERATED: 'evidence_pack_generated',

  // ── Sales readiness (Phase 9J) ──────────────────────────────────────────
  QUESTIONNAIRE_RESPONSE_EXPORTED: 'questionnaire_response_exported',
  BUYER_SECURITY_SUMMARY_EXPORTED: 'buyer_security_summary_exported',
  DEMO_MODE_UPDATED: 'demo_mode_updated',

  // ── Vendor risk + subprocessor disclosure (Phase 9K) ────────────────────
  VENDOR_RISK_REPORT_EXPORTED: 'vendor_risk_report_exported',
  SUBPROCESSOR_DISCLOSURE_EXPORTED: 'subprocessor_disclosure_exported',

  // ── Incident response (Phase 9L) ────────────────────────────────────────
  INCIDENT_CREATED: 'incident_created',
  INCIDENT_UPDATED: 'incident_updated',
  INCIDENT_RESOLVED: 'incident_resolved',
  INCIDENT_ALERT_SENT: 'incident_alert_sent',
  INCIDENT_REPORT_EXPORTED: 'incident_report_exported',
  INCIDENT_CANDIDATES_DETECTED: 'incident_candidates_detected',

  // ── Privacy + DSR readiness (Phase 9M) ──────────────────────────────────
  PRIVACY_READINESS_EXPORTED: 'privacy_readiness_exported',
  DSR_REPORT_EXPORTED: 'dsr_report_exported',
  DSR_REQUEST_CREATED: 'dsr_request_created',
  DSR_REQUEST_UPDATED: 'dsr_request_updated',
  DSR_REQUEST_FULFILLED: 'dsr_request_fulfilled',
  DSR_REQUEST_DENIED: 'dsr_request_denied',
  DSR_REQUEST_CANCELLED: 'dsr_request_cancelled',
  DSR_EXPORT_PREVIEWED: 'dsr_export_previewed',
  DSR_DELETION_REVIEWED: 'dsr_deletion_reviewed',

  // ── Trust Center foundation (Phase 9N) ──────────────────────────────────
  TRUST_ACCESS_GRANT_CREATED: 'trust_access_grant_created',
  TRUST_ACCESS_GRANT_UPDATED: 'trust_access_grant_updated',
  TRUST_ACCESS_GRANT_REVOKED: 'trust_access_grant_revoked',
  TRUST_ACCESS_EVENTS_EXPORTED: 'trust_access_events_exported',
  TRUST_PACKET_EXPORTED: 'trust_packet_exported',
  TRUST_ARTIFACT_DOWNLOADED: 'trust_artifact_downloaded',

  // ── Compliance ops calendar (Phase 9O) ──────────────────────────────────
  COMPLIANCE_CALENDAR_EXPORTED: 'compliance_calendar_exported',
  COMPLIANCE_EVENTS_SEEDED: 'compliance_events_seeded',
  COMPLIANCE_REVIEW_CREATED: 'compliance_review_created',
  COMPLIANCE_REVIEW_COMPLETED: 'compliance_review_completed',
  COMPLIANCE_REVIEW_WAIVED: 'compliance_review_waived',
  COMPLIANCE_REVIEW_UPDATED: 'compliance_review_updated',
  COMPLIANCE_FRESHNESS_EXPORTED: 'compliance_freshness_exported',

  // ── Contract commitments register (Phase 9P) ────────────────────────────
  COMMITMENT_CREATED: 'commitment_created',
  COMMITMENT_UPDATED: 'commitment_updated',
  COMMITMENT_STATUS_CHANGED: 'commitment_status_changed',
  COMMITMENT_FULFILLED: 'commitment_fulfilled',
  COMMITMENT_REVIEWED: 'commitment_reviewed',
  COMMITMENTS_EXPORTED: 'commitments_exported',
  COMMITMENTS_READINESS_EXPORTED: 'commitments_readiness_exported',

  // ── Omnichannel inbox connector foundation (Phase 8BE) ──────────────────
  CHANNEL_CONNECTION_CREATED: 'channel_connection_created',
  CHANNEL_CONNECTION_UPDATED: 'channel_connection_updated',
  CHANNEL_REPLY_MARKED_SENT_MANUALLY: 'channel_reply_marked_sent_manually',

  // ── Lead-forwarding parser (Phase 8BG) ──────────────────────────────────
  LEAD_FORWARDING_TEST_PARSE: 'lead_forwarding_test_parse',

  // ── Meta / Instagram / Facebook connector (Phase 8BF) ───────────────────
  META_WEBHOOK_TEST_PARSE: 'meta_webhook_test_parse',

  // ── Lead-side tour confirmation links (Phase 8BL) ──────────────────────
  // Recorded by app/api/tour/confirm-slot/[token]/route.ts after a
  // lead clicks a confirmation link and we successfully:
  //   (a) win the single-use claim on the token row,
  //   (b) re-check the slot is still available, and
  //   (c) insert the tours row.
  // metadata.outcome distinguishes the success path from the
  // post-claim tour-insert failure path; the audit row is written
  // in both cases so a tracker can correlate redemption attempts
  // against created tours.
  // actor_kind is 'system' (no operator clicked anything); the
  // route is anonymous + token-authenticated.
  TOUR_CONFIRMED_BY_PUBLIC_LINK: 'tour_confirmed_by_public_link',

  // ── Meta OAuth (Phase GTM-Meta-OAuth) ──────────────────────────────────
  // Distinct from `channel_connection_created` (the operator-typed
  // manual connection row). These cover the OAuth-flow side: an
  // operator initiated the Facebook OAuth dialog, came back from
  // Meta with a code, exchanged it for tokens, and successfully
  // (or unsuccessfully) persisted the long-lived Page Access Token
  // in `meta_oauth_tokens`. Audit metadata records: scopes granted,
  // page_ids connected, ig_business_account_ids — NEVER tokens.
  CHANNEL_META_OAUTH_INITIATED: 'channel_meta_oauth_initiated',
  CHANNEL_META_OAUTH_CONNECTED: 'channel_meta_oauth_connected',
  CHANNEL_META_OAUTH_FAILED:    'channel_meta_oauth_failed',
  CHANNEL_META_OAUTH_REVOKED:   'channel_meta_oauth_revoked',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]

/**
 * Sentinel comment markers the audit-coverage scanner recognizes as
 * an explicit opt-out. Use the matching helper string in a route
 * comment when the route deliberately does NOT write an audit row.
 * The scanner uses these as anchor strings (case-insensitive
 * substring match), not actual runtime values.
 *
 * Conventions:
 *   - `AUDIT_EXEMPT: <reason>`  — generic exemption
 *   - `// public route`         — anonymous endpoint (no actor)
 *   - `// webhook route`        — upstream provider callback
 */
export const AUDIT_COVERAGE_MARKERS = {
  EXEMPT: 'AUDIT_EXEMPT',
  PUBLIC: 'public route',
  WEBHOOK: 'webhook route',
} as const
