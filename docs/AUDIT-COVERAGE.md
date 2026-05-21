# Audit Coverage Matrix

This document is the source of truth for which API routes write to
`public.audit_events` (the Phase 9A enterprise audit log) and which
are explicitly exempted with a rationale. It pairs with the
`scripts/check-audit-coverage.mjs` regression guard — every route
listed below must either contain a `recordAuditEvent` call, an
`AUDIT_EXEMPT:` comment, or a `public route` / `webhook route` header
comment that the scanner recognizes.

**Policy.** Whenever a new mutating HTTP route (POST | PATCH | PUT |
DELETE) is added or modified, the author must answer:

1. Does this mutate customer data?
2. Does this affect AI behavior?
3. Does this affect billing, availability, leads, tours, or users?
4. Should this produce an `audit_events` row?

If the answer to any of (1–3) is yes, default to **yes** on (4) and
add `recordAuditEvent(...)` in the success path. If a row is
genuinely not warranted (e.g. the route writes to a dedicated
forensic table that already covers it, the route is a webhook
callback, or the route is an anonymous public endpoint), add an
`AUDIT_EXEMPT: <reason>` comment near the top of the file and add
the row to this matrix under "Explicit exemptions" with the same
rationale.

## Audit row contract

Every `recordAuditEvent` call should include:

- `route` — static path string, e.g. `'/api/leads/[id]'`
- `action` — preferably a constant from
  `lib/enterprise/audit-actions.ts` (`AUDIT_ACTIONS.LEAD_UPDATE`,
  etc.); literal strings are acceptable in pre-9B files.
- `targetTable` — the primary table the action targets, or `null`
  for cross-cutting ops (bulk operations, settings, demo ops).
- `targetId` — the row id, or `null` when not applicable.
- `actorUserId` — the authenticated user id, or `null` when the
  caller is cron / system / webhook.
- `actorKind` — `'operator'` | `'cron'` | `'system'` | `'webhook'`.
- `venueId` — required. Every audit row is venue-scoped.
- `requestId` — for cross-system correlation.
- `ip` — raw IP; the helper hashes it.
- `userAgent` — raw user-agent; the helper truncates at 240 chars.
- `before` / `after` — small sanitized snapshots when cheap. NEVER
  raw tokens, secrets, full email bodies, raw webhook payloads, or
  auth headers. The helper drops sensitive keys recursively + caps
  size at 4 KB, but writers should not deliberately stuff PII in.
- `metadata` — free-form sanitized context. Operator-supplied
  `reason` strings, counts, flags.

---

## Coverage matrix

Legend:

- **Mutates** — Y if the route writes to any customer-visible table
- **Tenant scoped** — Y if every successful call binds to one
  `venue_id`. N for global ops (suppressions list, demo, probe).
- **Role gate** — auth helper / role set the route enforces
- **Audit action** — value passed to `recordAuditEvent.action`, or
  the exemption marker / category
- **Covered?** — Y (writes a row) | EXEMPT (documented opt-out)

### Leads

| Route | Method | Mutates | Tenant | Role | Audit action | Covered? | Notes |
|---|---:|---:|---:|---|---|---:|---|
| `/api/leads` | GET | N | Y | any member | — | n/a | Read-only list |
| `/api/leads` | POST | Y | Y | SALES_ROLES | `lead_create` | Y | Operator-initiated; widget intake is separate |
| `/api/leads/[id]` | PATCH | Y | Y | SALES_ROLES | `lead_update` or `lead_lost_reason_set` | Y | Before/after allowlist (stage, lead_score, urgency, event_date, ai_active, metadata) |
| `/api/leads/[id]` | DELETE | Y | Y | SALES_ROLES | `lead_delete` | Y | Before-snapshot captured |

### Tours

| Route | Method | Mutates | Tenant | Role | Audit action | Covered? | Notes |
|---|---:|---:|---:|---|---|---:|---|
| `/api/tours` | POST | Y | Y | SALES_ROLES | `tour_create` | Y | After: lead_id, scheduled_at, duration_minutes |
| `/api/tours/[id]` | PATCH | Y | Y | SALES_ROLES | `tour_update`/`tour_cancel`/`tour_confirm`/`tour_reschedule` | Y | Action derived from existing 8M `deriveTourAuditAction` helper |
| `/api/admin/tours/bulk-cancel` | POST | Y | Y | ADMIN_ROLES | `tours_bulk_cancel` | Y | Single summary row, not per-tour |
| `/api/admin/tours/clear-pause` | POST | Y | Y | ADMIN_ROLES | `tours_pause_clear` | Y | Before snapshot of pause scalars + after snapshot of forensic clear keys |

