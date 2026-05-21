# Vendor risk + subprocessor disclosure

_Phase 9K — Vendor Risk + Subprocessor Disclosure Pack._

This document describes how VenueRise tracks third-party
processors, what disclosures we publish, and what we explicitly
do **not** claim. It is the operator-facing companion to:

- `lib/enterprise/vendor-risk/types.ts`
- `lib/enterprise/vendor-risk/vendor-registry.ts`
- `lib/enterprise/vendor-risk/report.ts`
- `/api/admin/security/vendor-risk-report`
- `/api/admin/security/subprocessor-disclosure`
- `components/dashboard/settings/VendorRiskCard.tsx`
- `components/dashboard/settings/SubprocessorDisclosureCard.tsx`
- `scripts/build-vendor-risk-pack.mjs`
- `scripts/check-vendor-risk.mjs`

---

## 1. Purpose

Enterprise procurement and security review almost always ask
three questions:

1. **Which third parties process customer data?**
2. **What data does each of them receive?**
3. **Where is that disclosed?**

Phase 9K answers those questions from a single source of truth
(the registry), generates two distinct outputs (admin view +
buyer-safe disclosure), and ships a static pack generator so a
sales engineer can produce the artifacts offline.

This phase is **disclosure + procurement readiness**, not legal
attestation. Operators MUST review every output before sending.

---

## 2. Vendor / processor / subprocessor / infrastructure

Plain-language definitions used in this document:

| Term | Meaning |
|---|---|
| **Vendor** | Any third-party we contract with (paid or free) that touches VenueRise infrastructure or data. |
| **Processor** | A vendor that processes customer data on VenueRise's behalf (GDPR Art. 4(8) flavour). |
| **Subprocessor** | A processor we use *to deliver our product to a customer* — typically the rows shown in the buyer-facing disclosure. |
| **Infrastructure provider** | The runtime + storage backbone (deployment host, database vendor, CDN). Treated as a subprocessor for disclosure purposes when customer data flows through them. |

Practical rule of thumb: **if a buyer's data could pass through
the vendor's systems, it belongs in the buyer-facing
disclosure.** Tooling that never sees customer data (e.g. the
local `stripe:listen` CLI) belongs in the admin view only, with
`disclosureStatus = 'internal_only'`.

---

## 3. Data categories

`VendorDataCategory` (`lib/enterprise/vendor-risk/types.ts`) is
intentionally coarse — operational, not legal. A reviewer reading
the disclosure should be able to distinguish at a glance "does
this vendor see message content vs. just an IP fingerprint":

| Category | What it covers |
|---|---|
| `account_data` | Operator user profile, venue settings, team membership. |
| `lead_data` | Lead identity (name, email, phone, notes, event details). |
| `message_content` | Conversation message bodies (lead replies, drafts, sent replies). |
| `billing_data` | Stripe customer / subscription / invoice metadata. |
| `authentication_data` | Auth tokens, session ids, SSO connection state. |
| `audit_metadata` | Audit event rows + sanitized snapshots. Never raw IPs. |
| `usage_metadata` | Rate-limit counters, request rates, fingerprint hashes. |
| `support_metadata` | Operator-submitted tickets / context for support. |
| `infrastructure_logs` | Request/response logs at the platform layer (method, path, status, latency). |
| `calendar_metadata` | Tour calendar invite metadata when applicable. |
| `email_metadata` | Recipient address, delivery status, bounce/complaint signals. |
| `none` | Vendor receives no customer data (e.g. internal dev tooling). |

When in doubt, **list the broader category**. Under-disclosure
is the riskier failure mode.

---

## 4. The registry

`lib/enterprise/vendor-risk/vendor-registry.ts` is the
hand-maintained source of truth. Each row is a `VendorRecord`
with the following fields:

- `id`, `name`, `category`, `purpose` — operator-facing
  description.
- `criticality` — `critical` (production runtime depends on it),
  `important` (production-use but degradable), `optional`
  (nice-to-have), `development_only` (never touches production).
