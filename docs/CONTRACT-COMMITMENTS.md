# Contract commitments register

_Phase 9P — Contract Commitments Register + Legal Ops Readiness._

This document is the operator-facing companion to:

- `lib/enterprise/commitments/types.ts`
- `lib/enterprise/commitments/policy.ts`
- `lib/enterprise/commitments/commitments.ts`
- `lib/enterprise/commitments/readiness.ts`
- `supabase/migrations/036_contract_commitments.sql`
- `app/api/admin/security/commitments/*`
- `components/dashboard/settings/CommitmentsRegisterCard.tsx`
- `components/dashboard/settings/CommitmentsReadinessCard.tsx`
- `scripts/build-commitments-pack.mjs`
- `scripts/check-commitments.mjs`

---

## 1. Purpose

Enterprise procurement reviews + signed MSAs / DPAs / security
addenda generate **customer-specific commitments** — promises
that apply only to a particular buyer. Without a register,
those commitments live in scattered PDFs, Notion docs, and
sales emails, and nobody knows which ones the product still
actually supports.

Phase 9P is the register. Every commitment carries buyer
identity + source type + area + status + risk + owner + due /
review dates + evidence URL + free-form notes. The platform
surfaces an **unsupported-risk warning** when a commitment
references a capability we do not fully support today, so the
operator can rectify with the buyer before marking it active.

> **What it does not prove.** This register is a tracking /
> readiness workflow. It is **NOT** legal advice and does
> **NOT** prove contractual compliance. The platform does NOT
> autonomously parse contracts and does NOT auto-create
> commitments from uploaded documents.

---

## 2. What gets recorded

Every commitment carries:

| Field | Purpose |
|---|---|
| `buyer_name` / `buyer_company` / `buyer_email` | Who the commitment is to. |
| `source_type` | Where it came from: `msa`, `dpa`, `security_addendum`, `order_form`, `trust_grant`, `email`, `other`. |
| `commitment_area` | What it is about: `security`, `privacy`, `availability`, `support`, `data_retention`, `subprocessor`, `sso`, `scim`, `incident_response`, `backup_dr`, `ai_use`, `data_residency`, `other`. |
| `title` + `description` | Operator-curated summary of the commitment. |
| `status` | `draft` → `active` → `fulfilled` / `at_risk` / `expired` / `withdrawn`. |
| `risk_level` | `low` / `medium` / `high` / `critical`. |
| `owner_user_id` | Operator accountable for the commitment. |
| `due_at` | When the commitment must be fulfilled. |
| `review_at` | When we should re-check whether we still meet it. |
| `evidence_url` | External pointer to the artifact backing the commitment (shared drive doc, ticket, contract section). |
| `internal_notes` | Operator-only context. |

The timeline records every status change, risk change, review,
fulfilment, and note. Operators DELETE nothing — commitments
move to `withdrawn` to preserve the trail.

---

## 3. What the platform does NOT do

- Does **NOT** parse uploaded contract PDFs to create
  commitments automatically.
- Does **NOT** generate legal advice or contract recommendations.
- Does **NOT** prove a commitment was met — that is operator
  + legal judgement.
- Does **NOT** auto-rotate or refresh anything when a
  commitment is recorded.
- Does **NOT** block operators from recording an unsupported
  commitment — warnings are advisory.

---

## 4. Unsupported-risk warnings

`lib/enterprise/commitments/policy.ts` encodes the current
per-area support posture. Areas flagged below surface a soft
warning in the CommitmentsReadinessCard when a commitment is
recorded against them:

| Area | Posture | Why |
|---|---|---|
| `sso` | partial | SSO is in readiness mode. Vendor adapter is a placeholder; real SAML/OIDC is wired per buyer requirement. |
| `scim` | not_supported | SCIM provisioning is NOT live. |
| `availability` | partial | No 24/7 on-call rotation, no uptime SLA contract. |
| `incident_response` | partial | Alert routing env-gated, OFF by default. No automated breach notification. |
| `privacy` | partial | DSR fulfillment is operator + legal reviewed. Export preview metadata-only. |
| `data_retention` | partial | Audit / abuse / SSO / incident sweepers not yet wired. |
| `ai_use` | partial | Anthropic training-use posture requires legal verification of the active contract. |
| `subprocessor` | partial | No automated subprocessor-change notification cron. |
| `data_residency` | partial | Default Supabase US region; EU provisioning per-tenant. |

