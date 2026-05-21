# VenueRise Privacy Readiness

_Generated: 2026-05-20T18:29:52.428Z_

> Privacy readiness is not a legal compliance attestation. VenueRise does NOT claim GDPR / CCPA / LGPD compliance in this automated summary. Operator + counsel review is required before any external claim. DSRs are tracked, NOT auto-fulfilled. Export preview is metadata-only. Deletion review is non-destructive.

## Summary

- Total data categories: **15**
- High/restricted sensitivity: **8**
- Export-ready: **9**
- Deletion-ready: **5**
- Retention policy rows: **15**

## Data inventory

### Operator account identity

- **Category**: account_identity
- **Sensitivity**: moderate
- **Retention basis**: operational
- **Default retention**: Until tenant ends subscription + 30-day grace.
- **Exportable**: yes · **Deletable**: yes · **Correction**: yes
- **Control status**: implemented
- **Subprocessors**: supabase

Operator user accounts that sign in to manage a venue. Includes auth identifiers and basic profile fields.

Sources:
- auth.users (Supabase)
- public.venue_members (role + venue link)

Known limitations:
- Account deletion deletes the auth row + cascades venue_members; downstream data (leads, conversations) follows the venue\'s separate deletion workflow.

### Venue profile + settings

- **Category**: venue_profile
- **Sensitivity**: low
- **Retention basis**: operational
- **Default retention**: For the lifetime of the tenant.
- **Exportable**: yes · **Deletable**: yes · **Correction**: yes
- **Control status**: implemented
- **Subprocessors**: supabase

Venue name, branding, availability, blackouts, tour duration, RevenueOS settings, demo-mode flags, and tenant-level configuration.

Sources:
- public.venues
- public.tour_blackouts
- public.availability_slots

### Lead contact identity

- **Category**: lead_contact
- **Sensitivity**: high
- **Retention basis**: operational
- **Default retention**: Until the operator marks the lead lost + the reactivation window closes (default 90 days). Lead-level PII redaction is operator-triggered.
- **Exportable**: yes · **Deletable**: yes · **Correction**: yes
- **Control status**: partial
- **Subprocessors**: supabase, anthropic

Personal contact details for the inquiring couple: name, email, phone, optional notes provided via the widget.

Sources:
- public.leads
- app/api/widget/route.ts (intake)
- app/api/admin/leads/[leadId]/redact-pii/route.ts (soft redaction)

Known limitations:
- No customer-facing self-service deletion flow today — DSR workflow is operator-routed.
- Anthropic processes lead text for qualification + drafting; vendor retention terms require legal verification.

### Lead event details

- **Category**: lead_event_details
- **Sensitivity**: moderate
- **Retention basis**: operational
- **Default retention**: Mirrors lead_contact retention.
- **Exportable**: yes · **Deletable**: yes · **Correction**: yes
- **Control status**: partial
- **Subprocessors**: supabase, anthropic

Event-specific fields submitted by the lead: event date, guest count, budget, message, lost-reason metadata.

Sources:
- public.leads (metadata jsonb)

Known limitations:
- Free-text `message` may carry incidental PII the lead chose to volunteer; redaction is operator-triggered.

### Conversation messages

- **Category**: conversation_content
- **Sensitivity**: high
- **Retention basis**: operational
- **Default retention**: For the lifetime of the lead row; redaction is operator-triggered and CURRENTLY lead-level only (no conversation-level redaction yet).
- **Exportable**: yes · **Deletable**: no · **Correction**: no
- **Control status**: partial
- **Subprocessors**: supabase, anthropic, resend

Inbound + outbound message bodies + drafts + AI variant snapshots between operator and lead.

Sources:
- public.messages
- public.conversations
- public.ai_actions (drafts + variant metadata)
- app/api/ai/draft/route.ts

Known limitations:
- No conversation-level PII redaction; lead-level redaction leaves message bodies intact.
- Outbound replies are sent via Resend; delivery metadata is retained there per vendor policy.
- AI drafting sends inbound message context to Anthropic for inference.

### Tour scheduling data

- **Category**: tour_scheduling
- **Sensitivity**: moderate
- **Retention basis**: operational
- **Default retention**: Mirrors lead retention; tokens auto-expire.
- **Exportable**: yes · **Deletable**: yes · **Correction**: yes
- **Control status**: implemented
- **Subprocessors**: supabase, resend

