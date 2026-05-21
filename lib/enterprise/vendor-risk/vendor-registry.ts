import type { VendorRecord } from '@/lib/enterprise/vendor-risk/types'

/**
 * Phase 9K — Static vendor + subprocessor registry.
 *
 * Single source of truth for "which third parties does VenueRise
 * use, what data may they process, and what assurance evidence
 * do we have today." Built by hand. Every row reflects a vendor
 * that is actually referenced in this repository (package.json,
 * env.example, lib/ imports, or deployment configuration).
 *
 * REVIEW DISCIPLINE:
 *   - When a new vendor lands in `package.json` or a new
 *     SDK is imported under `lib/`, append a row here BEFORE
 *     merging. The `scripts/check-vendor-risk.mjs` scanner
 *     calls out missing registry coverage for known packages.
 *   - Update `lastReviewedAt` whenever the operator confirms
 *     the row is current. `null` is honest — "never reviewed."
 *   - DPA / SCC / SOC 2 status NEVER claims "verified" unless
 *     the repo carries the artifact. Default is
 *     `manual_review_required`.
 *
 * The buyer-facing disclosure (rendered by
 * `subprocessor-disclosure` route) only includes records whose
 * `disclosureStatus === 'public'`. Anything `admin_only` or
 * `internal_only` stays in the admin card.
 */

