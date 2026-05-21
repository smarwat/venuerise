# VenueRise Vendor Risk Report

_Generated: 2026-05-20T18:29:52.119Z_

> This disclosure is for security review and procurement support. It is not legal advice or a contractual representation. Vendor SOC 2, DPA, SCC, and ISO posture must be verified against the vendor's current evidence before relying on any contractual commitment. Operators MUST review before sending to a buyer.

## Summary

- Total vendors: **11**
- Production runtime: **8**
- Critical: **4**
- Manual-review-required: **10**
- Unknown assurance: **0**
- Public-disclosable: **8**

## Vendors

### Supabase

- **Category**: Database, auth, storage, realtime
- **Purpose**: Primary application database (Postgres), authentication, row-level security enforcement, storage, and realtime channels.
- **Criticality**: critical
- **Disclosure**: public
- **Risk tier**: high
- **Assurance status**: manual_review_required
- **Production use**: yes
- **Data categories**: account_data, lead_data, message_content, authentication_data, audit_metadata, billing_data
- **Review owner**: platform
- **Review cadence**: annually + on plan change
- **Last reviewed**: never (registry default)

**Buyer-safe description**

Hosts the application database, user authentication, and file storage. Data is encrypted at rest (AES-256) and in transit (TLS). Access is RLS-gated; service-role credentials are used only by trusted server code.

**Evidence references**

- `package`: @supabase/supabase-js
- `package`: @supabase/ssr
- `env`: NEXT_PUBLIC_SUPABASE_URL
- `env`: NEXT_PUBLIC_SUPABASE_ANON_KEY
- `env`: SUPABASE_SERVICE_ROLE_KEY
- `env`: SUPABASE_PROJECT_REF
- `env`: SUPABASE_ACCESS_TOKEN
- `doc`: docs/DISASTER-RECOVERY.md
- `doc`: docs/RUNBOOK.md — Secrets rotation

**Known limitations**

- DPA + SOC 2 report must be downloaded from Supabase dashboard and retained outside this repo.
- Live PITR verification requires the Management API env vars (Phase 9H).

### Anthropic

- **Category**: AI model provider
- **Purpose**: LLM inference for lead qualification, brand-voice drafting, autopilot simulation, and operator-approved customer reply drafting.
- **Criticality**: critical
- **Disclosure**: public
- **Risk tier**: high
- **Assurance status**: manual_review_required
- **Production use**: yes
- **Data categories**: lead_data, message_content
- **Review owner**: security
- **Review cadence**: annually + on contract change
- **Last reviewed**: never (registry default)

**Buyer-safe description**

Generates draft replies + lead qualification signals. Lead inquiry text and conversation context are sent to the Anthropic API for inference; outputs return as drafts that require explicit operator approval before sending (no autonomous send path).

**Evidence references**

- `package`: @anthropic-ai/sdk
- `env`: ANTHROPIC_API_KEY
- `file`: lib/anthropic.ts
- `doc`: docs/AGENTIC-WORKFLOW-MAP.md
- `note`: Autonomous sending is explicitly disabled — see `autonomous_sending_still_disabled` health flag.

**Known limitations**

- DPA terms + zero-retention configuration must be confirmed with Anthropic on the active plan.
- No automated PII scrubbing on outbound payloads — operators rely on lead data minimisation upstream.

### Stripe

- **Category**: Billing + subscriptions
- **Purpose**: Subscription billing, hosted checkout, customer portal, and payment method storage. Authoritative source for subscription + invoice state.
- **Criticality**: critical
- **Disclosure**: public
- **Risk tier**: high
- **Assurance status**: manual_review_required
- **Production use**: yes
- **Data categories**: billing_data, account_data
- **Review owner**: finance
- **Review cadence**: annually
- **Last reviewed**: never (registry default)

**Buyer-safe description**

Processes subscription payments. Card data is captured directly by Stripe and never reaches VenueRise systems; only Stripe customer/subscription/invoice ids and metadata are stored.

**Evidence references**

- `package`: stripe
- `env`: STRIPE_SECRET_KEY
- `env`: STRIPE_WEBHOOK_SECRET
- `route`: /api/stripe/webhook
- `doc`: docs/RUNBOOK.md — Stripe webhook posture

**Known limitations**

- Stripe SOC 1/2 + PCI DSS attestations are downloadable from the Stripe dashboard; not mirrored in this repo.