### Venue / availability / blackouts

| Route | Method | Mutates | Tenant | Role | Audit action | Covered? | Notes |
|---|---:|---:|---:|---|---|---:|---|
| `/api/venues/[id]` | PATCH | Y | Y | ADMIN_ROLES | `venue_update` | Y | metadata.fields lists keys touched |
| `/api/venues/[id]/availability` | POST | Y | Y | ADMIN_ROLES | `availability_create` | Y | |
| `/api/venues/[id]/availability/[slotId]` | PATCH | Y | Y | ADMIN_ROLES | `availability_update` | Y | |
| `/api/venues/[id]/availability/[slotId]` | DELETE | Y | Y | ADMIN_ROLES | `availability_delete` | Y | |
| `/api/venues/[id]/tour-blackouts` | POST | Y | Y | ADMIN_ROLES | `tour_blackout_create` | Y | |
| `/api/venues/[id]/tour-blackouts/[blackoutId]` | DELETE | Y | Y | ADMIN_ROLES | `tour_blackout_delete` | Y | |
| `/api/venues/[id]/knowledge` | POST | Y | Y | SALES_ROLES | `knowledge_entry_created` | Y | 9T-alt — after: `{title, category, priority, is_active, content_length}`. Full content NOT mirrored. |
| `/api/venues/[id]/knowledge/[knowledgeId]` | PATCH | Y | Y | SALES_ROLES | `knowledge_entry_updated` / `knowledge_entry_toggled` | Y | 9T-alt — `_toggled` when only `is_active` flips; `_updated` otherwise. before/after carry the same safe fields. |
| `/api/venues/[id]/knowledge/[knowledgeId]` | DELETE | Y | Y | SALES_ROLES | `knowledge_entry_deleted` | Y | 9T-alt — before snapshot only. |

### Conversations / messages

| Route | Method | Mutates | Tenant | Role | Audit action | Covered? | Notes |
|---|---:|---:|---:|---|---|---:|---|
| `/api/conversations/[id]/messages` | POST | Y | Y | SALES_ROLES | `operator_message_send` | Y | **Body length only — never the body itself.** |

### AI safety + reviews

| Route | Method | Mutates | Tenant | Role | Audit action | Covered? | Notes |
|---|---:|---:|---:|---|---|---:|---|
| `/api/ai/actions/[id]/reject` | PATCH | Y | Y | SALES_ROLES | `ai_action_reject` | Y | |
| `/api/admin/ai/autopilot-reviews/[aiActionId]` | POST | Y | Y | ADMIN_ROLES | `autopilot_review_label` | Y | |

### Digest

| Route | Method | Mutates | Tenant | Role | Audit action | Covered? | Notes |
|---|---:|---:|---:|---|---|---:|---|
| `/api/admin/digest/preferences` | POST | Y | Y | ADMIN_ROLES | `digest_preferences_update` | Y | |
| `/api/admin/digest/preview` | POST | Y | Y | ADMIN_ROLES | `digest_preview_send` | Y | Unconditional enterprise row (the Phase 8AE digest-table row is gated on `DIGEST_AUDIT_LOG_CRON_SENDS`) |
| `/api/admin/digest/send` | POST | Y | Y | ADMIN_ROLES | `digest_manual_send` | Y | |
| `/api/admin/digest/suppressions/remove` | POST | Y | Y | ADMIN_ROLES | `digest_suppression_remove`/`digest_suppression_remove_noop` | Y | Also writes Phase 8AC digest-specific row |
| `/api/admin/digest/suppressions/remove-all` | POST | Y | Y | ADMIN_ROLES | `digest_suppression_remove_all` | Y | Single summary row; per-member detail lives in Phase 8AC table |
| `/api/admin/suppressions` | POST | Y | N (global) | requireAdmin | `suppression_add_manual` | Y | Attributed to caller's primary venue |

### Billing

| Route | Method | Mutates | Tenant | Role | Audit action | Covered? | Notes |
|---|---:|---:|---:|---|---|---:|---|
| `/api/billing/checkout` | POST | Y (Stripe) | Y | ADMIN_ROLES | `billing_checkout_session_create` | Y | 9R metadata: `plan_id`, `interval`, `stripe_price_configured`, `source` (`subscription_plans_card` / etc.). Legacy `price_id` + `used_default_price` preserved. No card data. |
| `/api/billing/portal` | POST | Y (Stripe) | Y | ADMIN_ROLES | `billing_portal_session_create` | Y | 9Q metadata: `source` (`payment_methods_card` / `billing_status_card`), `subscription_status`, `stripe_customer_present`. No card data, no PM id, no Stripe payload. |
| `/api/admin/billing-events/[id]/clear-dunning` | POST | Y | Y | ADMIN_ROLES | `billing_event_clear_dunning` | Y | metadata.cleared_prefix + operator_reason |
| `/api/admin/billing-events/[id]/replay` | POST | Y | Y | ADMIN_ROLES | `billing_event_replay` | Y | Stripe payload deliberately omitted from snapshot |

