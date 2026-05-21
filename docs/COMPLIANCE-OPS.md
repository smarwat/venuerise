# Compliance operations

_Phase 9O — Compliance Operations Calendar + Evidence Freshness Automation._

This document is the operator-facing companion to:

- `lib/enterprise/compliance-ops/types.ts`
- `lib/enterprise/compliance-ops/policy.ts`
- `lib/enterprise/compliance-ops/calendar.ts`
- `lib/enterprise/compliance-ops/freshness.ts`
- `supabase/migrations/035_compliance_ops_calendar.sql`
- `app/api/admin/security/compliance/*`
- `components/dashboard/settings/ComplianceCalendarCard.tsx`
- `scripts/build-compliance-ops-pack.mjs`
- `scripts/check-compliance-ops.mjs`

---

## 1. Purpose

Phases 9I–9N produced a deep enterprise readiness surface
(evidence map, sales packets, vendor risk, incident response,
privacy + DSR, trust center). All of that material decays:

- Vendor SOC 2 reports expire.
- DR runbooks drift when the platform changes.
- Trust Center copy goes stale.
- Privacy data inventory misses a new schema column.
- Coverage scanners surface new gaps after every feature ship.

Phase 9O is the calendar that prevents this. Operators record
the reviews they actually run; the platform persists the trail.

> **What it does not prove.** This calendar does NOT prove
> continuous compliance. Completion is operator-marked. Stale-
> flagging is a soft signal, not a control failure. No
> autonomous rotation, no autonomous artifact refresh, no
> external alerting in this phase.

---

## 2. What the calendar tracks

`lib/enterprise/compliance-ops/policy.ts` ships a 17-row
static policy spanning every readiness area. The table below
is the cadence matrix — the build pack regenerates the same
table at `artifacts/evidence/compliance-ops/`.

| Policy id | Area | Cadence | Stale after |
|---|---|---|---:|
| `vendor-risk-review` | vendor_risk | quarterly | 120 d |
| `subprocessor-disclosure-review` | subprocessors | quarterly | 100 d |
| `privacy-data-inventory-review` | privacy_dsr | quarterly | 120 d |
| `retention-policy-review` | retention_policy | semiannual | 210 d |
| `data-lifecycle-review` | data_lifecycle | semiannual | 210 d |
| `dr-dry-run` | disaster_recovery | quarterly | 100 d |
| `backup-posture-review` | backup_posture | monthly | 45 d |
| `incident-tabletop` | incident_response | quarterly | 100 d |
| `trust-center-public-copy-review` | trust_center | monthly | 45 d |
| `trust-center-gated-artifact-review` | trust_center | monthly | 45 d |
| `security-questionnaire-review` | security_questionnaire | monthly | 45 d |
| `evidence-pack-regeneration` | evidence_pack | monthly | 45 d |
| `sso-readiness-review` | sso_readiness | quarterly | 100 d |
| `audit-coverage-review` | audit_coverage | monthly | 45 d |
| `rate-limit-coverage-review` | rate_limit_coverage | monthly | 45 d |
| `rbac-matrix-review` | access_control | quarterly | 100 d |
| `security-headers-review` | security_headers | quarterly | 100 d |

Each policy item carries:

- A plain-language description.
- An owner role (`platform` / `owner` / `legal`).
- Evidence reference list (runbook + module + script paths).
- A recommended action paragraph.
- `staleAfterDays` — the soft-stale threshold for freshness.
- A `buyerImpactIfStale` line — what a buyer sees if the area
  drifts.

---

## 3. What it does NOT prove

- **Not a continuous compliance attestation.** Completion is
  operator-marked.
- **Not real-time control verification.** The platform does
  not introspect vendor certificates, DPA expiry dates, or
  underlying control state — it tracks the operator review.
- **No autonomous rotation.** The calendar will not refresh
  trust artifacts, regenerate packs, or rotate secrets on its
  own.
- **No external alerting in this phase.** Future phases could
  add a digest reminder or Slack escalation; 9O is operator-
  pull only.
- **No SOC 2 certification.** This is operational discipline;
  it is one input to a formal audit, not a replacement.

---

## 4. How to seed events

1. Open `/dashboard/settings/billing` (admin or owner).
2. **ComplianceCalendarCard** → **Seed missing**.
3. The seed helper iterates every policy item and INSERTS a
   fresh `upcoming` event ONLY when the venue has no active
   (upcoming/due/overdue) event for that policy id.
4. Re-seeding is idempotent — clicking twice produces
   `inserted: 0` the second time.
5. Operators can edit `lib/enterprise/compliance-ops/policy.ts`
   to add / remove policy items. Re-deploy + re-seed picks up
   new rows.

---

## 5. How to complete reviews

1. Run the actual review per the policy item's
   `recommendedAction` (e.g. walk the vendor registry, run
   the DR dry-run, regenerate the evidence pack).
2. Open the row in the ComplianceCalendarCard → **Open**.
3. Paste **review notes** (what you checked, what you found).
4. Optionally paste an **evidence URL** pointing at the
   out-of-band artifact (shared drive doc, ticket id,
   diff URL).
