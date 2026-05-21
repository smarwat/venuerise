# Privacy + DSR readiness

_Phase 9M — Data Privacy, Retention, and DSR Readiness._

This document is the operator-facing companion to:

- `lib/enterprise/privacy/types.ts`
- `lib/enterprise/privacy/data-inventory.ts`
- `lib/enterprise/privacy/retention-policy.ts`
- `lib/enterprise/privacy/dsr.ts`
- `lib/enterprise/privacy/readiness.ts`
- `lib/enterprise/privacy/export-preview.ts`
- `lib/enterprise/privacy/deletion-review.ts`
- `supabase/migrations/033_privacy_dsr_readiness.sql`
- `app/api/admin/privacy/readiness`
- `app/api/admin/privacy/dsr-requests/*`
- `components/dashboard/settings/PrivacyReadinessCard.tsx`
- `components/dashboard/settings/DsrRequestsCard.tsx`
- `scripts/build-privacy-pack.mjs`
- `scripts/check-privacy-readiness.mjs`

---

## 1. Purpose

Enterprise and legal procurement always ask three questions:

1. **What personal data do you process?**
2. **How long do you keep it?**
3. **How do you handle subject deletion / export requests?**

Phase 9M ships answers from a single source of truth, plus an
operator-controlled DSR workflow that produces an auditable
trail without auto-fulfilling anything.

> **This is not legal compliance.** VenueRise does NOT claim
> GDPR, CCPA, or LGPD compliance. Operator + counsel review is
> required before any external claim.

---

## 2. Data inventory

`lib/enterprise/privacy/data-inventory.ts` enumerates every
category of customer / personal data processed by VenueRise:

| Category | Sensitivity | Exportable | Deletable | Status |
|---|---|---|---|---|
| `account_identity` | moderate | yes | yes | implemented |
| `venue_profile` | low | yes | yes | implemented |
| `lead_contact` | high | yes | yes | partial |
| `lead_event_details` | moderate | yes | yes | partial |
| `conversation_content` | high | yes | no | partial |
| `tour_scheduling` | moderate | yes | yes | implemented |
| `billing_metadata` | moderate | yes | no | implemented |
| `auth_security_metadata` | restricted | no | no | implemented |
| `audit_metadata` | restricted | no | no | implemented |
| `abuse_security_metadata` | restricted | no | no | implemented |
| `sso_security_metadata` | restricted | no | no | implemented |
| `incident_metadata` | restricted | no | no | implemented |
| `vendor_metadata` | low | yes | no | implemented |
| `support_metadata` | moderate | yes | no | partial |
| `system_logs` | restricted | no | no | partial |

`exportable: false` rows are EXCLUDED from the DSR export
preview because exporting them (active session tokens, security
logs) would itself be a security incident. Restricted-deletion
rows may be retained under a retention exception (security,
billing, legal hold).

Each row carries `vendorIds` linking to the Phase 9K vendor
registry so the data flow is traceable to every subprocessor.

---

## 3. Retention policy

`lib/enterprise/privacy/retention-policy.ts` documents the
target window + reason + automation status per category.

| Window | Categories | Automation |
|---|---|---|
| For the lifetime of the subscription (+ grace) | account_identity, venue_profile | manual |
| Mirrors lead retention (90d after lost) | lead_contact, lead_event_details, conversation_content, tour_scheduling | partial |
| 365-day target (no sweeper) | audit_metadata, abuse_security_metadata, sso_security_metadata, incident_metadata | manual |
| Billing/financial retention | billing_metadata | manual |
| Single-use / short-lived | auth_security_metadata | implemented |
| As-needed to honor opt-out | support_metadata | implemented |
| Vendor-governed | system_logs | partial |

**Honest gaps:**
- The audit / abuse / SSO / incident retention sweepers are NOT
  yet wired; those tables currently accumulate. Sweepers are on
  the planned-improvements list for a later phase, pending
  policy review with legal.
- Conversation-level PII redaction is NOT yet shipped — lead-
  level redaction (Phase 9D) is the operator-available path.

---

## 4. DSR lifecycle

Tracked in `public.dsr_requests` + `public.dsr_timeline_events`
(migration 033). Status flow:

```
received → triage → identity_verification → in_progress →
awaiting_legal_review → fulfilled / denied / cancelled
```

Each state transition writes a typed audit row:
`dsr_request_updated` for generic changes;
`dsr_request_fulfilled` / `dsr_request_denied` /
`dsr_request_cancelled` on terminal moves. The timeline carries
the operator-readable narrative.

Operator workflow (in DsrRequestsCard):

1. Click **+ New DSR**. Fill type / risk / subject email +
   name / requested-by email / due date / scope.