- `disclosureStatus` — `public` (ships in buyer disclosure),
  `admin_only` (stays in admin card), `internal_only`
  (dev tooling only; admin card only).
- `dataCategories` — see §3.
- `productionUse` — boolean. Drives the "production" count in
  the buyer disclosure header.
- `buyerSafeDescription` — the paragraph that ships to
  procurement. Curated; must avoid internal architecture
  details.
- `riskTier` — `low` / `medium` / `high` / `unknown`. Based on
  data sensitivity + criticality.
- `assuranceStatus` — `verified` / `manual_review_required` /
  `unknown` / `not_applicable`. **Defaults to
  `manual_review_required` for every vendor** until legal review
  confirms otherwise.
- `evidence` — `kind: 'doc' | 'env' | 'package' | 'file' |
  'route' | 'note'` references. `env` entries hold the variable
  name only, never the value.
- `knownLimitations` — operator-visible caveats.
- `reviewOwner` — function/team that owns the next review.
- `reviewCadence` — plain-language cadence ("annually", "on
  renewal", "on tooling change").
- `lastReviewedAt` — ISO date string or `null`. **null is
  honest**; it means "never formally reviewed."

---

## 5. How to review a vendor

The review itself happens **outside this repository** because
the evidence (DPA PDFs, SOC 2 reports, SCC addenda) is licensed
material and often gated by NDA.

Workflow:

1. **Pull the latest vendor evidence** from the vendor's trust
   centre / dashboard / sales contact.
2. **Confirm**:
   - DPA executed (date + version).
   - SCCs in place if cross-border data flows apply.
   - SOC 2 report current (if applicable to vendor).
   - Sub-region selection if data residency matters.
   - Breach notification + sub-processor change notification
     terms.
3. **Update the registry row**:
   - Set `lastReviewedAt` to today's ISO date.
   - If evidence is on file and operator is confident,
     `assuranceStatus` MAY move to `verified`. **Default to
     `manual_review_required` if there is any doubt.**
   - Update `knownLimitations` if anything new came up.
4. **Commit the registry change** with a reference to the
   external evidence location (e.g. shared drive folder id).
5. **If the vendor changed sub-processors**, regenerate the
   buyer disclosure (`npm run build:vendor-risk-pack`) and
   re-share with affected buyers per their notification SLA.

---

## 6. What to say to buyers

| Buyer question | Honest answer |
|---|---|
| "Do you use subprocessors?" | Yes. A subprocessor list is maintained inside the platform and exported on demand. |
| "Can you provide a list?" | Yes — download the markdown/CSV from `/api/admin/security/subprocessor-disclosure` (operator action, audited). Review before sending. |
| "Do you have DPAs?" | "DPAs are tracked as part of vendor contracts outside the application. We default to manual review on every vendor and confirm evidence per the cadence on each row. Legal review is required before contractual representation." |
| "Are your vendors SOC 2 / ISO compliant?" | "Vendor attestation reports are downloaded from each vendor and reviewed at the cadence noted on the registry row. We do not automatically verify or revalidate vendor certifications inside this platform." |
| "Where does customer data sit?" | Disclose the production subprocessors + their default regions (e.g. Supabase US, Vercel US). If region selection matters, confirm against the active vendor configuration before answering. |
| "Are you SOC 2 certified?" | "No. VenueRise is NOT currently SOC 2 certified. We maintain an internal SOC 2-style evidence map (see `docs/SOC2-EVIDENCE-MAP.md`). Engagement with a SOC 2 auditor is on the planned-improvements list." |

---

## 7. What NOT to say

- **Never say "we are compliant" for a third-party vendor.**
  Compliance is a contractual representation. The rendered
  outputs use "manual review required" — keep that phrasing.
- **Never claim a DPA exists unless the executed copy is on
  file and confirmed by legal.** The registry defaults to
  manual review for a reason.
- **Never expose evidence env vars or package names in a
  buyer-facing output.** The subprocessor disclosure route
  strips them; only the admin export carries them.
- **Never claim certifications you have not verified this
  quarter** — vendor SOC 2 reports lapse, scopes change, and
  attestations are point-in-time. Re-confirm before answering.

---

## 8. Review cadence

| Vendor class | Cadence |
|---|---|
| Critical (Supabase, Stripe, Vercel) | Annually + on plan change. |
| Important (Resend, Anthropic, Inngest, Sentry, Upstash) | Annually. |
| Optional / development-only | On tooling change. |
| After any vendor security incident | Immediately, regardless of cadence. |

Operators record completion by editing `lastReviewedAt` on the
registry row.

---

## 9. How to update the registry

1. Edit `lib/enterprise/vendor-risk/vendor-registry.ts`.
2. Run `npm run check:vendor-risk` — confirms file/UI/script
   scaffolding is in place AND that every production SDK in
   `package.json` has a registry row. A new SDK without a row
   fails the check.
3. Run `npm run build:vendor-risk-pack` to regenerate the static
   pack under `artifacts/evidence/vendor-risk/`.
4. If the change affects buyer-facing rows
   (`disclosureStatus === 'public'`), re-send the disclosure to
   active enterprise prospects per their sub-processor change
   notification SLA.

---

## 10. Known limitations

- **Vendor legal/security assurance still requires human
  review.** No automation will read a DPA PDF and tell you
  whether it covers your use case.
- **DPA / SCC / SOC 2 status is not automatically verified.**
  Every row defaults to `manual_review_required`.
- **Buyer-facing disclosure must be reviewed before sharing.**
  The markdown export is a draft, not a contract.
- **A public `/security/subprocessors` page is OPTIONAL and is
  not shipped in 9K.** Disclosure ships from the admin surface
  today; once disclosure copy has been reviewed by legal, a
  public page can be added without changing the registry shape.
- **The registry can drift if new vendors are added without
  updating it.** The check-vendor-risk scanner only flags
  packages it has been taught about — manual review on PR is
  still required.
- **`lastReviewedAt = null` is the registry default.** That is
  honest. It is NOT a bug.
- **Evidence artifacts live outside source control.** DPA PDFs,
  SOC 2 reports, and SCC addenda are licensed material and are
  tracked in the operator's secure evidence repository, not in
  Git.

---

## 11. Honesty disclaimer (carried in every render)

> This disclosure is for security review and procurement
> support. It is not legal advice or a contractual
> representation. Vendor SOC 2, DPA, SCC, and ISO posture must
> be verified against the vendor's current evidence before
> relying on any contractual commitment. Operators MUST review
> before sending to a buyer.

The string is identical across the runtime endpoint, the admin
card, the buyer disclosure, and the static pack so downstream
consumers can grep for it.

---

## 12. Phase 9L addendum — Slack / PagerDuty as optional alert vendors

Phase 9L added Slack and PagerDuty to the vendor registry as
**optional, env-gated** incident alert routing vendors. They
are `disclosureStatus = 'admin_only'` by default so they do NOT
appear in the buyer-facing subprocessor disclosure unless an
operator deliberately promotes them after enabling alert
routing in production.

| Vendor | Disclosure default | Trigger to promote |
|---|---|---|
| Slack | admin_only | `INCIDENT_ALERTS_ENABLED=true` + `INCIDENT_SLACK_WEBHOOK_URL` configured AND incident metadata flowing in production. |
| PagerDuty | admin_only | `INCIDENT_ALERTS_ENABLED=true` + `INCIDENT_PAGERDUTY_ROUTING_KEY` configured AND a staffed rotation. |

What they receive: incident **metadata only** (id, title,
severity, status, category, source, dashboard URL). No customer
message content, no lead PII, no audit snapshots. The alert
payload is intentionally narrow — see
`lib/enterprise/incidents/alert-routing.ts → buildPayload`.

What is NEVER stored alongside an alert attempt: the webhook
URL, the routing key, or the raw response body. The
`incident_alert_deliveries` row holds the operator-readable
label only ("#incident-alerts", "venuerise-platform").

Operator discipline:

- Before promoting Slack/PagerDuty to `disclosureStatus =
  'public'`, regenerate the buyer disclosure
  (`npm run build:vendor-risk-pack`) and verify the
  buyer-safe description is accurate for the configured
  posture.
- Promoting these rows implies the operator is committing to
  the vendor relationship visible to buyers — usually paired
  with the corresponding DPA on file.

See `docs/INCIDENT-RESPONSE.md` §5 for the alert routing
behaviour + env contract.

---

## 13. Phase 9M addendum — Anthropic AI training-use caveat

Phase 9M extends the vendor risk discipline with an explicit
privacy-questionnaire answer about AI model training
(`ai-training-use` in `lib/enterprise/evidence/
questionnaire-map.ts`).

VenueRise does **NOT** train any AI models on customer data
internally. AI inference happens at **Anthropic** (the vendor
registered in §VENDOR-REGISTRY as `anthropic`, criticality
`critical`, assurance `manual_review_required`).

Anthropic's contractual posture on **training use** (e.g.
zero-retention configuration, training exclusion) is governed
by the active Anthropic plan and contract. Verifying that
posture requires legal review of the active Anthropic
agreement — it is NOT asserted automatically by the
questionnaire generator or the vendor registry.