### Resend

- **Category**: Transactional email delivery
- **Purpose**: Delivers operator-triggered transactional email (tour notifications, digests, operator-approved replies). Webhook returns delivery + bounce + complaint signals to the application.
- **Criticality**: important
- **Disclosure**: public
- **Risk tier**: medium
- **Assurance status**: manual_review_required
- **Production use**: yes
- **Data categories**: email_metadata, message_content, lead_data
- **Review owner**: platform
- **Review cadence**: annually
- **Last reviewed**: never (registry default)

**Buyer-safe description**

Sends outbound email. Recipient addresses and message bodies are transmitted to Resend for delivery; bounce/complaint signals feed back into the in-app suppression list.

**Evidence references**

- `package`: resend
- `env`: RESEND_API_KEY
- `env`: RESEND_WEBHOOK_SECRET
- `file`: lib/integrations/email.ts
- `route`: /api/resend/webhook

**Known limitations**

- No customer-facing self-service unsubscribe page beyond the existing digest token route.

### Upstash

- **Category**: Rate-limit cache (Redis-compatible)
- **Purpose**: Sliding-window rate-limit counters for every mutating + sensitive admin endpoint, abuse-monitor counters, and SSO limiter state.
- **Criticality**: important
- **Disclosure**: public
- **Risk tier**: low
- **Assurance status**: manual_review_required
- **Production use**: yes
- **Data categories**: usage_metadata
- **Review owner**: platform
- **Review cadence**: annually
- **Last reviewed**: never (registry default)

**Buyer-safe description**

Stores short-lived rate-limit counters. Holds a salted-SHA-256 IP fingerprint and per-route bucket counts; no customer payload data is stored.

**Evidence references**

- `package`: @upstash/ratelimit
- `package`: @upstash/redis
- `env`: UPSTASH_REDIS_REST_URL
- `env`: UPSTASH_REDIS_REST_TOKEN
- `file`: lib/rate-limit.ts
- `doc`: docs/RATE-LIMIT-COVERAGE.md

**Known limitations**

- Counters are short-lived but the limiter key itself includes a fingerprint — never a raw IP.

### Inngest

- **Category**: Background jobs + scheduled tasks
- **Purpose**: Schedules and dispatches background work: operator digest fan-out, retention sweeps, backfill jobs, tour notification follow-ups.
- **Criticality**: important
- **Disclosure**: public
- **Risk tier**: medium
- **Assurance status**: manual_review_required
- **Production use**: yes
- **Data categories**: usage_metadata, audit_metadata
- **Review owner**: platform
- **Review cadence**: annually
- **Last reviewed**: never (registry default)

**Buyer-safe description**

Coordinates background jobs. Event payloads include lead/tour identifiers and job metadata; job results are written back to the application database. Customer message content is fetched server-side per job, not stored at the orchestrator.

**Evidence references**

- `package`: inngest
- `env`: INNGEST_EVENT_KEY
- `env`: INNGEST_SIGNING_KEY
- `route`: /api/inngest
- `file`: lib/jobs/client.ts

**Known limitations**

- Event payloads should not include raw lead PII beyond what is needed to refetch the row.

### Vercel

- **Category**: Hosting + serverless runtime
- **Purpose**: Hosts the Next.js application, terminates TLS, dispatches serverless route handlers, and serves static assets + the public widget.
- **Criticality**: critical
- **Disclosure**: public
- **Risk tier**: high
- **Assurance status**: manual_review_required
- **Production use**: yes
- **Data categories**: infrastructure_logs, usage_metadata
- **Review owner**: platform
- **Review cadence**: annually + on deploy provider change
- **Last reviewed**: never (registry default)

**Buyer-safe description**

Runs the application servers and serves the marketing site + dashboard + widget. Request logs (method, path, status, latency) are retained at the platform layer; request bodies are not.

**Evidence references**

- `file`: next.config.js
- `note`: Deployment provider has been documented as Vercel in security questionnaire answers since Phase 9J. Confirm against the active deployment configuration before sending to a buyer.

**Known limitations**

- Deployment provider may change; this row must be updated if the production host changes.
- DPA + SOC 2 evidence must be downloaded from the provider dashboard and reviewed by legal.

### Sentry

