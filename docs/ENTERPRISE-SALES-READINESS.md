# Enterprise Sales Readiness — Phase 9J

## Purpose

Phase 9J turns the Phase 9I evidence system into practical
sales assets:

1. A security questionnaire response generator that pre-fills
   the obvious answers from the evidence control map.
2. A buyer-facing prose security summary suitable for emailing
   after a sales call.
3. A demo-mode visual marker for screen-shared enterprise demos.
4. An admin-facing readiness checklist.
5. Sales-safe export endpoints.

This phase does NOT generate fake evidence. Every output is
derived from existing controls + clearly marks what's
implemented vs partial vs manual vs planned.

## What the generated questionnaire IS and is NOT

**IS.** A pre-fill of the obvious answers for common security
questionnaires (CAIQ-Lite, SIG-Lite, VSAQ-Lite, generic). The
answers reflect the current state of the codebase + the
evidence control map. Each answer carries:

- A status (`yes` / `partial` / `manual` / `planned` / `no` /
  `not_applicable`).
- Buyer-safe short-form wording (≤ 1 paragraph).
- Evidence control ids the answer is backed by.
- Limitations named honestly.

**IS NOT.** A finished response. Operators MUST review every
answer before sending to a buyer. The disclaimer is repeated
on the card, in the markdown export, and in the CSV header.
The audit row `questionnaire_response_exported` captures the
forensic trail of "who handed which answer set to which buyer."

## How to generate buyer-facing security assets

### Live (recommended — has session)

1. Sign in to `/dashboard/settings/billing` as admin/owner.
2. **Questionnaire response**: scroll to the Security
   Questionnaire Generator card. Pick a framework (generic /
   CAIQ-Lite / SIG-Lite / VSAQ-Lite). Click **Download
   Markdown** or **Download CSV**.
3. **Buyer security summary**: scroll to the Buyer Security
   Summary card. Click **Download Markdown**.
4. **Open the downloaded markdown.** Read every answer.
   Edit anything that's stale or buyer-inappropriate. Replace
   placeholder bracketed text.
5. Send the reviewed file as an attachment or paste into the
   buyer's questionnaire tool.

### Static (no session — for sales engineers without dashboard access)

1. `npm run build:evidence-pack` writes the Phase 9I evidence
   pack to `artifacts/evidence/`.
2. `npm run build:questionnaire-pack` writes the Phase 9J
   questionnaire + buyer summary to
   `artifacts/evidence/questionnaires/`.
3. Same review-before-sending rule applies. The static pack
   does NOT include the embedded evidence summary (live state)
   or the backup posture snapshot — those need the live
   endpoint.

## How to use the BuyerSecuritySummary

Email format that works for most enterprise prospects:

> Subject: VenueRise security overview — follow-up to our call
>
> Hi [Name],
>
> Per your security team's request, attached is a short
> security overview of VenueRise covering access control,
> audit logging, backup/DR, SSO readiness, data protection,
> rate limiting, and incident response. We're not currently
> SOC 2 certified — the overview covers what's in place today,
> our known limitations, and our roadmap.
>
> Happy to walk through any section on a call with your
> security team.

Attach the markdown from `/api/admin/security/buyer-security-summary?format=markdown`
or `artifacts/evidence/questionnaires/buyer-security-summary.md`.

## Demo mode behavior and limitations

**What it does.**
- Flips a venue-wide `demo_mode_enabled` flag.
- Renders a "DEMO MODE" banner below the dashboard topbar with
  the operator-supplied label (≤120 chars).
- Stamps `demo_mode_started_at` + `demo_mode_started_by` on
  the OFF→ON edge so the audit row carries provenance.
- Writes a `demo_mode_updated` audit row with before/after.

**What it does NOT do.**
- Anonymize production data. Names, emails, and message bodies
  remain visible.
- Restrict who can read the venue. RBAC stays exactly the same.
- Change any business logic. AI generation, rate limits,
  webhooks, billing — all unaffected.

**When to use.**
- Screen-shared enterprise demo where the audience needs to
  know they're looking at a real venue.
- Sales engineer recording a Loom on production data.
- QA / staging environments to differentiate from production.

**When NOT to use.**
- As a substitute for the Phase 9D data export / PII redaction.
- To prevent operator mistakes — it's a visual hint, not a
  guardrail.

Owner-only toggle. Application-layer gate enforces; admins see
a `forbidden` error if they try to flip it.

## How to answer common buyer questions

### "Are you SOC 2 compliant?"

> No, VenueRise is not currently SOC 2 certified. The platform
> organizes its existing controls into a SOC 2-style evidence
> map (see internal docs/SOC2-EVIDENCE-MAP.md). Formal
> certification requires an auditor engagement + observation
> period; we haven't started that yet. We're happy to share the
> evidence package or schedule a security review.