**What to say to a buyer:**

> "VenueRise does not train AI models on customer data
> internally. AI inference is processed by Anthropic; their
> training-use and retention posture for our account is
> governed by our active Anthropic contract. Our legal team
> can confirm the current contractual terms on request."

**What NOT to say:**

> ~~"We never use your data for AI training, even at our
> vendor."~~ — requires confirmed Anthropic contract terms
> before making this representation.

> ~~"Anthropic has a zero-retention agreement with us."~~ —
> requires the executed contract on file.

When the operator confirms Anthropic contract terms with legal,
update the `anthropic` row in the vendor registry with the
relevant `knownLimitations` removal + set `lastReviewedAt` to
the review date. The privacy readiness check
(`scripts/check-privacy-readiness.mjs`) asserts the
documentation cross-reference exists; it does NOT validate the
contract terms.

---

## 14. Phase 9N addendum — Trust Center public disclosure

Phase 9N's public `/trust` page now ships the buyer-facing
subprocessor NAMES extracted directly from this registry's
`disclosureStatus === 'public'` rows. The full data-category +
risk-tier disclosure remains gated behind a bearer-token
grant — see `docs/TRUST-CENTER.md`.

What this means for the registry process:

- Promoting a vendor from `admin_only` to `public` makes that
  vendor's NAME appear on the public Trust Center page on the
  next cache revalidation (5 min).