- **Category**: Error monitoring
- **Purpose**: Captures unhandled server + client exceptions for triage. Request id + sanitized route metadata accompany each error event.
- **Criticality**: important
- **Disclosure**: public
- **Risk tier**: medium
- **Assurance status**: manual_review_required
- **Production use**: yes
- **Data categories**: infrastructure_logs, audit_metadata
- **Review owner**: platform
- **Review cadence**: annually
- **Last reviewed**: never (registry default)

**Buyer-safe description**

Receives error telemetry. Event payloads include stack traces, route identifiers, and a salted-SHA-256 IP fingerprint; raw IPs and customer message content are not sent.

**Evidence references**

- `package`: @sentry/nextjs
- `file`: lib/observability/sentry.ts
- `env`: SENTRY_DSN
- `env`: NEXT_PUBLIC_SENTRY_DSN

**Known limitations**

- Default Sentry SDK behaviour scrubs known secret keys; project-side scrubbing rules must be reviewed against the latest payload shape.

### Slack

- **Category**: Incident alert routing (optional)
- **Purpose**: Receives operator-routed incident alerts via incoming webhook when INCIDENT_ALERTS_ENABLED=true AND INCIDENT_SLACK_WEBHOOK_URL is configured. No customer message content is sent; alert payload includes incident id, title, severity, status, category, source, and a dashboard link.
- **Criticality**: optional
- **Disclosure**: admin_only
- **Risk tier**: low
- **Assurance status**: manual_review_required
- **Production use**: no
- **Data categories**: audit_metadata
- **Review owner**: platform
- **Review cadence**: annually + on enablement
- **Last reviewed**: never (registry default)

**Buyer-safe description**

Optional incident alert channel. Used only when the operator has enabled alert routing. Receives incident metadata (id, title, severity, category) for operator triage.

**Evidence references**

- `env`: INCIDENT_ALERTS_ENABLED
- `env`: INCIDENT_SLACK_WEBHOOK_URL
- `file`: lib/enterprise/incidents/alert-routing.ts
- `note`: Webhook URL is server-only; never logged, never returned in any response, never stored in incident_alert_deliveries (only the operator-readable label is stored).

**Known limitations**

- Promote disclosureStatus to "public" before sharing the subprocessor list with a buyer if alert routing is live in production.

### PagerDuty

- **Category**: Incident alert routing (optional)
- **Purpose**: Receives operator-routed incident alerts via Events API v2 when INCIDENT_ALERTS_ENABLED=true AND INCIDENT_PAGERDUTY_ROUTING_KEY is configured. SEV1+SEV2 by default per the policy alert-route matrix. No customer message content is sent.
- **Criticality**: optional
- **Disclosure**: admin_only
- **Risk tier**: low
- **Assurance status**: manual_review_required
- **Production use**: no
- **Data categories**: audit_metadata
- **Review owner**: platform
- **Review cadence**: annually + on enablement
- **Last reviewed**: never (registry default)

**Buyer-safe description**

Optional incident escalation channel. Used only when the operator has enabled alert routing and configured a PagerDuty routing key. Receives incident metadata for on-call paging.

**Evidence references**

- `env`: INCIDENT_ALERTS_ENABLED
- `env`: INCIDENT_PAGERDUTY_ROUTING_KEY
- `file`: lib/enterprise/incidents/alert-routing.ts
- `note`: Routing key is server-only; never logged, never returned in any response, never stored in incident_alert_deliveries (only the operator-readable label is stored).

**Known limitations**

- Promote disclosureStatus to "public" before sharing the subprocessor list with a buyer if alert routing is live in production.
- A staffed 24/7 on-call rotation is the operator\'s responsibility; PagerDuty integration does not by itself imply 24/7 monitoring.

### Stripe CLI

- **Category**: Local development webhook forwarder
- **Purpose**: Forwards Stripe test webhooks to a local development server during development. Not used in production.
- **Criticality**: development_only
- **Disclosure**: internal_only
- **Risk tier**: low
- **Assurance status**: not_applicable
- **Production use**: no
- **Data categories**: billing_data
- **Review owner**: platform
- **Review cadence**: on tooling change
- **Last reviewed**: never (registry default)

**Buyer-safe description**

Local development tool only; not part of the production runtime.

**Evidence references**

- `note`: npm script `stripe:listen` forwards Stripe events to localhost during dev.