### Team / RBAC

| Route | Method | Mutates | Tenant | Role | Audit action | Covered? | Notes |
|---|---:|---:|---:|---|---|---:|---|
| `/api/team/invitations` | POST | Y | Y | ADMIN_ROLES | `team_invitation_create` | Y | invited_email_masked + role |
| `/api/team/invitations/[id]` | DELETE | Y | Y | ADMIN_ROLES | `team_invitation_revoke` | Y | |
| `/api/team/invitations/accept` | POST | Y | Y | authed user | `team_invitation_accept` | Y | Token NEVER recorded |
| `/api/team/members/[userId]` | DELETE | Y | Y | ADMIN_ROLES | `team_member_remove` | Y | self_removal flag |
| `/api/team/members/[userId]` | PATCH | Y | Y | ADMIN_ROLES | `team_member_role_update` | Y | after.role; self_role_change flag |

### Onboarding

| Route | Method | Mutates | Tenant | Role | Audit action | Covered? | Notes |
|---|---:|---:|---:|---|---|---:|---|
| `/api/onboarding/create-workspace` | POST | Y | Y (new) | authed user | `workspace_create` | Y | Skipped when helper short-circuits on `already_exists` |

### Settings (Revenue OS)

| Route | Method | Mutates | Tenant | Role | Audit action | Covered? | Notes |
|---|---:|---:|---:|---|---|---:|---|
| `/api/admin/revenue-os/settings` | POST | Y | Y | ADMIN_ROLES | `revenue_os_settings_update` | Y | Before/after captured |

### Admin operations / diagnostics

| Route | Method | Mutates | Tenant | Role | Audit action | Covered? | Notes |
|---|---:|---:|---:|---|---|---:|---|
| `/api/admin/demo/seed` | POST | Y | Y | requireAdmin | `demo_seed` | Y | metadata.counts |
| `/api/admin/demo/reset` | POST | Y (destructive) | Y | requireAdmin | `demo_reset` | Y | Restricted to demo+ rows by helper; counts in metadata |
| `/api/admin/demo/revenue-recovery-seed` | POST | Y | Y | requireAdmin + cross-tenant role check on `venue_id` body | `revenue_recovery_demo_seeded` | Y | GTM-0A. Metadata: counts (created/skipped/reset), reset flag, warnings_count. Seeded content NOT mirrored. |
| `/api/admin/demo/revenue-recovery-load-seed` | POST | Y | Y | requireAdmin + cross-tenant role check on `venue_id` body | `revenue_recovery_load_demo_seeded` | Y | GTM-0A.2 load/stress seed (25–1000 leads). Metadata: profile, lead_count_requested, lead_count_clamped, created counts, distribution (stages/sources/channels/leakage signals/lost reasons), reset counts, warnings_count, duration_ms. Generated message content NOT mirrored. Reset isolated to `demo_seed_type='load'`. |
| `/api/admin/test-send` | POST | Y (sends email) | Y | requireAdmin | `admin_test_send` | Y | Sends to caller's own email only |

### Data lifecycle (Phase 9D)

| Route | Method | Mutates | Tenant | Role | Audit action | Covered? | Notes |
|---|---:|---:|---:|---|---|---:|---|
| `/api/admin/data-export` | POST | N (read-only) | Y | ADMIN_ROLES | `data_export_requested` | Y | Audit row records section counts + bytes; NEVER the full payload. 413 + audit row when over MAX_EXPORT_BYTES (8 MB). |
| `/api/admin/leads/[leadId]/redact-pii` | POST | Y (soft-redact) | Y | ADMIN_ROLES | `lead_pii_redacted` | Y | Before-snapshot is the PII-only subtree (name, email, phone, notes, pii metadata); after-snapshot is the patch. Lead row preserved; conversations/tours/audit_events untouched. |

---

## Explicit exemptions

Each row below contains an `AUDIT_EXEMPT:` / `public route` /
`webhook route` marker in its source file. The scanner accepts the
marker; the rationale below justifies it.