- Promoting also makes the row eligible for inclusion in
  every gated subprocessor disclosure download.
- The buyer-safe description on each row remains the
  authoritative copy — review it before promoting.

When in doubt, leave `disclosureStatus = 'admin_only'` and
promote only after the operator workflow + legal review.

---

## 15. Phase 9O addendum — Vendor risk review on the compliance calendar

The Phase 9O compliance operations calendar (`docs/COMPLIANCE-OPS.md`)
ships two vendor-risk-adjacent policy items:

- **`vendor-risk-review`** — quarterly walk of every vendor
  registry row. Confirm DPA / SCC / SOC 2 evidence is current
  outside the repo. Update `lastReviewedAt` +
  `assuranceStatus`. Stale after 120 days.
- **`subprocessor-disclosure-review`** — quarterly review of
  the buyer-facing subprocessor list. Promote / demote
  `disclosureStatus` as relationships change. Stale after
  100 days.

Operators record completion via the ComplianceCalendarCard
with `evidenceUrl` pointing at the shared drive folder holding
the external DPA / SOC 2 review artifacts.

When the calendar flags either review as overdue or stale, the
operator:

1. Runs the actual walk (see §5 of this document).
2. Updates `vendor-registry.ts` rows + `lastReviewedAt`.
3. Records completion in ComplianceCalendarCard with notes.
4. Regenerates `npm run build:vendor-risk-pack` if registry
   rows changed.

This closes the loop between Phase 9K (vendor registry) and
Phase 9O (review discipline).