Tour bookings, confirmation status, notification deliveries, and tour-action token usage.

Sources:
- public.tours
- public.tour_status_events
- public.tour_notifications
- public.tour_action_tokens

### Billing + subscription metadata

- **Category**: billing_metadata
- **Sensitivity**: moderate
- **Retention basis**: billing
- **Default retention**: For the lifetime of the subscription + applicable financial/tax retention requirements.
- **Exportable**: yes · **Deletable**: no · **Correction**: no
- **Control status**: implemented
- **Subprocessors**: stripe, supabase

Stripe customer / subscription / invoice identifiers + status. Card data is captured by Stripe directly and never reaches VenueRise.

Sources:
- public.venues (stripe_customer_id, stripe_subscription_id)
- public.billing_events
- app/api/billing/checkout/route.ts
- app/api/billing/portal/route.ts
- app/api/stripe/webhook/route.ts

Known limitations:
- Stripe retains its own customer + invoice record per its own policy; deletion in VenueRise does not delete the Stripe-side record.

### Authentication + session metadata

- **Category**: auth_security_metadata
- **Sensitivity**: restricted
- **Retention basis**: security
- **Default retention**: For the duration of the active session / invitation window. Tokens are single-use or short-lived.
- **Exportable**: no · **Deletable**: no · **Correction**: no
- **Control status**: implemented
- **Subprocessors**: supabase

Session tokens (server-managed), refresh tokens, SSO connection state, and team-invitation tokens. Token VALUES are never returned in any response after issuance.

Sources:
- auth.sessions (Supabase)
- public.sso_connections
- public.team_invitations

Known limitations:
- Cannot be exported via DSR — exporting active session/SSO tokens would itself be a security incident.

### Audit event log

- **Category**: audit_metadata
- **Sensitivity**: restricted
- **Retention basis**: security
- **Default retention**: 365 days target; deletion is restricted because the log may be required for security or legal review.
- **Exportable**: no · **Deletable**: no · **Correction**: no
- **Control status**: implemented
- **Subprocessors**: supabase

Structured row per sensitive write: actor identity, route, action, before/after sanitized snapshots, salted-SHA-256 IP fingerprint, request id correlation.

Sources:
- public.audit_events
- public.audit_event_mirror (tamper-evidence; Phase 9C)
- lib/enterprise/audit-events.ts

Known limitations:
- No automated retention sweeper today; rows currently accumulate. Phase 9M reserves retention enforcement for a future phase per the retention policy table.
- Raw IPs never stored — only the salted-SHA-256 fingerprint via maskIpForAudit.

### Abuse event log

- **Category**: abuse_security_metadata
- **Sensitivity**: restricted
- **Retention basis**: security
- **Default retention**: 365 days target; deletion restricted.
- **Exportable**: no · **Deletable**: no · **Correction**: no
- **Control status**: implemented
- **Subprocessors**: supabase, upstash

One row per rate-limit BLOCK: route, method, limiter key, salted IP fingerprint, retry-after metadata. Used by AbuseMonitorCard.

Sources:
- public.abuse_events
- lib/enterprise/abuse-events.ts

Known limitations:
- Retention sweeper not yet implemented.

### SSO login event log

- **Category**: sso_security_metadata
- **Sensitivity**: restricted
- **Retention basis**: security
- **Default retention**: 365 days target; deletion restricted.
- **Exportable**: no · **Deletable**: no · **Correction**: no
- **Control status**: implemented
- **Subprocessors**: supabase

One row per SSO initiate/callback: outcome (initiated/success/failed/blocked), reason, domain, salted IP fingerprint.

Sources:
- public.sso_login_events
- public.sso_connections

Known limitations:
- Adapter is placeholder today (Phase 9G); real SAML/OIDC exchange not yet wired.

### Incident records + timeline + alert deliveries

- **Category**: incident_metadata
- **Sensitivity**: restricted
- **Retention basis**: security
- **Default retention**: 365 days target; deletion restricted.
- **Exportable**: no · **Deletable**: no · **Correction**: no
- **Control status**: implemented
- **Subprocessors**: supabase

First-class incident records, append-only timeline events, and operator-triggered alert delivery attempts. NEVER stores webhook URLs or routing keys.