### "Do you support SSO?"

> SSO scaffolding is in place — connection management,
> audit feed, owner-only mutations, vendor adapter interface
> supporting WorkOS, Clerk, Stytch, Supabase SSO, and custom
> OIDC. Real SAML/OIDC exchange is wired vendor-by-vendor per
> buyer requirement. Wiring a real adapter is a single-file
> change documented in our internal docs/SSO-READINESS.md.
> No SCIM provisioning yet.

### "What is your backup/DR process?"

> Daily managed backups with point-in-time recovery via
> Supabase. Recovery Time Objective: 4 hours. Recovery Point
> Objective: 24 hours. Quarterly disaster-recovery dry runs
> against a clone project. Restores are performed through
> approved Supabase workflows by VenueRise staff; the product
> UI never executes a restore. Operators file restore intents
> via an audit-only endpoint before any out-of-app work begins.

### "Where is customer data stored?"

> Customer data lives in the configured Supabase region (US by
> default; other regions available per Supabase plan).
> EU-resident customers can be provisioned on a Supabase EU
> project on request. Encryption at rest is AES-256 at the
> Supabase storage layer; encryption in transit is HTTPS
> enforced via HSTS.

### "How do you handle PII?"

> Lead-level PII (name, email, phone, notes) supports soft
> redaction via an admin endpoint while preserving operational
> history (conversations + tours stay intact). Audit snapshots
> are sanitized at write time — sensitive keys (password,
> secret, token, etc.) are recursively dropped, and snapshots
> are size-capped at 4 KB. No raw IPs are stored anywhere; the
> salted-SHA-256 fingerprint is used.

### "Can we export our data?"

> Yes. Owners and admins can export the full venue-scoped
> dataset as JSON via a self-service endpoint. The export
> includes leads, conversations, messages, tours, AI actions,
> and optionally the audit feed. Inline cap is 8 MB; oversize
> exports are on the roadmap.

### "How do you rate-limit?"

> Upstash Redis sliding-window with per-bucket budgets:
> widget intake (10/min/IP/venue), AI generation (60/min/
> user-resource), user actions (30/min/user), CSP report
> (60/min/IP), SSO auth (10/min/IP/domain). A static scanner
> verifies coverage on every build. Rate-limit blocks
> populate an internal abuse-events table visible to
> owners/admins.

## Review-before-sending checklist

Before you forward any generated questionnaire response or
buyer summary, walk through this:

- [ ] Is the disclaimer present? (First paragraph of every
      generated file.)
- [ ] Is the SOC 2 certification answer honest? It should say
      "not currently certified."
- [ ] Are SSO-related answers honest? They should say "readiness
      mode" or "wired per buyer requirement," not "live."
- [ ] Does the answer set match the actual buyer? E.g. if the
      buyer is asking about EU data residency, did the EU
      project caveat surface?
- [ ] Are limitations named? Every `partial` answer should
      carry a one-line gap note.
- [ ] Have you replaced any TODO/placeholder text?
- [ ] If you mention WorkOS / a specific vendor, is that
      actually wired? Today only the placeholder adapter is in
      place; don't promise a specific vendor unless we've
      committed.

## Known limitations

- **Questionnaire answers still need human review before
  sending.** The generator is a starting point, not a finished
  response. Buyer-specific context, custom questions, and
  nuance always need an operator pass.
- **Demo mode is a visual marker, not data anonymization.**
  Use Phase 9D PII redaction + data export for actual
  anonymization.
- **Not SOC 2 certified.** Formal certification requires an
  auditor engagement + observation period that hasn't
  happened.
- **Real SAML/OIDC and SCIM remain future work.** The vendor
  adapter today resolves to a placeholder. Connections
  persist; the auth handshake doesn't.
- **Backup live metadata still depends on the Phase 9H
  optional Supabase Management API env vars.** Without them
  the questionnaire backup-strategy answer + the
  BackupPostureCard show `unknown` for live PITR.
- **No CAIQ / SIG full mappings yet.** The `*-lite` formats
  are illustrative subsets — a full CAIQ has 261 questions
  versus our 16-or-so curated set. Expanding the mappings is
  iterative work as buyer demand surfaces specific gaps.
- **Static pack omits the embedded evidence summary +
  backup snapshot.** Live endpoint required for those.

## Phase 9K — Vendor risk + subprocessor disclosure

After the questionnaire response + buyer security summary, the
next procurement gate is usually **"Send us your subprocessor
list."** Phase 9K closes that gap:

- `/api/admin/security/vendor-risk-report` (admin/owner;
  JSON / markdown / CSV) — full admin view of the registry
  with evidence references intact.
- `/api/admin/security/subprocessor-disclosure` (admin/owner;
  JSON / markdown / CSV) — buyer-safe filtered view; only
  vendors with `disclosureStatus === 'public'`; evidence
  references stripped.