| Route | Method | Marker | Rationale |
|---|---:|---|---|
| `/api/widget` | POST | `public route` | Anonymous widget intake. No authenticated actor to attribute. `leads.source = 'widget'` + `created_at` give the forensic trail; downstream orchestrator emits its own pino + `ai_actions` records. Phase 9A explicitly excluded widget intake. |
| `/api/stripe/webhook` | POST | `webhook route` | Stripe callback. `billing_events_log` is the canonical forensic record (event id, type, payload, handled state, replay history). Duplicating payloads into `audit_events` would double-store the same data. Operator-initiated replays via `/api/admin/billing-events/[id]/replay` DO write audit rows. |
| `/api/resend/webhook` | POST | `webhook route` | Resend callback. Delivery state lives on `outbound_messages.status`; suppressions go to `email_suppressions`. Webhook's own pino structured logs are the trail. Phase 9A explicitly excluded webhooks. |
| `/api/ai/draft` | POST | `AUDIT_EXEMPT` | Every successful draft writes `ai_actions` (Phase 8AN) — the canonical record powering the AIDraftAuditCard, BrandVoiceCalibrationPanel, AutopilotSimulationPanel, and review queue. Duplicating creates noise without forensic value; surfaces already cross-link via `aiActionId`. |
| `/api/ai/chat` | POST | `AUDIT_EXEMPT` | Agent invocation. Writes `messages` rows the inbox surfaces directly. The operator-initiated counterpart (operator sends a message) goes through `/api/conversations/[id]/messages` and IS audited. Phase 9A "don't touch agent prompts / decision logic." |
| `/api/ai/followup` | POST | `AUDIT_EXEMPT` | Agent invocation. Writes `follow_up_schedules` + `messages` that the inbox + tour pipelines surface directly. Operator-initiated send is audited via `/api/conversations/[id]/messages`. |
| `/api/ai/qualify` | POST | `AUDIT_EXEMPT` | AI tool-call updating `lead.lead_score`. Operator-driven counterpart through `/api/leads/[id]` PATCH is audited (`lead_update`). |
| `/api/admin/anthropic-probe` | POST | `AUDIT_EXEMPT` | Diagnostic — 1-token completion to verify API key + retry path. Reads no customer data, mutates no rows. Pino logs capture invocation. |
| `/api/security/csp-report` | POST | `AUDIT_EXEMPT` | Phase 9E anonymous CSP-violation telemetry. Browsers POST here when a Content-Security-Policy-Report-Only directive trips. No operator actor; no customer-data mutation. Per-IP rate-limited (60/min). Reports get structured-logged (`security.csp_report.received`) — never audit-rowed. |

---

## Operational notes

- **Audit writes are best-effort.** `recordAuditEvent` wraps every
  step in try/catch — logs + Sentry on failure, never throws,
  never blocks the original business action. Routes use
  `void recordAuditEvent({...})` so a stalled audit write doesn't
  delay the HTTP response.
- **Audit logs are not a replacement for database backups.** They
  capture WHO touched WHAT and WHEN, not the full pre-write
  serialization of every row. For a true restore, use Supabase's
  point-in-time recovery.
- **Audit logs are tamper-evident, not tamper-proof.** Phase 9C
  added `public.audit_event_mirror` (migration 028). Every
  successful `audit_events` insert attempts a best-effort mirror
  write into the second table; the mirror has owner-only SELECT,
  no RLS write policies, and shares the primary row's UUID so
  drift (primary missing, mirror present) is trivially detectable
  by joining on `id`. Gated by `AUDIT_MIRROR_ENABLED=1` (default
  OFF; flip when migration 028 has applied to your environment).
  - **What is mirrored:** the full sanitized payload the primary
    row already stored (ip_hash, user_agent, before_snapshot,
    after_snapshot, metadata). The helper does NOT re-sanitize on
    write — the primary feed is the source of truth for what's
    safe to store.
  - **What is NEVER mirrored:** raw auth headers, tokens, raw
    webhook bodies, raw message bodies, full email content,
    secrets, unmasked emails. Enforced upstream in
    `recordAuditEvent`; if a caller violates the contract, the
    offending data lands in BOTH tables and the upstream
    sanitization is the bug.
  - **Mirror failure behavior:** logged at warn level
    (`audit_mirror.insert_failed`) + Sentry-captured, NEVER
    thrown back to the route. The primary `audit_events` row
    already committed; the operator's HTTP response is
    unaffected. Operators monitor mirror health via the structured
    log line — a flood is a real signal.
  - **Known limitation:** still not true WORM. An admin with
    direct database access (psql, Supabase SQL editor) can issue
    `DELETE FROM audit_event_mirror`. The mirror separates feeds
    + closes the REST mutation surface; it doesn't prevent an
    authorized DB operator from rewriting history. A future
    phase may add an external append-only sink (object storage,
    third-party log shipper).