Additionally, **critical-risk commitments** in `security`,
`privacy`, `incident_response`, or `backup_dr` carry a soft
prompt to confirm operator + legal review.

### 4a. Overclaim trap patterns

Beyond the area table, `OVERCLAIM_PATTERNS` in `policy.ts`
scans the operator-entered **title + description** for
forbidden marketing phrases regardless of which area was
picked. Each match surfaces an additional flag whose reason
is prefixed with `[overclaim:<id>]` so the operator can
restate the commitment or move it to `withdrawn`.

| Trap id | What it catches |
|---|---|
| `soc2-certification` | "SOC 2 certified", "SOC 2 Type II", "SOC 2 compliant" — VenueRise is NOT SOC 2 certified. |
| `iso27001-certification` | Any mention of "ISO 27001" — not certified. |
| `hipaa-compliance` | "HIPAA compliant / ready / certified" — no BAA in scope. |
| `pci-dss-compliance` | "PCI DSS compliant / certified" — no cardholder data. |
| `gdpr-compliance` | "GDPR compliant / fully compliant" — operator + legal asserted, not platform attested. |
| `ccpa-compliance` | "CCPA compliant / fully compliant" — operator + legal asserted. |
| `continuous-compliance` | "continuous compliance", "real-time monitoring", "continuous control verification" — Phase 9O is cadence-based, not live. |
| `sso-live` | "real / live / production / enterprise SAML / OIDC / SSO" — adapter is a placeholder by default. |
| `scim-live` | "SCIM live / enabled / provisioning / supported / ready" — not live in any environment. |
| `twenty-four-seven-support` | "24/7 / 24x7 / around-the-clock support / monitoring / on-call" — no rotation. |
| `uptime-sla` | "99.9% uptime / four nines / five nines / zero downtime / guaranteed uptime" — no contractual SLA. |
| `automated-breach-notification` | "automated / real-time breach notification" — manual + legal reviewed. |
| `automated-dsr-fulfillment` | "automated DSR / right-to-be-forgotten / right-to-erasure / right-of-access" — operator + legal reviewed. |
| `autonomous-ai-sending` | "autonomous / fully automated / unattended AI outreach / sending" — `autonomous_sending_still_disabled` is permanent. |
| `guaranteed-data-residency` | "guaranteed / strict / enforced data residency" — depends on active Supabase project region. |
| `no-vendor-training` | "no / zero / never vendor / model / Anthropic training" — requires legal verification of active contract. |

Patterns are anchored on a noun + a strong verb / qualifier
to avoid flagging benign phrasing like "working towards SOC 2
readiness". Updating `OVERCLAIM_PATTERNS` is a deliberate
policy change — update this section in the same PR.

**Operators are NEVER blocked from recording any commitment.**
The warning exists so the gap is rectified with the buyer
before marking the commitment active.

---

## 5. Status lifecycle

```
draft  → active → fulfilled
              ↘ at_risk
              ↘ expired
              ↘ withdrawn
```

- **draft** — captured but not yet committed to. Use while
  contract is still under negotiation.
- **active** — committed to the buyer. The clock is on.
- **fulfilled** — operator has confirmed we are meeting it.
  Stamps `fulfilled_at` + `fulfilled_by`.
- **at_risk** — operator has flagged we are at risk of NOT
  meeting it. Triggers a soft warning in readiness.
- **expired** — commitment window has passed (operator
  records).
- **withdrawn** — superseded / cancelled / no longer relevant.
  Operator records the reason in notes.

---

## 6. How to record a commitment

1. Open `/dashboard/settings/billing` (admin or owner).
2. **CommitmentsRegisterCard** → **New commitment**.
3. Fill buyer company + email + source type (where the
   promise came from) + area + title + description (what was
   promised) + status (usually `draft`) + risk level + due /
   review dates.
4. Submit. The row appears in the table. If the area triggers
   an unsupported-risk warning, the CommitmentsReadinessCard
   surfaces the flag with the reason.
