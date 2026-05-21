# Trust Center

_Phase 9N — Enterprise Trust Center Foundation._

This document is the operator-facing companion to:

- `lib/enterprise/trust-center/types.ts`
- `lib/enterprise/trust-center/policy.ts`
- `lib/enterprise/trust-center/artifacts.ts`
- `lib/enterprise/trust-center/access.ts`
- `supabase/migrations/034_trust_center_foundation.sql`
- `app/(marketing)/trust/page.tsx` — public page
- `app/trust/access/[token]/page.tsx` — gated buyer page
- `app/api/admin/security/trust-center/*` — admin API
- `app/api/trust/access/[token]/artifact/route.ts` — gated download
- `components/dashboard/settings/TrustCenterCard.tsx`
- `components/dashboard/settings/TrustAccessGrantsCard.tsx`
- `scripts/build-trust-center-pack.mjs`
- `scripts/check-trust-center.mjs`

---

## 1. Purpose

Phases 9I–9M produced an internal evidence + privacy + vendor
+ incident discipline. Phase 9N turns that into a controlled
buyer-facing surface:

1. A **public** `/trust` page anyone can read.
2. **Gated bearer-token packets** for active procurement
   reviews (three scopes).
3. An **access event log** so the operator sees which
   prospects pulled which artifacts.

The Trust Center is **NOT** a SOC 2 certification. The public
page + every gated packet carries the same disclaimer.

---

## 2. Public vs gated materials

| Tier | Audience | Contents | Access |
|---|---|---|---|
| **Public** | Anyone | Curated security overview, public subprocessor names, known limitations, contact CTA. | `/trust` URL |
| **summary_only** grant | Initial procurement contact | Security overview + subprocessor disclosure (markdown/CSV) | Bearer URL |
| **standard_packet** grant | Post-NDA security review | Above + buyer security summary + security questionnaire response + privacy readiness + DR summary + incident response summary | Bearer URL |
| **full_packet** grant | Active enterprise security review | Above + evidence report + vendor risk report + SOC 2 evidence map | Bearer URL |

`custom` scope is reserved for operator curation — no auto-
built artifact list ships in 9N.

---

## 3. Bearer link security model

Grant URLs are bearer credentials. **Anyone with the URL can
access the packet until expiry or revocation.** The
TrustAccessGrantsCard warns the operator on every grant
creation.

Token primitives:

- **Generation:** 32 bytes of crypto-random entropy
  (`crypto.randomBytes`), base64-url encoded → ~256 bits.
- **Storage:** salted SHA-256 hash only. Plaintext is
  returned ONCE at creation and is NEVER logged.
- **Validation:** inbound token is hashed, looked up by
  `token_hash`, constant-time compared to the stored hash,
  status + expiry checked.
- **Rotation:** rotating `AUDIT_IP_HASH_SECRET` invalidates
  all bearer tokens + audit IP hashes atomically (intentional
  shared salt).

---

## 4. Grant lifecycle

```
created → active → (accessed N times) →
   ├─ expires_at passes → expired (auto-set on first failed validation)
   ├─ operator revokes → revoked
   └─ remains active until expiry
```

- **Default expiry:** 14 days.
- **Max expiry:** 90 days (`MAX_GRANT_EXPIRY_DAYS`).
- **Revocation:** operator clicks Revoke on the
  TrustAccessGrantsCard. Cannot be undone.

Every transition writes a `trust_access_events` row:

| Event type | When |
|---|---|
| `grant_created` | New grant via admin route |
| `grant_revoked` | Operator revoke |
| `grant_accessed` | Successful page load with valid token |
| `artifact_downloaded` | Successful artifact fetch with valid token |
| `grant_expired` | (reserved — auto-recorded on first denied access after expiry) |
| `access_denied` | Token invalid / expired / revoked |

---

## 5. Artifact visibility rules

`lib/enterprise/trust-center/policy.ts → ARTIFACT_VISIBILITY`
sets each artifact's visibility default:

| Artifact | Visibility |
|---|---|
| `security_overview` | public |
| `subprocessor_disclosure` | public |
| `privacy_readiness` | gated |
| `questionnaire_response` | gated |
| `buyer_security_summary` | gated |
| `evidence_report` | gated |
| `vendor_risk_report` | gated |
| `incident_response_summary` | gated |
| `disaster_recovery_summary` | gated |
| `soc2_evidence_map` | gated |
| `custom` | internal_only |

**`internal_only` artifacts NEVER emit**, even when `full_packet`
scope is requested. The artifact builder enforces this
independently of the route layer.

---

## 6. What is safe to publish

Public-safe content lives in `PUBLIC_TRUST_SECTIONS` (curated
copy reviewed before each commit) plus the vendor registry
rows whose `disclosureStatus === 'public'`.

The public page:

- Loads the curated copy + the buyer-disclosable subprocessor
  list.
- Includes the standard disclaimer + explicit known
  limitations (no 24/7 monitoring, not SOC 2 certified, etc.).
- Sets `robots: noindex` on the gated path (`/trust/access/*`).
- Sets `X-Robots-Tag: noindex, nofollow` on every gated
  artifact response.

---

## 7. What must stay internal

`policy.ts → NEVER_PUBLISH_PUBLICLY` enumerates what the
public page + every artifact renderer must avoid:

- Internal-only vendor rows (stripe-cli, optional alert
  vendors before promotion).
- Environment variable NAMES from any vendor evidence
  reference.
- NPM package names from any vendor evidence reference.
- Raw `audit_events` rows (the public route emits aggregate
  metadata only).