2. Move status to `triage`. Add notes.
3. Click **Mark identity verified** once subject identity is
   confirmed via your existing process (the platform does NOT
   verify identity automatically).
4. Move to `in_progress`. Run **Export preview** for access /
   export requests, or **Deletion review** for delete requests.
5. Move to `awaiting_legal_review` if the response carries
   contractual or jurisdictional risk. Append the legal review
   note.
6. Move to `fulfilled` / `denied` / `cancelled`. The
   appropriate timestamp + `closed_by` are stamped
   automatically.

---

## 5. Identity verification caveat

Identity verification is **operator-asserted**. The platform
does NOT ship an automated identity-verification flow today.
The **Mark identity verified** button stamps
`identity_verified_at` and writes an `identity_verified`
timeline event for traceability — but the operator is
responsible for actually confirming the subject's identity via
the existing process (e.g. email round-trip, OAuth proof,
out-of-band confirmation).

Do NOT mark identity verified without a real verification step.

---

## 6. Export preview (metadata-only)

`POST /api/admin/privacy/dsr-requests/[id]/export-preview`

Returns a JSON document listing:

- Which data categories WOULD be searched for this subject.
- Which categories are restricted from export (auth tokens,
  audit logs, abuse logs, SSO logs, incident records, system
  logs).
- Which subprocessors are involved per category.

Does **NOT** fetch any subject data. The audit row is
`dsr_export_previewed`; the DSR timeline gets an
`export_prepared` event.

Real exports happen via the operator-facing flows that already
exist:

- Venue-scoped JSON export via
  `/api/admin/data-export` (Phase 9D).
- Stripe billing export via the Stripe customer portal.
- Vendor-side exports (Sentry, Vercel) via the vendor
  dashboards.

All real exports require legal review.

---

## 7. Deletion review (non-destructive)

`POST /api/admin/privacy/dsr-requests/[id]/deletion-review`

Returns a JSON document with one row per data category:

- `deletable` — does an existing flow support deletion today?
- `anonymizable` — can we soft-redact instead (lead-level PII)?
- `retentionExceptionApplies` — does security / billing / legal
  retention block deletion?

Does **NOT** delete anything. The audit row is
`dsr_deletion_reviewed`; the DSR timeline gets a
`deletion_reviewed` event.

Real deletion happens via:

- `/api/admin/leads/[leadId]/redact-pii` for lead-level PII
  (Phase 9D).
- Operator-driven Supabase auth deletion for account identity.
- Vendor-side deletion for vendor-stored data.

All real deletions require legal review and must honor the
retention exceptions documented in §3.

---

## 8. What is automated vs manual

| Concern | Automated | Manual |
|---|---|---|
| DSR record + timeline + audit | yes | — |
| Status transitions | timestamp stamping | operator-initiated |
| Identity verification | timestamp stamping | operator confirms with subject |
| Export preview | category enumeration | real export under legal review |
| Deletion review | checklist generation | real deletion under legal review |
| Customer notification | never automatic | operator + legal |
| Retention sweepers | partial (auth, digest) | most categories operator-driven |

---

## 9. AI / vendor processing caveat

VenueRise does NOT train any AI models on customer data
internally. AI inference happens at Anthropic (lead
qualification + reply drafting + brand-voice calibration).

Anthropic's contractual posture on training-use and retention
(e.g. zero-retention configuration, training exclusion) is
governed by the active Anthropic plan and contract. Verifying
that posture requires legal review of the active contract — it
is NOT asserted automatically by this documentation.

**Do NOT claim** "we do not use your data for training" in
customer communication without confirmed contract terms from
the active Anthropic plan.

The vendor-registry row for Anthropic (Phase 9K) carries
`assuranceStatus = 'manual_review_required'` for this reason.

---

## 10. Security log retention caveat

Categories backing security investigations (audit_metadata,
abuse_security_metadata, sso_security_metadata,
incident_metadata, system_logs) are flagged
`deletable: false` in the inventory and carry a retention
EXCEPTION in the deletion review. Security/legal retention
obligations may override a subject deletion request for these
categories.

When a DSR scope intersects with security logs, route through
legal review before responding. The platform will not silently
purge these tables.

---

## 11. Buyer / legal questionnaire language