Sources:
- public.incidents
- public.incident_timeline_events
- public.incident_alert_deliveries
- lib/enterprise/incidents/*

Known limitations:
- Webhook URLs + routing keys NEVER stored — only operator-readable labels.

### Vendor risk registry

- **Category**: vendor_metadata
- **Sensitivity**: low
- **Retention basis**: operational
- **Default retention**: For the lifetime of the vendor relationship.
- **Exportable**: yes · **Deletable**: no · **Correction**: yes
- **Control status**: implemented
- **Subprocessors**: none

Static in-code registry of every third-party processor: name, purpose, criticality, data categories, assurance status, review cadence. No PII.

Sources:
- lib/enterprise/vendor-risk/vendor-registry.ts

### Email + digest preferences + suppressions

- **Category**: support_metadata
- **Sensitivity**: moderate
- **Retention basis**: customer_request
- **Default retention**: Suppression rows retained as long as needed to honor opt-out. Digest rows: 365 days target; audit retention sweep (Phase 8AA) prunes older rows.
- **Exportable**: yes · **Deletable**: no · **Correction**: yes
- **Control status**: partial
- **Subprocessors**: resend, supabase

Operator digest cadence + suppression list + tour-action token state + tour notification delivery records.

Sources:
- public.digest_preferences
- public.digest_sends
- public.suppressions
- public.tour_notifications
- public.tour_action_tokens

Known limitations:
- Resend retains its own delivery + bounce records per vendor policy.

### Application + infrastructure logs

- **Category**: system_logs
- **Sensitivity**: restricted
- **Retention basis**: security
- **Default retention**: Sentry + Vercel governed by vendor retention policy (downloaded per cadence). Application pino logs are stream-only and not persisted by VenueRise.
- **Exportable**: no · **Deletable**: no · **Correction**: no
- **Control status**: partial
- **Subprocessors**: sentry, deployment-host

Structured pino logs (server) + Sentry error captures + Vercel platform logs (method, path, status, latency). No raw IPs are persisted in any application table.

Sources:
- lib/log.ts
- lib/observability/sentry.ts
- Vercel platform logs (out of band)

Known limitations:
- Sentry retention is governed by the vendor plan; review with platform team.
- Vercel infrastructure logs are governed by the deploy provider.

## Retention policy

### account_identity

- **Default window**: For the lifetime of the subscription + 30-day grace after cancellation.
- **Reason**: Tenant operator continuity + reactivation window.
- **Deletion behaviour**: Operator-initiated via Supabase auth + cascading venue_members removal. DSR workflow tracks the request.
- **Export behaviour**: Operator export via /api/admin/data-export (Phase 9D) returns venue-scoped JSON.
- **Automation status**: manual

Exceptions:
- Active subscription with outstanding invoice → defer until billing settled.

### venue_profile

- **Default window**: For the lifetime of the tenant.
- **Reason**: Required to operate the tenant dashboard.
- **Deletion behaviour**: Removed when the tenant is deleted; demo-mode flag is a visual marker only and does NOT anonymize.
- **Export behaviour**: Included in operator data export.
- **Automation status**: manual

### lead_contact

- **Default window**: 90 days after the lead is marked lost (reactivation window) by default; operator-configurable in a future phase.
- **Reason**: Operational lead pipeline + reactivation analytics.
- **Deletion behaviour**: Lead-level soft redaction via /api/admin/leads/[leadId]/redact-pii (Phase 9D). Anonymizes name/email/phone/notes while preserving conversations/tours/audit lineage.
- **Export behaviour**: Included in operator data export.
- **Automation status**: partial

Exceptions:
- Open booking with billing impact → retain until resolved.
- Active DSR → retain until DSR is closed.

### lead_event_details

- **Default window**: Mirrors lead_contact.
- **Reason**: Operational analytics + RevenueOS leakage signals.
- **Deletion behaviour**: Cascades with lead redaction.
- **Export behaviour**: Included in operator data export.
- **Automation status**: partial

### conversation_content

- **Default window**: Mirrors lead_contact.
- **Reason**: Operator review + AI calibration history.
- **Deletion behaviour**: Lead-level redaction does NOT remove conversation bodies today. Conversation-level redaction is on the planned-improvements list.
- **Export behaviour**: Included in operator data export.
- **Automation status**: partial

Exceptions:
- Pending DSR requests → message bodies retained until reviewed.

### tour_scheduling

- **Default window**: Mirrors lead retention; tokens auto-expire.
- **Reason**: Operational calendar.
- **Deletion behaviour**: Cascades with lead deletion. Tour-action tokens are single-use and auto-expire.
- **Export behaviour**: Included in operator data export.
- **Automation status**: partial

### billing_metadata

- **Default window**: For the lifetime of the subscription + applicable financial/tax retention requirements (multi-year typical).
- **Reason**: Billing reconciliation + statutory financial retention.
- **Deletion behaviour**: Not deleted from VenueRise during normal lifecycle. Stripe retains its own customer + invoice records per Stripe policy.
- **Export behaviour**: Billing-events export is admin-readable; raw invoice PDFs are downloaded from Stripe directly.
- **Automation status**: manual

Exceptions:
- Statutory financial retention overrides DSR deletion until the window passes.

### auth_security_metadata

- **Default window**: For the duration of the active session / invitation. Tokens are single-use or short-lived.
- **Reason**: Security access control.
- **Deletion behaviour**: Sessions expire automatically; SSO connections are deleted via owner-only mutation.
- **Export behaviour**: NOT exported. Returning live session/SSO tokens would itself be a security incident.
- **Automation status**: implemented

### audit_metadata

- **Default window**: 365 days target. No automated sweeper today; rows currently accumulate.
- **Reason**: Security investigation + tamper evidence.
- **Deletion behaviour**: Deletion is restricted. Audit rows may be required for legal/security review. Operator + legal review on a per-request basis.
- **Export behaviour**: Not directly exportable via DSR. Aggregate audit export is admin-readable via /api/admin/audit-events.
- **Automation status**: manual

Exceptions:
- Legal hold → retain past the window.
- Active incident or DSR → retain until closed.

### abuse_security_metadata

- **Default window**: 365 days target.
- **Reason**: Detect repeat abusive patterns.
- **Deletion behaviour**: Deletion is restricted. Operator + legal review per request.
- **Export behaviour**: NOT exportable to subjects; admin-readable for ops.
- **Automation status**: manual

Exceptions:
- Active investigation → retain until closed.

### sso_security_metadata

- **Default window**: 365 days target.
- **Reason**: SSO failure pattern analysis.
- **Deletion behaviour**: Deletion is restricted. Operator + legal review per request.
- **Export behaviour**: NOT exportable to subjects; admin-readable for ops.
- **Automation status**: manual

### incident_metadata

- **Default window**: 365 days target.
- **Reason**: Security + availability incident history; post-incident review evidence.
- **Deletion behaviour**: Restricted. Incident records may be required for security / compliance audits.
- **Export behaviour**: NOT exportable to subjects; admin-readable.
- **Automation status**: manual

### vendor_metadata

- **Default window**: For the lifetime of the vendor relationship.
- **Reason**: Subprocessor disclosure + procurement readiness.
- **Deletion behaviour**: Operator removes a vendor row when the relationship ends.
- **Export behaviour**: Exportable via /api/admin/security/vendor-risk-report (admin) + /api/admin/security/subprocessor-disclosure (buyer-safe).
- **Automation status**: manual

### support_metadata

- **Default window**: Suppressions retained as long as needed to honor opt-out. Digest send rows: 365-day target, with the Phase 8AA retention sweeper pruning archived rows.
- **Reason**: Honor opt-out commitments + operator visibility into recent digests.
- **Deletion behaviour**: Suppressions only removed when the operator explicitly resubscribes (Phase 8AA). Digest rows pruned by the existing weekly sweeper.
- **Export behaviour**: Admin-readable via digest preferences/sends APIs.
- **Automation status**: implemented

### system_logs

- **Default window**: Vendor-governed. Application pino logs are stream-only (not persisted by VenueRise).
- **Reason**: Operational debugging + error triage.
- **Deletion behaviour**: Sentry + Vercel retention is set in the vendor dashboard. Application pino logs disappear with the runtime.
- **Export behaviour**: Sentry events are exportable from the Sentry dashboard. Vercel logs from the Vercel dashboard.
- **Automation status**: partial