- Raw incident records or post-incident review markdown.
- Raw DSR records, subject identities, or legal review notes.
- Customer message content, lead PII, operator personal data.
- Webhook URLs, routing keys, or any vendor secret.
- Stripe customer / subscription identifiers.
- Service-role tokens, signing keys, any value from
  `process.env`.
- Vendor evidence PDFs (DPA / SOC 2 reports) unless
  explicitly approved by legal and uploaded outside this
  repository.

---

## 8. How to create / revoke a buyer grant

1. Open `/dashboard/settings/billing` (admin or owner).
2. **Trust access grants** card → **New grant**.
3. Fill buyer name / email / company / scope / expiry days.
4. Click **Create grant**. The URL is shown ONCE — copy it
   now and send via your existing buyer communication channel.
5. After sending, monitor the TrustAccessGrantsCard for
   access counts + last-accessed timestamps.
6. Revoke when no longer needed — click **Revoke** on the
   row. Status flips to `revoked`; subsequent access attempts
   return access_denied.

---

## 9. How to review before sharing

Before clicking **Create grant** with `full_packet` scope:

1. Run the **Preview manifest** button on the
   TrustCenterCard — confirm the included artifacts list
   matches expectations.
2. Click **Download Markdown** on the packet — review the
   full manifest + disclaimer.
3. For `full_packet`, also regenerate
   `npm run build:trust-center-pack` and review the
   `full-trust-packet.md` output offline.
4. Legal review is recommended for `full_packet` grants to
   buyers in active contract negotiation.
5. Hit **Create grant** + send.

---

## 10. Trust Center disclaimers

> Trust materials are provided for security review purposes
> and do not represent a third-party certification, legal
> advice, or contractual commitment unless separately agreed
> in writing.

Identical string across the public page, every gated artifact
response, the static pack, the admin card footers, and the
evidence-map control descriptions so downstream consumers can
grep for it.

---

## 11. Known limitations

- Trust Center is NOT a SOC 2 certification.
- Gated links are bearer tokens — share carefully.
- No PDF renderer; markdown / CSV / JSON only.
- Public page exposes only public-safe summaries (curated
  copy + buyer-disclosable vendors).
- Legal / security review is still required before sending
  any grant URL.
- No private vendor evidence PDFs (DPA / SOC 2 reports) are
  stored or served by the platform.
- No NDA-acceptance gate beyond the token itself.
- Public page cache revalidates every 5 minutes; very recent
  curated-copy changes propagate after the cache window.
- `custom` scope has no operator curation flow in 9N — it
  returns an empty manifest.
- Token rotation is by operator revoke; there is no
  automated rotation cron.

---

## 12. Future public subprocessor page

The current public `/trust` page renders the public
subprocessor NAMES only. A future phase can add a separate
`/security/subprocessors` route that pulls
`buildSubprocessorDisclosure()` (Phase 9K) directly, exposing
the full buyer-safe disclosure (categories, descriptions,
risk tier). The helper is already disclosure-safe — adding the
route is a one-file change once legal approves the wording.

---

## 13. Honesty disclaimer (carried in every render)

The disclaimer in §10 is the single source of truth. When
adding a new render path, copy the constant from
`lib/enterprise/trust-center/policy.ts → TRUST_CENTER_DISCLAIMER`
verbatim. The `check:trust-center` scanner asserts the
documentation cross-references exist; it does not validate the
disclaimer text — that is a code-review discipline.

---

## 14. Phase 9O addendum — Trust Center review cadence

The Phase 9O compliance operations calendar ships two
Trust-Center-adjacent policy items:

- **`trust-center-public-copy-review`** — monthly. Open
  `/trust` as an unauthenticated user. Confirm curated copy
  is current, public subprocessor list matches the registry,
  known limitations are accurate. Stale after 45 days.
- **`trust-center-gated-artifact-review`** — monthly. Run
  `npm run build:trust-center-pack` and review standard +
  full packet markdown end-to-end. Verify gated artifacts
  still render the buyer-safe content from 9I–9M sources.
  Stale after 45 days.

When the calendar flags either as overdue or stale, the
operator:

1. Loads `/trust` (incognito) and inspects the rendered
   page against the curated copy in
   `lib/enterprise/trust-center/policy.ts`.
2. Runs `npm run build:trust-center-pack` and reviews the
   generated markdown.
3. Edits `PUBLIC_TRUST_SECTIONS` / `PUBLIC_KNOWN_LIMITATIONS`
   in `policy.ts` if anything has drifted.
4. Records completion in ComplianceCalendarCard with notes
   + evidence URL (e.g. PR link, shared doc).

This closes the loop between Phase 9N (Trust Center) and
Phase 9O (review discipline). Operators should NOT promote
new vendor rows from `admin_only` to `public` without an
accompanying entry in the compliance calendar tracking that
decision.

---

## 15. Phase 9P addendum — Trust grants cross-reference commitments

The Phase 9P commitments register includes `trust_grant` as a
source type. When an operator issues a buyer-facing Trust
Center grant (Phase 9N), they can also record any commitments
made in the procurement / NDA process by:

1. Open `/dashboard/settings/billing` →
   CommitmentsRegisterCard → `+ New commitment`.
2. Set `source_type = 'trust_grant'`.
3. Reference the grant id in `metadata.trust_grant_id` (free-
   form metadata field).
4. Record the commitment area + description.

This cross-link lets the operator answer "what did we commit
to buyers who have an active Trust Center grant?" by filtering
the register on `source_type = trust_grant` + active status.

When promoting an admin-only vendor row to public disclosure
(Phase 9K), check the commitments register for any `subprocessor`
commitments that reference the vendor — promotion may
require buyer notification per a recorded commitment.