5. Walk the warning with the buyer if applicable. Update the
   description or move to `withdrawn` if the gap is real.
6. Move to `active` once committed to.

---

## 7. How to review / fulfil / waive

1. Click `Open` on the row.
2. Review the timeline + evidence URL.
3. Use the controls:
   - **Set status** — move along the lifecycle.
   - **Set risk** — adjust as platform posture changes.
   - **Mark reviewed** — stamp a `reviewed` timeline event
     for the audit trail. Use on cadence (e.g. quarterly per
     the Phase 9O calendar).
   - **Mark fulfilled** — stamp `fulfilled_at` and move to
     `fulfilled`.
   - **Save URL** — attach / update the evidence pointer.
   - **Append note** — add operator context to the timeline.

---

## 8. Readiness summary

The CommitmentsReadinessCard surfaces:

- Total commitments + counts by status.
- High + critical risk counts.
- Overdue review count.
- Due-within-30-days count.
- Unsupported-risk flag count + per-flag area + reason.
- Top 25 upcoming reviews ordered by review date.

Markdown + CSV exports are audited via
`commitments_readiness_exported`. Operators MUST review the
markdown before sharing externally — the export contains
buyer identity + operator notes + commitment descriptions.

---

## 9. Cross-references

The commitments register sits at the intersection of:

- **Phase 9N (Trust Center)** — when a `trust_grant` source
  type is used, the operator can cross-reference the grant id
  in `metadata.trust_grant_id` to link the commitment to a
  specific buyer packet.
- **Phase 9O (Compliance Operations Calendar)** — the
  quarterly RBAC matrix review + monthly trust-center copy
  review include "walk active commitments referencing those
  areas." Operators record completion in the compliance
  calendar with `evidence_url` pointing at the commitments
  readiness export.
- **Phase 9K (Vendor Risk)** — `subprocessor` area
  commitments cross-reference the vendor registry. When a
  vendor's `assuranceStatus` changes, walk active
  `subprocessor` commitments to confirm they still hold.
- **Phase 9M (Privacy + DSR)** — `privacy` and
  `data_retention` area commitments cross-reference the data
  inventory + retention policy. Buyer-specific retention
  windows should be recorded here, not in the static policy.

---

## 10. Buyer-facing language

When a buyer asks about commitment tracking:

- ✅ "Customer-specific commitments are tracked in an internal
  register with status, risk, owner, and review dates."
- ✅ "Soft warnings surface when a recorded commitment
  references a capability we do not fully support today."
- ✅ "Every commitment lifecycle change writes a typed audit
  row + timeline event."
- ❌ "We have automated contract compliance." (We don't.)
- ❌ "Our register parses your DPA." (It doesn't.)
- ❌ "We track legal review status." (Legal review remains
  an operator + counsel responsibility.)

---

## 11. What NOT to claim

- Do **NOT** claim the register is legal advice.
- Do **NOT** claim it proves contractual compliance.
- Do **NOT** claim it parses contracts.
- Do **NOT** claim it auto-creates commitments from uploaded
  documents.
- Do **NOT** claim commitments in `not_supported` /
  `partial` areas are fully supported just because they are
  recorded — surface the unsupported flag in any buyer
  conversation.

---

## 12. Known limitations

- Operator-recorded only. No autonomous contract parsing.
- Warnings are advisory; the platform does NOT block
  recording of an unsupported commitment.
- Support posture is hand-maintained in `policy.ts`; new
  partial / not-supported areas need explicit operator
  updates when capability changes.
- No DELETE — operators withdraw instead.
- No external alerting on overdue review / due-soon counts in
  this phase. Use the Phase 9O compliance calendar to track
  the review cadence.
- Like audit_events + abuse_events, contract_commitments is
  RLS-gated but not WORM at the DB level.

---

## 13. Honesty disclaimer (carried in every render)

> This register tracks operator-recorded commitments. It is
> not legal advice and does not prove contractual compliance.
> Commitments are operator-recorded and operator-reviewed; the
> platform does NOT autonomously parse contracts and does NOT
> auto-create commitments from uploaded documents.

Identical string across the readiness API, the markdown +
CSV exports, the static pack, the admin card footers, and the
evidence-map control descriptions so downstream consumers can
grep for it.