5. Click **Mark completed**. The row stamps `completed_at` +
   `completed_by`. An audit row lands (`compliance_review_completed`).

The seed helper does NOT auto-reschedule the next event on
completion — it only inserts during explicit seed actions. Run
the seed flow again to schedule the next interval.

---

## 6. How to waive reviews

For reviews that genuinely don't apply (e.g. SSO readiness
when a real adapter is being wired in a new phase that
supersedes the policy item):

1. Open the row → **Waive (with reason)** textarea.
2. Type the explicit reason (4000-char cap).
3. Click **Waive**. Status flips to `waived`; `waived_at` +
   `waived_by` + `waiver_reason` are stamped. Audit row is
   `compliance_review_waived`.

Waivers are intentionally heavy — every waiver carries a
visible reason in the trail.

---

## 7. Evidence freshness model

`lib/enterprise/compliance-ops/freshness.ts` cross-references:

- The static `COMPLIANCE_REVIEW_POLICY`.
- All `compliance_review_events` rows for the venue.

For each policy row it produces:

- `lastCompletedAt` — most-recent completed event timestamp.
- `nextDueAt` — next open event due date.
- `status` — aggregate `upcoming` / `due` / `overdue` /
  `completed` / `waived`.
- `stale` — true when `(now - lastCompletedAt) >= staleAfterDays`.

**Stale is a soft signal.** A control that the operator
reviewed yesterday but whose underlying state has drifted in
reality will appear fresh; freshness reflects review records,
not the live control. Use it as a "when did we last actually
look?" indicator.

---

## 8. Buyer-facing language

When a buyer asks about review cadence, use language that
matches what the calendar actually proves:

- ✅ "We maintain a documented review cadence for every
  readiness area we publish. Reviews are operator-recorded
  against a 17-row policy spanning vendor risk, privacy, DR,
  backup, incident, trust center, and coverage scanners."
- ✅ "Quarterly DR dry-runs + tabletop exercises are tracked
  in our compliance operations calendar."
- ✅ "Stale areas surface in our admin dashboard with the
  operator's review history."
- ❌ "We have continuous compliance monitoring." (We don't.)
- ❌ "We're SOC 2 compliant." (Not certified — see
  `docs/SOC2-EVIDENCE-MAP.md`.)
- ❌ "Our calendar guarantees no vendor SOC 2 certificate
  ever expires undetected." (Operator-pull, not automated.)

---

## 9. What NOT to claim

- Do **NOT** claim continuous compliance monitoring.
- Do **NOT** claim automated control verification.
- Do **NOT** claim the calendar guarantees on-time review of
  every area — operators can miss a window, and waivers are
  explicit.
- Do **NOT** publish per-venue completion timestamps in
  public-facing material without explicit operator review.

---

## 10. Known limitations

- **Calendar does not prove continuous compliance.** Reviews
  are operator-marked.
- **No automatic vendor / security document refresh.** Vendor
  evidence still lives outside the repo.
- **No external alerting in 9O.** No Slack / email reminders.
- **Freshness is based on completed review records**, not
  real-time attestation.
- **Operator-asserted completion only.** A completed review
  attests that the operator ran the review process, not that
  every underlying control is in its expected state.
- **No DELETE on compliance_review_events.** Operators waive
  instead of delete, so the trail stays intact.
- **The 17-row policy is hand-maintained.** Adding a new
  readiness area requires editing `policy.ts` + re-deploying.

---

## 11. Honesty disclaimer (carried in every render)

> The compliance operations calendar tracks operator-initiated
> reviews of internal controls. It does NOT prove continuous
> compliance. It does NOT auto-rotate secrets, auto-refresh
> trust artifacts, or send external alerts. Completion is
> operator-marked; waivers carry an explicit reason. Stale-
> flagging is a soft signal, not a control failure.

Identical string across the calendar API, the freshness
summary, the static pack, the admin card footer, and the
evidence-map control descriptions so downstream consumers can
grep for it.

---

## 12. Phase 9P addendum — Commitments review cadence

Phase 9P adds a customer-specific commitments register
(`docs/CONTRACT-COMMITMENTS.md`). Each commitment carries its
own `review_at` date, distinct from the platform-wide policy
items tracked here.

Operator workflow when a commitment review date approaches:

1. Open the CommitmentsRegisterCard. Filter by buyer or open
   the row from the readiness "Upcoming reviews" list.
2. Confirm we still meet the commitment + update evidence URL.
3. Click `Mark reviewed` to stamp the timeline.
4. Optionally record a custom compliance calendar event with
   `area = security` (or matching area) and
   `evidence_url` pointing at the commitment id. Use cadence
   `ad_hoc` for one-off reviews tied to a specific buyer.

This keeps the **per-platform** review cadence (Phase 9O) and
the **per-buyer** commitment cadence (Phase 9P) tracked in
parallel without conflating them.

When the compliance calendar's `vendor-risk-review` or
`subprocessor-disclosure-review` runs, the operator should
also walk active `subprocessor` commitments — a vendor posture
change may trigger a per-buyer notification commitment.