| Question | Honest answer |
|---|---|
| "Do you support DSRs?" | Yes. Operator-controlled workflow with typed audit trail. No anonymous intake yet. |
| "Can customers request deletion?" | Yes via the DSR workflow. Real deletion is operator + legal reviewed; some categories carry security/billing retention exceptions. |
| "Can customers request export?" | Yes via the DSR workflow. Real export is operator + legal reviewed. |
| "Do you have a retention policy?" | Yes — documented per-category in `lib/enterprise/privacy/retention-policy.ts`. Automation is partial today; security log sweepers are on the planned-improvements list. |
| "Do you store audit and security logs?" | Yes — audit, abuse, SSO, incident logs. No raw IPs (salted-SHA-256 only). Restricted from deletion. |
| "Do you automatically delete personal data?" | Partial. Auth sessions + digest sends auto-prune. Lead / conversation / billing data is operator-driven. We do not silently delete subject data. |
| "Do you sell customer data?" | No. Policy position; legal review required before contractual representation. |
| "Do you use customer data to train AI models?" | We do not train internally. AI inference happens at Anthropic; vendor training posture requires legal verification of the active contract. |

---

## 12. What NOT to claim

- Do **NOT** claim GDPR / CCPA / LGPD compliance.
- Do **NOT** promise a 30-day DSR fulfilment window unless
  contractually committed.
- Do **NOT** claim automated subject-initiated deletion.
- Do **NOT** claim "we do not use your data to train AI
  models" for vendor processing without confirmed contract
  terms.
- Do **NOT** auto-export or auto-delete subject data — every
  action routes through operator + legal review.

---

## 13. Known limitations

- Not a GDPR/CCPA/LGPD compliance claim.
- DSR fulfillment is operator + legal reviewed; the platform
  tracks the trail but does not fulfil automatically.
- Export preview is metadata-only.
- Deletion review is non-destructive.
- No anonymous DSR intake page yet.
- No automated identity-verification flow.
- Conversation-level PII redaction not yet shipped.
- Audit / abuse / SSO / incident retention sweepers not yet
  wired.
- AI / vendor processing terms (Anthropic training-use posture)
  require legal verification of the active contract.
- Vendor-side retention (Sentry, Vercel, Resend) is governed
  by vendor plan, not enforced here.
- Like audit_events + abuse_events, dsr_requests is RLS-gated
  but not WORM at the DB level.

---

## 14. Honesty disclaimer (carried in every render)

> Privacy readiness is not a legal compliance attestation.
> VenueRise does NOT claim GDPR / CCPA / LGPD compliance in
> this automated summary. Operator + counsel review is required
> before any external claim. DSRs are tracked, NOT
> auto-fulfilled. Export preview is metadata-only. Deletion
> review is non-destructive.

Identical string across the readiness summary, the export
preview, the deletion review, the static pack, the admin card
footers, and the evidence-map control descriptions so
downstream consumers can grep for it.

---

## 15. Phase 9N addendum — Privacy disclosure via Trust Center

The Phase 9N Trust Center includes a `privacy_readiness`
artifact at `standard_packet` and `full_packet` scope. This
artifact renders `buildPrivacyReadinessSummary()` — the same
data inventory + retention policy documented above — for buyer
consumption.

Important:

- The trust packet renders the privacy readiness summary
  WITHOUT a tenant context (no venueId), so DSR counts reflect
  the platform-wide aggregate (zero / zero in a buyer-facing
  packet, since DSRs are tenant-scoped). This is intentional —
  per-tenant DSR counts are not shared externally.
- The buyer-facing inventory + retention copy is the SAME copy
  the operator sees in the PrivacyReadinessCard. Review the
  copy in `lib/enterprise/privacy/data-inventory.ts` +
  `retention-policy.ts` before sending a `standard_packet` or
  `full_packet` grant to a buyer.
- Subject identity, DSR records, and legal review notes are
  NEVER emitted in any trust artifact — the inventory is
  metadata only.

When a buyer asks a privacy question that requires a packet,
issue a Trust Center grant (Phase 9N) rather than mailing a
one-off export. The grant carries the trail.

---

## 16. Phase 9O addendum — Privacy review cadence on the compliance calendar

The Phase 9O compliance operations calendar ships three
privacy-adjacent policy items:

- **`privacy-data-inventory-review`** — quarterly. Walk every
  row in `lib/enterprise/privacy/data-inventory.ts`. Stale
  after 120 days.
- **`retention-policy-review`** — semiannual. Confirm
  per-category windows still match intent. Stale after 210
  days.
- **`data-lifecycle-review`** — semiannual. Spot-check
  operator data export, lead PII redaction, and DSR workflow
  end-to-end. Stale after 210 days.

When the calendar flags any of these as overdue or stale,
the operator:

1. Runs the actual review (see §5–§8 of this document).
2. Updates the inventory / retention / DSR scaffolding as
   needed.
3. Records completion in ComplianceCalendarCard with notes
   + optional evidence URL.
4. Regenerates `npm run build:privacy-pack` if inventory or
   retention rows changed.

This closes the loop between Phase 9M (privacy + DSR
scaffolding) and Phase 9O (review discipline).