- **Snapshots are sanitized and bounded.** The helper drops sensitive
  keys recursively (password, secret, token, api_key, authorization,
  cookie, webhook_payload, raw_body, stripe_secret,
  anthropic_api_key) and caps the JSON serialization at 4 KB.
  Strings inside snapshots are truncated at 1 KB.
- **Service-role writes require explicit role checks first.** Every
  route that creates a service-role client (`createServiceClient`)
  for a write must have first called `requireAdmin()` /
  `requireVenueRole(...)`. The cross-tenant 403 → 404 collapse is
  the standard posture; never reveal whether a foreign venue exists.

## How to add a new mutating route

1. Implement the route. Use the standard auth / rate-limit / Zod /
   request-id stack already in place.
2. At the success path, call `recordAuditEvent(...)` with the
   audit row contract above. Prefer
   `AUDIT_ACTIONS.<NAME>` from `lib/enterprise/audit-actions.ts`;
   add a new constant if your action doesn't fit an existing name.
3. Add a row to the matrix above.
4. Run `npm run check:audit-coverage` — must pass clean.
5. If the route genuinely doesn't need an audit row, add an
   `AUDIT_EXEMPT: <reason>` comment near the top and document the
   row under "Explicit exemptions" with the rationale.

---

## Phase 8BE — Omnichannel inbox connector foundation

| Route | Method | Audit action |
|---|---|---|
| `/api/admin/integrations/channels` | GET | NOT audited — read-only capability listing. |
| `/api/admin/integrations/channels` | POST | `channel_connection_created` |
| `/api/admin/integrations/channels/[id]` | PATCH | `channel_connection_updated` |
| `/api/conversations/[id]/mark-sent-manually` | POST | `channel_reply_marked_sent_manually` |
| `/api/integrations/website/message` | POST | AUDIT_EXEMPT — anonymous inbound forwarding (mirrors `/api/widget`). |
| `/api/integrations/lead-forwarding/the-knot` | POST | AUDIT_EXEMPT — anonymous lead-forwarding. |
| `/api/integrations/lead-forwarding/weddingwire` | POST | AUDIT_EXEMPT — anonymous lead-forwarding. |
| `/api/integrations/meta/webhook` | GET/POST | AUDIT_EXEMPT — webhook placeholder. |

The exempt public inbound routes write `messages` +
`external_messages` rows on every accepted payload; that
constitutes the forensic trail in the same way the existing
`/api/widget` route does (see Phase 9A widget exemption
rationale). The Meta webhook is parked and does NOT
normalize until Phase 8BF wires signature verification.

---

## Phase 8BG — Lead-forwarding parser

| Route | Method | Audit action |
|---|---|---|
| `/api/admin/integrations/lead-forwarding/test-parse` | POST | `lead_forwarding_test_parse` |
| `/api/integrations/lead-forwarding/the-knot` | POST | AUDIT_EXEMPT (mirrors 8BE lead-forwarding posture) |
| `/api/integrations/lead-forwarding/weddingwire` | POST | AUDIT_EXEMPT (mirrors 8BE lead-forwarding posture) |

The test-parse audit row carries ONLY parser-derived signals
(`parse_confidence`, `parse_needs_review`,
`parse_confidence_reasons`, `input_shape: 'payload' | 'body'`).
Raw `body` and `subject` are NEVER stamped into the audit
metadata — the audit log stays PII-light.

The public lead-forwarding routes keep the same audit
exemption rationale as Phase 8BE: anonymous inbound that
writes `messages` + `external_messages` rows on every
accepted payload, which constitutes the forensic trail.

---

## Phase 8BF — Meta connector

| Route | Method | Audit action |
|---|---|---|
| `/api/integrations/meta/webhook` | GET/POST | AUDIT_EXEMPT — public webhook route. Successful verification + normalization leaves the forensic trail in `messages` + `external_messages` via the normalization helper. Failed signature/verification events are NOT audited (would spam the table on any internet noise); pino + Sentry capture them safely without the token/secret/body. |
| `/api/admin/integrations/meta/test-parse` | POST | `meta_webhook_test_parse` |

The test-parse audit row carries only parser-derived
signals (`object_type`, `events_parsed`, `events_ignored`,
`channels`). Raw payload bytes are NEVER stamped into
audit metadata.