Operator workflow when a buyer asks for subprocessors:

1. Open `/dashboard/settings/billing` (admin or owner).
2. **Vendor risk + assurance card** — confirm registry counts
   match expectations (8 production vendors today; review
   the manual-review-required count).
3. **Subprocessor disclosure card** — click `Download
   Markdown` for the buyer-facing list.
4. Review every line of the markdown before sending. The
   disclaimer line stays in.
5. Send. The export is audited
   (`subprocessor_disclosure_exported`) and traceable in the
   EnterpriseAuditEventsCard.

Static (offline) pack:

```bash
npm run build:vendor-risk-pack
# → artifacts/evidence/vendor-risk/vendor-risk-report.md
# → artifacts/evidence/vendor-risk/vendor-risk-report.csv
# → artifacts/evidence/vendor-risk/subprocessor-disclosure.md
# → artifacts/evidence/vendor-risk/subprocessor-disclosure.csv
# → artifacts/evidence/vendor-risk/vendor-risk-summary.json
```

The static pack is useful when a sales engineer needs the
artifacts without a live admin session. It is the same shape
the live endpoint produces.

### Honesty rules for vendor responses

- We do NOT claim DPA / SCC / SOC 2 verification automatically
  — every vendor row defaults to `manual_review_required`.
- We do NOT publish a public `/security/subprocessors` page
  yet — disclosure ships from the admin surface and is
  reviewed before sharing.
- See `docs/VENDOR-RISK.md` for the full review workflow +
  "what to say / what NOT to say" tables.

## Phase 9L — Incident response

Procurement questionnaires consistently ask about incident
response process, detection, and breach notification. Phase 9L
ships the first-class incident layer that backs honest answers
to those questions.

Operator workflow when a buyer asks "do you have incident
response?":

1. Open `/dashboard/settings/billing` (admin or owner).
2. **Incident response card** — confirm counts (open /
   investigating / sev1+2 / resolved last 30 days) match
   internal expectations.
3. For procurement evidence, regenerate the static pack:

   ```bash
   npm run build:incident-response-pack
   # → artifacts/evidence/incidents/incident-response-runbook.md
   # → artifacts/evidence/incidents/post-incident-review-template.md
   # → artifacts/evidence/incidents/incident-severity-matrix.csv
   # → artifacts/evidence/incidents/incident-response-summary.json
   ```

4. The buyer security summary (Phase 9J) already has an
   `incident-response-detail` section; the markdown export
   includes it automatically.
5. The questionnaire generator (Phase 9J) emits answers for
   `incident-process`, `incident-detection`,
   `incident-customer-notification`, `incident-postmortem`,
   and `monitoring-24x7` — all honest about what is and is not
   automated.

### Honesty rules for incident response answers

- We do NOT claim 24/7 monitoring. The `monitoring-24x7`
  questionnaire answer is `no` by default.
- We do NOT claim contractual uptime SLAs.
- We do NOT claim automated breach notification — the
  customer-notification policy column ranges from
  `required_legal_review` (SEV1) down to `not_required` (SEV4).
- We do NOT claim automated remediation. Operators perform all
  remediation steps; the platform records the trail.
- See `docs/INCIDENT-RESPONSE.md` §11 / §12 for the full "what
  not to say" + known limitations tables.

## Phase 9M — Privacy + DSR readiness

Procurement and legal teams always ask about personal data:
what's collected, how long it's kept, and how subject requests
are handled. Phase 9M closes that gap.

Operator workflow when a buyer/legal asks "do you have privacy
controls?":

1. Open `/dashboard/settings/billing` (admin or owner).
2. **PrivacyReadinessCard** — surface the data inventory +
   retention policy + DSR counts.
3. **DsrRequestsCard** — show the operator workflow.
4. For procurement evidence, regenerate the static pack:

   ```bash
   npm run build:privacy-pack
   # → artifacts/evidence/privacy/privacy-readiness-report.md
   # → artifacts/evidence/privacy/data-inventory.csv
   # → artifacts/evidence/privacy/retention-policy.csv
   # → artifacts/evidence/privacy/dsr-workflow.md
   # → artifacts/evidence/privacy/privacy-summary.json
   ```

5. The buyer security summary (Phase 9J) already has a
   `privacy-dsr-readiness` section; the markdown export
   includes it automatically.
6. The questionnaire generator (Phase 9J) emits answers for
   `dsr-support`, `dsr-export-delete`, `retention-policy`,
   `audit-logs-retained`, `automatic-deletion`, `no-data-sale`,
   `ai-training-use` — all honest about what is and is not
   automated.

### Honesty rules for privacy answers