export const VENDOR_REGISTRY: ReadonlyArray<VendorRecord> = [
  // ── Database / auth / storage ──────────────────────────────────────────
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'Database, auth, storage, realtime',
    purpose:
      'Primary application database (Postgres), authentication, row-level security enforcement, storage, and realtime channels.',
    criticality: 'critical',
    disclosureStatus: 'public',
    dataCategories: [
      'account_data',
      'lead_data',
      'message_content',
      'authentication_data',
      'audit_metadata',
      'billing_data',
    ],
    productionUse: true,
    buyerSafeDescription:
      'Hosts the application database, user authentication, and file storage. Data is encrypted at rest (AES-256) and in transit (TLS). Access is RLS-gated; service-role credentials are used only by trusted server code.',
    riskTier: 'high',
    assuranceStatus: 'manual_review_required',
    evidence: [
      { kind: 'package', reference: '@supabase/supabase-js' },
      { kind: 'package', reference: '@supabase/ssr' },
      { kind: 'env', reference: 'NEXT_PUBLIC_SUPABASE_URL' },
      { kind: 'env', reference: 'NEXT_PUBLIC_SUPABASE_ANON_KEY' },
      { kind: 'env', reference: 'SUPABASE_SERVICE_ROLE_KEY' },
      { kind: 'env', reference: 'SUPABASE_PROJECT_REF' },
      { kind: 'env', reference: 'SUPABASE_ACCESS_TOKEN' },
      { kind: 'doc', reference: 'docs/DISASTER-RECOVERY.md' },
      { kind: 'doc', reference: 'docs/RUNBOOK.md', label: 'Secrets rotation' },
    ],
    knownLimitations: [
      'DPA + SOC 2 report must be downloaded from Supabase dashboard and retained outside this repo.',
      'Live PITR verification requires the Management API env vars (Phase 9H).',
    ],
    reviewOwner: 'platform',
    reviewCadence: 'annually + on plan change',
    lastReviewedAt: null,
  },

  // ── AI model provider ─────────────────────────────────────────────────
  {
    id: 'anthropic',
    name: 'Anthropic',
    category: 'AI model provider',
    purpose:
      'LLM inference for lead qualification, brand-voice drafting, autopilot simulation, and operator-approved customer reply drafting.',
    criticality: 'critical',
    disclosureStatus: 'public',
    dataCategories: ['lead_data', 'message_content'],
    productionUse: true,
    buyerSafeDescription:
      'Generates draft replies + lead qualification signals. Lead inquiry text and conversation context are sent to the Anthropic API for inference; outputs return as drafts that require explicit operator approval before sending (no autonomous send path).',
    riskTier: 'high',
    assuranceStatus: 'manual_review_required',
    evidence: [
      { kind: 'package', reference: '@anthropic-ai/sdk' },
      { kind: 'env', reference: 'ANTHROPIC_API_KEY' },
      { kind: 'file', reference: 'lib/anthropic.ts' },
      { kind: 'doc', reference: 'docs/AGENTIC-WORKFLOW-MAP.md' },
      {
        kind: 'note',
        reference:
          'Autonomous sending is explicitly disabled — see `autonomous_sending_still_disabled` health flag.',
      },
    ],
    knownLimitations: [
      'DPA terms + zero-retention configuration must be confirmed with Anthropic on the active plan.',
      'No automated PII scrubbing on outbound payloads — operators rely on lead data minimisation upstream.',
    ],
    reviewOwner: 'security',
    reviewCadence: 'annually + on contract change',
    lastReviewedAt: null,
  },

  // ── Billing ────────────────────────────────────────────────────────────
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Billing + subscriptions',
    purpose:
      'Subscription billing, hosted checkout, customer portal, and payment method storage. Authoritative source for subscription + invoice state.',
    criticality: 'critical',
    disclosureStatus: 'public',
    dataCategories: ['billing_data', 'account_data'],
    productionUse: true,
    buyerSafeDescription:
      'Processes subscription payments. Card data is captured directly by Stripe and never reaches VenueRise systems; only Stripe customer/subscription/invoice ids and metadata are stored.',
    riskTier: 'high',
    assuranceStatus: 'manual_review_required',
    evidence: [
      { kind: 'package', reference: 'stripe' },
      { kind: 'env', reference: 'STRIPE_SECRET_KEY' },
      { kind: 'env', reference: 'STRIPE_WEBHOOK_SECRET' },
      { kind: 'route', reference: '/api/stripe/webhook' },
      { kind: 'doc', reference: 'docs/RUNBOOK.md', label: 'Stripe webhook posture' },
    ],
    knownLimitations: [
      'Stripe SOC 1/2 + PCI DSS attestations are downloadable from the Stripe dashboard; not mirrored in this repo.',
    ],
    reviewOwner: 'finance',
    reviewCadence: 'annually',
    lastReviewedAt: null,
  },

  // ── Transactional email ────────────────────────────────────────────────
  {
    id: 'resend',
    name: 'Resend',
    category: 'Transactional email delivery',
    purpose:
      'Delivers operator-triggered transactional email (tour notifications, digests, operator-approved replies). Webhook returns delivery + bounce + complaint signals to the application.',
    criticality: 'important',
    disclosureStatus: 'public',
    dataCategories: ['email_metadata', 'message_content', 'lead_data'],
    productionUse: true,
    buyerSafeDescription:
      'Sends outbound email. Recipient addresses and message bodies are transmitted to Resend for delivery; bounce/complaint signals feed back into the in-app suppression list.',
    riskTier: 'medium',
    assuranceStatus: 'manual_review_required',
    evidence: [
      { kind: 'package', reference: 'resend' },
      { kind: 'env', reference: 'RESEND_API_KEY' },
      { kind: 'env', reference: 'RESEND_WEBHOOK_SECRET' },
      { kind: 'file', reference: 'lib/integrations/email.ts' },
      { kind: 'route', reference: '/api/resend/webhook' },
    ],
    knownLimitations: [
      'No customer-facing self-service unsubscribe page beyond the existing digest token route.',
    ],
    reviewOwner: 'platform',
    reviewCadence: 'annually',
    lastReviewedAt: null,
  },

  // ── Rate limit cache / KV ──────────────────────────────────────────────
  {
    id: 'upstash',
    name: 'Upstash',
    category: 'Rate-limit cache (Redis-compatible)',
    purpose:
      'Sliding-window rate-limit counters for every mutating + sensitive admin endpoint, abuse-monitor counters, and SSO limiter state.',
    criticality: 'important',
    disclosureStatus: 'public',
    dataCategories: ['usage_metadata'],
    productionUse: true,
    buyerSafeDescription:
      'Stores short-lived rate-limit counters. Holds a salted-SHA-256 IP fingerprint and per-route bucket counts; no customer payload data is stored.',
    riskTier: 'low',
    assuranceStatus: 'manual_review_required',
    evidence: [
      { kind: 'package', reference: '@upstash/ratelimit' },
      { kind: 'package', reference: '@upstash/redis' },
      { kind: 'env', reference: 'UPSTASH_REDIS_REST_URL' },
      { kind: 'env', reference: 'UPSTASH_REDIS_REST_TOKEN' },
      { kind: 'file', reference: 'lib/rate-limit.ts' },
      { kind: 'doc', reference: 'docs/RATE-LIMIT-COVERAGE.md' },
    ],
    knownLimitations: [
      'Counters are short-lived but the limiter key itself includes a fingerprint — never a raw IP.',
    ],
    reviewOwner: 'platform',
    reviewCadence: 'annually',
    lastReviewedAt: null,
  },

  // ── Background jobs ────────────────────────────────────────────────────
  {
    id: 'inngest',
    name: 'Inngest',
    category: 'Background jobs + scheduled tasks',
    purpose:
      'Schedules and dispatches background work: operator digest fan-out, retention sweeps, backfill jobs, tour notification follow-ups.',
    criticality: 'important',
    disclosureStatus: 'public',
    dataCategories: ['usage_metadata', 'audit_metadata'],
    productionUse: true,
    buyerSafeDescription:
      'Coordinates background jobs. Event payloads include lead/tour identifiers and job metadata; job results are written back to the application database. Customer message content is fetched server-side per job, not stored at the orchestrator.',
    riskTier: 'medium',
    assuranceStatus: 'manual_review_required',
    evidence: [
      { kind: 'package', reference: 'inngest' },
      { kind: 'env', reference: 'INNGEST_EVENT_KEY' },
      { kind: 'env', reference: 'INNGEST_SIGNING_KEY' },
      { kind: 'route', reference: '/api/inngest' },
      { kind: 'file', reference: 'lib/jobs/client.ts' },
    ],
    knownLimitations: [
      'Event payloads should not include raw lead PII beyond what is needed to refetch the row.',
    ],
    reviewOwner: 'platform',
    reviewCadence: 'annually',
    lastReviewedAt: null,
  },

  // ── Hosting / deployment ───────────────────────────────────────────────
  {
    id: 'deployment-host',
    name: 'Vercel',
    category: 'Hosting + serverless runtime',
    purpose:
      'Hosts the Next.js application, terminates TLS, dispatches serverless route handlers, and serves static assets + the public widget.',
    criticality: 'critical',
    disclosureStatus: 'public',
    dataCategories: ['infrastructure_logs', 'usage_metadata'],
    productionUse: true,
    buyerSafeDescription:
      'Runs the application servers and serves the marketing site + dashboard + widget. Request logs (method, path, status, latency) are retained at the platform layer; request bodies are not.',
    riskTier: 'high',
    assuranceStatus: 'manual_review_required',
    evidence: [
      { kind: 'file', reference: 'next.config.js' },
      {
        kind: 'note',
        reference:
          'Deployment provider has been documented as Vercel in security questionnaire answers since Phase 9J. Confirm against the active deployment configuration before sending to a buyer.',
      },
    ],
    knownLimitations: [
      'Deployment provider may change; this row must be updated if the production host changes.',
      'DPA + SOC 2 evidence must be downloaded from the provider dashboard and reviewed by legal.',
    ],
    reviewOwner: 'platform',
    reviewCadence: 'annually + on deploy provider change',
    lastReviewedAt: null,
  },

  // ── Monitoring / observability ─────────────────────────────────────────
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'Error monitoring',
    purpose:
      'Captures unhandled server + client exceptions for triage. Request id + sanitized route metadata accompany each error event.',
    criticality: 'important',
    disclosureStatus: 'public',
    dataCategories: ['infrastructure_logs', 'audit_metadata'],
    productionUse: true,
    buyerSafeDescription:
      'Receives error telemetry. Event payloads include stack traces, route identifiers, and a salted-SHA-256 IP fingerprint; raw IPs and customer message content are not sent.',
    riskTier: 'medium',
    assuranceStatus: 'manual_review_required',
    evidence: [
      { kind: 'package', reference: '@sentry/nextjs' },
      { kind: 'file', reference: 'lib/observability/sentry.ts' },
      { kind: 'env', reference: 'SENTRY_DSN' },
      { kind: 'env', reference: 'NEXT_PUBLIC_SENTRY_DSN' },
    ],
    knownLimitations: [
      'Default Sentry SDK behaviour scrubs known secret keys; project-side scrubbing rules must be reviewed against the latest payload shape.',
    ],
    reviewOwner: 'platform',
    reviewCadence: 'annually',
    lastReviewedAt: null,
  },

  // ── Incident alert routing (Phase 9L) — optional / env-gated ───────────
  // These rows describe vendors that the platform CAN route
  // incident alerts to when the operator opts in via
  // INCIDENT_ALERTS_ENABLED + the matching env vars. They are
  // disclosure_status='admin_only' so they don't leak into the
  // buyer subprocessor disclosure UNLESS the operator promotes
  // them to 'public' after enabling. The buyer-safe description
  // is intentionally cautious — when the operator turns alerts
  // on, the disclosure should be reviewed before sharing
  // externally.
  {
    id: 'slack',
    name: 'Slack',
    category: 'Incident alert routing (optional)',
    purpose:
      'Receives operator-routed incident alerts via incoming webhook when INCIDENT_ALERTS_ENABLED=true AND INCIDENT_SLACK_WEBHOOK_URL is configured. No customer message content is sent; alert payload includes incident id, title, severity, status, category, source, and a dashboard link.',
    criticality: 'optional',
    disclosureStatus: 'admin_only',
    dataCategories: ['audit_metadata'],
    productionUse: false,
    buyerSafeDescription:
      'Optional incident alert channel. Used only when the operator has enabled alert routing. Receives incident metadata (id, title, severity, category) for operator triage.',
    riskTier: 'low',
    assuranceStatus: 'manual_review_required',
    evidence: [
      { kind: 'env', reference: 'INCIDENT_ALERTS_ENABLED' },
      { kind: 'env', reference: 'INCIDENT_SLACK_WEBHOOK_URL' },
      { kind: 'file', reference: 'lib/enterprise/incidents/alert-routing.ts' },
      {
        kind: 'note',
        reference:
          'Webhook URL is server-only; never logged, never returned in any response, never stored in incident_alert_deliveries (only the operator-readable label is stored).',
      },
    ],
    knownLimitations: [
      'Promote disclosureStatus to "public" before sharing the subprocessor list with a buyer if alert routing is live in production.',
    ],
    reviewOwner: 'platform',
    reviewCadence: 'annually + on enablement',
    lastReviewedAt: null,
  },
  {
    id: 'pagerduty',
    name: 'PagerDuty',
    category: 'Incident alert routing (optional)',
    purpose:
      'Receives operator-routed incident alerts via Events API v2 when INCIDENT_ALERTS_ENABLED=true AND INCIDENT_PAGERDUTY_ROUTING_KEY is configured. SEV1+SEV2 by default per the policy alert-route matrix. No customer message content is sent.',
    criticality: 'optional',
    disclosureStatus: 'admin_only',
    dataCategories: ['audit_metadata'],
    productionUse: false,
    buyerSafeDescription:
      'Optional incident escalation channel. Used only when the operator has enabled alert routing and configured a PagerDuty routing key. Receives incident metadata for on-call paging.',
    riskTier: 'low',
    assuranceStatus: 'manual_review_required',
    evidence: [
      { kind: 'env', reference: 'INCIDENT_ALERTS_ENABLED' },
      { kind: 'env', reference: 'INCIDENT_PAGERDUTY_ROUTING_KEY' },
      { kind: 'file', reference: 'lib/enterprise/incidents/alert-routing.ts' },
      {
        kind: 'note',
        reference:
          'Routing key is server-only; never logged, never returned in any response, never stored in incident_alert_deliveries (only the operator-readable label is stored).',
      },
    ],
    knownLimitations: [
      'Promote disclosureStatus to "public" before sharing the subprocessor list with a buyer if alert routing is live in production.',
      'A staffed 24/7 on-call rotation is the operator\'s responsibility; PagerDuty integration does not by itself imply 24/7 monitoring.',
    ],
    reviewOwner: 'platform',
    reviewCadence: 'annually + on enablement',
    lastReviewedAt: null,
  },

  // ── Internal-only dev tooling ──────────────────────────────────────────
  {
    id: 'stripe-cli',
    name: 'Stripe CLI',
    category: 'Local development webhook forwarder',
    purpose:
      'Forwards Stripe test webhooks to a local development server during development. Not used in production.',
    criticality: 'development_only',
    disclosureStatus: 'internal_only',
    dataCategories: ['billing_data'],
    productionUse: false,
    buyerSafeDescription:
      'Local development tool only; not part of the production runtime.',
    riskTier: 'low',
    assuranceStatus: 'not_applicable',
    evidence: [
      {
        kind: 'note',
        reference: 'npm script `stripe:listen` forwards Stripe events to localhost during dev.',
      },
    ],
    knownLimitations: [],
    reviewOwner: 'platform',
    reviewCadence: 'on tooling change',
    lastReviewedAt: null,
  },
]