- We do NOT claim GDPR / CCPA / LGPD compliance.
- DSRs are tracked, NOT auto-fulfilled.
- Export preview is metadata-only.
- Deletion review is non-destructive.
- AI training-use answer is cautious: VenueRise does not train
  internally, but vendor (Anthropic) contractual posture
  requires legal verification.
- See `docs/PRIVACY-DSR-READINESS.md` §11 / §12 / §13 for the
  full buyer-question scripts + "what NOT to claim" tables +
  known limitations.

## Phase 9N — Trust Center

Trust Center turns the prior phases into a controlled
buyer-facing surface: one URL instead of manually explaining
security, privacy, subprocessors, and incident response every
time.

Operator workflow when a buyer enters a security review:

1. Send the public `/trust` URL as the initial contact.
2. Once the buyer / NDA is in place, open
   `/dashboard/settings/billing` → **Trust access grants** →
   **New grant** → scope `standard_packet` → send the URL
   (shown ONCE).
3. For active enterprise security review (auditor present),
   issue a `full_packet` grant after legal review.
4. Monitor access via the TrustAccessGrantsCard (access count
   + last-accessed timestamp + access events feed).
5. Revoke when the review concludes or if the URL is suspected
   leaked.

Static pack for offline review:

```bash
npm run build:trust-center-pack
# → artifacts/evidence/trust-center/public-trust-summary.md
# → artifacts/evidence/trust-center/standard-trust-packet.md
# → artifacts/evidence/trust-center/full-trust-packet.md
# → artifacts/evidence/trust-center/trust-center-summary.json
```

### Honesty rules for Trust Center

- Trust Center is NOT a SOC 2 certification.
- Bearer links are credentials — share carefully and revoke
  when no longer needed.
- Public page exposes only public-safe summaries (curated copy
  + buyer-disclosable vendors).
- Legal review is required for `full_packet` grants.
- No PDF renderer in 9N; markdown / CSV / JSON only.

## Phase 9O — Compliance operations calendar

Buyers in active security review ask "when was your last
DR drill / vendor review / tabletop?" 9O makes the answer
look like a real operational discipline, not marketing copy.

Operator workflow when a buyer asks:

1. Open `/dashboard/settings/billing` → ComplianceCalendarCard.
2. Show per-area Last Completed / Status / Stale flag.
3. Click `Freshness MD` → download
   `venuerise-compliance-freshness-YYYY-MM-DD.md`.
4. Review every line before sending; redact any internal
   review notes that name individuals or expose
   non-buyer-safe context.
5. Send the markdown after legal review.

Static pack for offline review:

```bash
npm run build:compliance-ops-pack
# → artifacts/evidence/compliance-ops/compliance-review-policy.md
# → artifacts/evidence/compliance-ops/compliance-review-policy.csv
# → artifacts/evidence/compliance-ops/compliance-freshness-template.md
# → artifacts/evidence/compliance-ops/compliance-ops-summary.json
```

The pre-NDA share is the policy + cadence matrix only (no
per-venue completion timestamps). The post-NDA share can
include the live freshness export.

### Honesty rules for compliance calendar answers

- The calendar tracks OPERATOR reviews — NOT continuous
  compliance monitoring.
- Completion is operator-marked; waivers carry an explicit
  reason.
- Stale flag is a soft signal, not a control failure.
- No autonomous rotation, no autonomous artifact refresh.
- See `docs/COMPLIANCE-OPS.md` §3 / §9 for the full
  "what NOT to claim" tables.

## Phase 9P — Contract commitments register

Sales conversations + signed contracts generate
customer-specific obligations. 9P prevents those obligations
from disappearing into PDFs and email threads, and surfaces a
soft warning when sales records a commitment the product does
not actually support today.

Operator workflow when sales closes a deal with commitments:

1. After signature, walk the contract for venue-specific
   commitments differing from the baseline product.
2. Open `/dashboard/settings/billing` →
   CommitmentsRegisterCard → `+ New commitment` for each one.
3. Check CommitmentsReadinessCard immediately for
   unsupported-risk flags. Walk each flag with the buyer or
   move the commitment to `withdrawn`.
4. Move surviving commitments to `active` once signed +
   committed.
5. On the Phase 9O compliance calendar, schedule the next
   commitment review.

When sales asks "what did we promise this buyer?":

1. CommitmentsRegisterCard → filter by buyer company.
2. Review every row + the evidence URL.
3. For internal sharing, download the CSV.
4. For external sharing, download the readiness markdown
   AFTER redacting buyer-specific titles + notes.

### Honesty rules for commitments

- Register tracks OPERATOR-RECORDED commitments — NOT
  contract parsing.
- Warnings are advisory; the platform does NOT block
  recording of an unsupported commitment.
- NOT legal advice; NOT contractual compliance proof.
- See `docs/CONTRACT-COMMITMENTS.md` §10 / §11 for full
  buyer-language scripts + "what NOT to claim" tables.
