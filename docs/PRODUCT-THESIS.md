# VenueRise Product Thesis — AI Revenue OS for Wedding Venues

> **One-line:** VenueRise is the AI Revenue Operating System that watches every
> wedding-venue lead, follows up relentlessly, books more tours, and shows the
> owner exactly where revenue is leaking.

This document is the **product north star**. Every future phase should be
evaluated against it: "Does this change increase booked tours, recover lost
leads, or expose revenue leakage? Or are we drifting toward a generic CRM?"

---

## 1. Why VenueRise is not a CRM

Wedding venues already have:

- A booking calendar (Honeybook, Aisle Planner, Perfect Venue, paper).
- A contact form (their website, WeddingWire, The Knot).
- An inbox (Gmail, Outlook, sometimes a shared one).
- A spreadsheet of leads.
- A receptionist or a single salesperson juggling all of the above.

None of those tools **earn the venue another booked wedding**. They store
the lead. They don't fight for it.

VenueRise is not the place leads are *stored*. It is the layer that **acts on
the leads other tools forgot about**:

| Existing tool   | What it does               | What it does NOT do                         |
|-----------------|----------------------------|---------------------------------------------|
| CRM / Honeybook | Stores contacts            | Replies to a new inquiry at 9pm on a Sunday |
| Calendar        | Holds the tour slot        | Notices the tour was never confirmed        |
| Inbox           | Receives the lead's email  | Drafts a venue-voice follow-up at 48 hours  |
| Spreadsheet     | Tracks pipeline status     | Flags the high-fit lead that's been ignored |
| Salesperson     | Replies when they can      | Catches every lead within minutes           |

VenueRise positions **above or beside** these tools and does the
revenue-critical work they fail at. We don't replace the venue's CRM — we
make every other tool more valuable by stopping leakage at the source.

---

## 2. Who pays for this and why they can pay high-ticket

### The buyer

The buyer is the **venue owner**, not a marketing manager or a venue
coordinator. The owner:

- Bears the revenue risk.
- Pays for the tools out of their own P&L.
- Loses money every time a lead falls through.
- Cannot afford to micromanage 30 inquiries a week.

A typical mid-market wedding venue books **30–80 weddings per year** at an
average booking value of **$8,000–$25,000**. A single recovered booking
covers the SaaS bill for 12+ months. Two recovered bookings make the
product an obvious yes.

### Why the price tag holds up

We are not selling "AI chat" or "lead management." We are selling
**recovered revenue + sales operations automation**:

- **Speed-to-lead matters more than features.** Industry data shows the
  fastest-responding venues win disproportionate share of inquiries. A
  90-second AI first reply is worth more than ten dashboard widgets.
- **Follow-up consistency matters more than templates.** Most venues lose
  ~60% of inquiries to "no one replied after the first email." A relentless
  follow-up agent recaptures those.
- **Tour conversion matters more than pipeline aesthetics.** Getting an
  inquiry to a booked tour is the single biggest lever; everything before
  and after is in service of that one transition.
- **Accountability matters more than dashboards.** The owner needs to know
  who replied, who ignored a hot lead, who cancelled a tour without a
  reason — and they need it without playing detective.

These are revenue problems, not productivity problems. That's why this
product can hold a high-ticket price.

---

## 3. Core pain points (in operator language)

1. **"Leads ghost us because we don't reply fast enough."**
   First-touch latency kills more deals than tour quality does.
2. **"We forget to follow up after the first email."**
   The 48-hour, 7-day, and 14-day touches almost never happen consistently.
3. **"We don't know which leads are worth chasing."**
   No fit score, no urgency signal — every lead looks the same in the inbox.
4. **"We book fewer tours than we should."**
   Qualified leads stall before they ever step on the property.
5. **"Tours get cancelled and we don't catch the recovery window."**
   Cancellations almost never get a personalized re-engagement attempt.
6. **"My staff is doing this differently every time."**
   Voice drift, missed follow-ups, inconsistent qualification.
7. **"I can't see where revenue is leaking."**
   The owner has no single surface showing which leads are dying and why.

VenueRise has to address each of these directly. Anything that doesn't
trace back to one of them is a candidate for cutting.

---

## 4. The core promise

VenueRise commits to the venue owner on five outcomes:

1. **More booked tours from the same inquiry volume.**
2. **Faster lead response — sub-minute for new inquiries.**
3. **Fewer leads slipping away** between first touch and booking.
4. **Clearer operator accountability** without micromanagement.
5. **AI-assisted follow-up that sounds like the venue, not a chatbot.**

If a phase ships and doesn't move at least one of those five outcomes, we
should question whether it should have shipped.

---

## 5. High-ticket justification (the sales narrative)

The product is **not sold as a dashboard**. It is sold as:

> *"Your AI revenue manager. It watches every inquiry, follows up
> relentlessly, books more tours, flags leakage risk in real time, and
> tells you exactly where revenue is being won or lost — without you
> having to babysit your inbox or your staff."*

Pricing follows that narrative. A venue earning $8k–$25k per booking
shouldn't be evaluating us on a feature checklist. They should be asking:

- *"Will this give me at least one extra booked wedding per year?"*
  (Answer: yes, even at low estimates of speed-to-lead lift.)
- *"Will this stop me losing the leads I'm already paying to acquire?"*
  (Answer: yes, via follow-up recovery + cold-lead reactivation.)
- *"Will this give me visibility into what my team is actually doing?"*
  (Answer: yes, via the audit + accountability surfaces we've built and
  will continue building.)

Every yes is worth a multiple of the monthly fee. That's the price
defense.

---

## 6. Anti-goals (what we should never become)

To stay sharp on the thesis, here's what we explicitly **avoid**:

- **A generic CRM.** No "contact records and notes" feature parity race.
- **A scheduling tool.** Calendars exist; we integrate, we don't compete.
- **An invoicing tool.** Money-collection software exists; we don't.
- **A bare AI chatbot.** Chat without revenue accountability is a toy.
- **A "marketing automation" platform.** We do not blast email
  campaigns. We respond, follow up, and recover — per-lead, not per-list.
- **A managed services agency.** We sell software, not human SDR labor.

If a feature request smells like one of the above, push back.

---

## 7. How this thesis steers future phases

When the next phase is being scoped, the prompt should be testable
against the matrix below.

| Phase change            | Question                                                              |
|-------------------------|-----------------------------------------------------------------------|
| New surface             | Which of the 5 core promises does it move?                            |
| New agent / workflow    | Which of the 7 workflows (see AGENTIC-WORKFLOW-MAP.md) does it serve? |
| New dashboard widget    | Does it show revenue leakage or just status?                          |
| New audit surface       | Does it support operator accountability without becoming punitive?    |
| New AI behavior         | Does it preserve venue brand voice?                                   |
| New integration         | Does it stop revenue leaking out of a system we don't own?            |
| New admin tool          | Does it reduce owner micromanagement?                                 |

If a proposed change can't answer at least one of those, it's a CRM
feature, and CRM features are not what we sell.

---

## 7o. Reactivation outreach cadence + won/lost reason library (Phase 8BD)

Phase 8BD turns "lost" leads from a dead column into a real
Revenue OS surface. The lift comes in three layers:

1. **Operator-supplied lost reason taxonomy.** Migration 026
   adds `leads.metadata` (jsonb + GIN index). When an operator
   moves a lead to `lost`, the LeadDetailDrawer surfaces an
   inline, **skippable** prompt with six reasons —
   `priced_out`, `date_unavailable`, `picked_competitor`,
   `ghosted`, `not_a_fit`, `other` — plus an optional free-text
   note. Saved values land at `metadata.lost_reason = {reason,
   note, recorded_at, recorded_by}` via the existing
   `/api/leads/[id]` PATCH route, which now accepts an
   allowlisted `lost_reason` field and merges into the existing
   metadata jsonb rather than overwriting it.
2. **Reactivation candidacy helper.** A pure
   `lib/revenue-os/reactivation.ts` module takes the lost
   leads + per-lead last lead-role message + each lead's
   recorded reason and produces a `ReactivationSignal` per
   candidate: `strong_candidate` for actionable reasons
   (`priced_out`, `date_unavailable`, `ghosted`) cooled ≥ 30
   days; `possible_candidate` for `other` / missing reason
   cooled ≥ 60 days; everything else dropped.
   `picked_competitor` and `not_a_fit` are never surfaced — the
   operator already said no. Leads inside the 60-day pre-event
   no-touch window are also excluded.
3. **Operator-visible surfaces.** A new
   `ReactivationQueueCard` on `/dashboard` Overview ranks the
   top 10 candidates with rationale + lead score + deep-link
   to the drawer; a new `ReactivationPanel` inside the
   LeadDetailDrawer (lost-stage only) shows the suggested
   instruction and reuses the existing `pendingRecoveryInstruction`
   plumbing for the "Use reactivation suggestion in draft" CTA;
   the leads board accepts `?leakage=reactivation` (with DnD
   suppressed during the filter); a new admin endpoint
   `GET /api/admin/leads/reactivation-queue` exposes the same
   roll-up for future cron / digest consumers; the operator
   digest now ships a "Reactivation candidates this week"
   section with top 3 names + reasons + a queue link.

Critical safety posture:

- **No autonomous outreach.** The operator clicks the
  reactivation suggestion → opens the Conversation tab →
  clicks Regenerate → reviews the draft → clicks Approve &
  send. Every reactivation reply still flows through the
  Phase 8AV–8BA brand voice + autopilot safety stack.
- **Lost reasons are operator-supplied only.** The system
  never synthesizes a reason; missing reasons surface as
  "possible" after a longer cooling window, not "strong".
- **Skippable.** The lost-reason prompt does NOT block the
  stage change. Operators who skip end up with a row that
  still becomes a reactivation candidate eventually (under the
  60-day cooling window) without forcing a structured answer.
- **`autonomous_sending_still_disabled`** health flag stays
  `mounted`.

This is the last major Phase 8 wedge focused on operator
workflow. The natural next step is Phase 9: enterprise
hardening (tenancy / RBAC / audit / observability /
compliance) before any further surface area expands.

## 7n. Venue availability intelligence (Phase 8BC)

Phase 8BC turns the Phase 8BB slot suggestions into something a
real wedding venue could actually use. The chips now respect:

- **Default tour duration** — a new per-venue
  `tourDurationMinutes` setting on `RevenueOsSettings`
  (15–240 min, default 60). The slot helper uses it instead of
  the hard-coded 60.
- **Buffer time between tours** — a new per-venue
  `tourBufferMinutes` setting (0–120 min, default 0). Applied
  AFTER every existing tour's end during the conflict check so
  a venue with a 30-min cleanup window doesn't get a 9am tour
  suggested 5 minutes after a 7:30am tour ends.
- **Blackout dates** — a new `public.tour_blackouts` table
  (migration 025) + operator-managed UI inside Settings →
  Availability. Each row is `(venue_id, blackout_date,
  reason?)`. Candidates whose local calendar date matches a
  blackout row are dropped before being surfaced.
- **Venue timezone** — `venue.timezone` is now threaded into
  `suggestTourSlots`; the chip labels render in venue-local
  time via `Intl.DateTimeFormat({ timeZone })`, and the
  blackout-date filter compares against the candidate's local
  date so a PT venue's `2026-05-26` blackout correctly blocks
  PT-local candidates whose UTC ISO might roll into the next
  day.

UX changes:

- The TourReadinessPanel's suggestion caption now reads
  *"Suggested from your availability, duration, buffer, and
  blackout dates."*
- The empty-state when every candidate is filtered reads
  *"No open windows found after availability, conflicts, and
  blackout dates."*
- Per-chip tooltips append "Avoids existing tours, buffer
  time, and blackout dates." (only when those signals are
  actually in play — quiet on a venue with neither buffer nor
  blackouts).
- Settings → Availability has a new **Blackout dates**
  section under the weekly windows card: add a date + optional
  reason, list existing rows, delete per row. ADMIN_ROLES
  only (write); sales-role members can read.
- RevenueOsSettingsCard adds two fields: **Default tour
  duration** + **Buffer time between tours** with their copy.

Safety posture unchanged: blackouts only AFFECT
SUGGESTIONS. They do not cancel existing tours, do not block
the operator from manually scheduling a tour on a blackout
date from the drawer's date picker, and do not touch the
send path. Operator approval inside ScheduleTourDrawer still
required for every tour. The `autonomous_sending_still_disabled`
health flag (8AX→8BC) remains `mounted`.

## 7m. Tour slot suggestions from availability (Phase 8BB)

Phase 8BB makes the Settings → Availability data actually
useful inside the operator workflow. When a lead has been
qualified but hasn't been put on a tour yet, the Tour
Readiness panel on the lead detail drawer now renders up to
**two clickable suggested tour windows** derived from the
venue's saved `tour_availability` windows plus the venue-wide
tour calendar.

The pipeline is end-to-end pure + operator-controlled:

- A new pure helper `lib/revenue-os/tour-slot-suggestions.ts`
  (`suggestTourSlots`) consumes `{availability, existingTours,
  leadEventDate, timezone, now, maxSuggestions}` and returns
  up to N candidate `{startsAt, endsAt, label, rationale,
  source: 'venue_availability'}` slots.
- Rules: active-only windows; 60-minute default duration;
  windows narrower than the duration are skipped; no past
  times; no times after the lead's event_date; conflict-free
  against existing non-cancelled tours; sorted by earliest
  start; de-duplicated by calendar date so a venue with three
  Saturday windows doesn't burn both suggestion slots on the
  same day.
- The LeadDetailDrawer fetches the venue's active availability
  + the venue's next 60 days of tours in the SAME effect that
  already loads recovery + tour-booking signals — no extra
  round-trip in the common case.
- Suggestions render as small navy-outlined chips inside the
  existing TourReadinessPanel, only on the
  `qualified_no_tour` signal (the only branch that already has
  a Schedule CTA, so the chips appear right where the
  operator is already deciding when to schedule).
- Clicking a chip opens the existing `ScheduleTourDrawer`
  pre-filled with that timestamp (via the Phase 8I
  `defaultScheduledAt` prop, which the drawer already
  supported for re-schedule flows). The operator still
  confirms inside the drawer — no autonomous scheduling.

Fallback states are explicit and non-blocking:

- No availability rows → "Add availability in Settings to
  unlock slot suggestions."
- Availability exists but every candidate conflicts → "No
  open windows found in the next few weeks."
- Fetch error → the suggestion section hides silently; the
  rest of the panel keeps working.

This is the first phase where the read side of the safety
stack (Phases 8AV–8BA) and the write side of operator
productivity start sharing a venue-level data source. The
Tour Booking Agent's surfaces now consume saved availability
the same way the future autopilot phases will consume the
8BA readiness gate.

## 7l. Autopilot safety scorecard + readiness gate (Phase 8BA)

Phase 8BA closes the read-only safety stack. Phases 8AV
through 8AZ each measured a slice of the autopilot question;
8BA collapses all of them into a single verdict per venue:

> *"Would this venue even be ELIGIBLE to opt in to autopilot
>  if we offered the toggle today?"*

The verdict is `not_eligible`, `watch`, or `eligible`. Even
`eligible` is **not** an autonomy toggle. It is the
PRECONDITION a future opt-in phase will require before any
operator can flip the switch — and even then, the future
phase has to ship rollback, kill switch, monitoring, and
customer-visible settings of its own. The
`autonomous_sending_still_disabled` health flag from 8AX
stays `mounted` after 8BA; nothing in this phase touches a
send path.

Six readiness gates, evaluated independently and then
collapsed to a verdict:

1. **Simulation readiness is promising** (blocking) — the 8AY
   `summary.readiness` must equal `promising`.
2. **Enough scored drafts** (blocking) — ≥ 50 scored rows
   over the 30-day window (the 8AY panel's own threshold is
   ≥ 20; we want 2.5x that before considering eligibility).
3. **Disagreement coverage** (blocking) — ≥ 80% of
   disagreements have been labeled in the review queue.
4. **No rule is over-firing** (warning) — no risk rule has
   a false-positive rate above 25% among labeled
   disagreements.
5. **Every dangerous mismatch is labeled** (blocking) — zero
   `operator_less_conservative` rows with `needs_review`
   state. The dangerous-direction disagreements MUST be
   reviewed.
6. **Sample spans enough days** (warning) — ≥ 14 distinct
   UTC dates with scored rows. Prevents a 3-day burst from
   passing.

Verdict rule:
- `eligible` — every gate passes.
- `watch` — every blocking gate passes; at most one warning
  gate fails. Lets a venue with one soft miss see a "you're
  almost there" signal without flipping all the way to
  "not eligible."
- `not_eligible` — anything else.

The dedicated `GET /api/admin/ai/autopilot-readiness`
endpoint reuses the 8AY simulation projection + the 8AZ
review join (no new database surface), returns the verdict,
the gate list with current values and thresholds, and a
`generated_at` timestamp. No draft body, no variants, no
lead emails, no message content are exposed.

The **AutopilotReadinessScorecard** sits ABOVE the
AutopilotSimulationPanel on `/dashboard/settings/billing` so
the operator sees the single-glance verdict before scrolling
into the underlying ratios. The card renders the verdict
banner, the reason list, the gate checklist (with current
value + threshold + next-step copy), and — on every state,
including `eligible` — the persistent disclaimer that
autonomous sending is still disabled.

There is no "Enable autopilot" button anywhere in the
codebase, and adding one is explicitly out of scope. The
next phase (8BB or later) is where the conversation about
opt-in autonomy begins, and even then it must add: explicit
per-venue toggle, rollback, kill switch, monitoring, and
customer-visible settings before any message is sent
without operator approval.

## 7k. Autopilot shadow evaluation + review queue (Phase 8AZ)

Phase 8AZ is the fourth layer of the safety stack and the
direct prerequisite for any future autonomy phase. Each prior
layer answered a smaller question:

- 8AV — *gate*: was this draft above the confidence floor?
- 8AW — *telemetry*: how well-calibrated is our confidence?
- 8AX — *guardrails*: would autopilot have classified this
  draft eligible / review / blocked?
- 8AY — *simulation*: across 30 days, how often did the
  operator agree?
- **8AZ — *shadow evaluation*: when the operator and autopilot
  DISAGREED, who was right?**

Critically: this phase introduces ZERO autonomous sending.
Operator approval remains mandatory. The
`autonomous_sending_still_disabled` health flag from Phase 8AX
stays `mounted` so a monitor can assert the safety posture
hasn't regressed.

What 8AZ adds:

- A dedicated table `public.ai_action_reviews` (migration 024)
  storing one row per labeled disagreement, keyed unique on
  `ai_action_id`. The unique constraint means relabeling
  UPDATES the row instead of piling up duplicates. RLS allows
  venue admins/owners to read; writes go through the
  service-role POST route after explicit `requireAdmin` +
  `requireVenueRole` checks.
- A pure helper
  (`lib/revenue-os/autopilot-review.ts`) defining the five
  review states (`needs_review`, `confirmed_guardrail_too_strict`,
  `confirmed_guardrail_correct`, `confirmed_operator_error`,
  `deferred`), the rule-signal math, and the
  `reviewed_disagreements_pct` calculation any future
  autonomy gate will read.
- Two admin endpoints:
  - `GET /api/admin/ai/autopilot-reviews` — the queue feed
    + summary + rule_signals. Filters by state and by
    operator-alignment direction. Metadata-only; never
    returns draft body text.
  - `POST /api/admin/ai/autopilot-reviews/[aiActionId]` —
    upserts the operator's verdict. Rejects `needs_review`
    as a write target (writes are explicit decisions, not
    implicit defaults).
- A review-aware extension to the existing simulation
  endpoint: `summary` now carries
  `reviewed_disagreements_pct`, per-state counts
  (`needs_review_count`, `confirmed_*`, `deferred`), and a
  `rule_signals` array (one entry per risk rule with reviewed
  counts + false-positive rate). Every existing 8AY field is
  preserved.
- An **AutopilotReviewQueue** panel mounted between
  `AutopilotSimulationPanel` and `AIDraftAuditCard` on
  `/dashboard/settings/billing`. Top summary strip, two filter
  rows (state + alignment), per-row buttons for each verdict
  with an optional 500-char note, deep-links into the lead
  drawer, and explicit footer copy: *"These labels do not
  enable autopilot. They only improve future calibration."*
- A **Guardrail rule signals** card on the
  `AutopilotSimulationPanel` showing the top 5 rules by
  reviewed-disagreement volume with their false-positive rate.
  Rates above 50% render red, above 25% amber.

Hard rules baked into the codebase + the docs:

- A row labeled `confirmed_guardrail_too_strict` does NOT
  weaken the corresponding risk rule automatically.
- A row labeled `confirmed_operator_error` does NOT block the
  operator from sending similar drafts in the future.
- A `promising` simulation readiness PLUS a high
  `reviewed_disagreements_pct` PLUS a low false-positive rate
  is still not permission to enable autonomy — the next phase
  (8BA — Per-Venue Autonomy Readiness Gate) is the place
  where eligibility is even DECIDED, and even then only as a
  read-only signal that a future phase will turn into an
  opt-in toggle.

## 7j. Autopilot simulation mode (Phase 8AY)

Phase 8AY is the third layer of the safety stack. Phase 8AV
gated low-confidence sends, Phase 8AW measured calibration,
Phase 8AX classified each draft as eligible / review / blocked
under guardrails — and Phase 8AY now answers the question that
opens the door to autonomy:

> *"If we'd turned autopilot on for the last 30 days, would the
>  operator have agreed with what it did?"*

Critically: this phase ships ZERO autonomous sending. Operator
approval remains mandatory. The
`autonomous_sending_still_disabled` health flag from 8AX stays
`mounted` so a monitor can assert the safety posture has not
regressed.

What 8AY adds:

- A pure helper
  (`lib/revenue-os/autopilot-simulation.ts`) that projects each
  draft into `would_send` / `would_require_review` /
  `would_block` (mirroring the 8AX modes), classifies the
  operator's actual action as `aligned` /
  `operator_more_conservative` / `operator_less_conservative` /
  `unknown`, and estimates the minutes autopilot WOULD have
  saved per eligible+sent_as_is row.
- A roll-up summary with a tri-state **readiness signal**:
  - `promising` — at least 20 scored rows AND eligible→sent_as_is
    rate ≥ 80% AND blocked→sent_as_is rate ≤ 10%.
  - `watch` — at least 10 scored rows AND fewer than 20% of
    rows were "operator less conservative" (the dangerous
    direction).
  - `not_ready` — anything else.
- A dedicated `/api/admin/ai/autopilot-simulation` endpoint over
  a configurable 1–90 day window (default 30) — wider than the
  draft-audit page slice — returning summary, per-mode buckets,
  and up to 5 recent mismatches with lead deep-links.
- The same simulation block is also emitted by the admin
  draft-audit route over the loaded page, so CSV exports carry
  `simulation_mode` / `operator_alignment` /
  `estimated_time_saved_minutes` columns.
- An **AutopilotSimulationPanel** mounted between the
  BrandVoiceCalibrationPanel and the AIDraftAuditCard, renders:
  four tiles (Would send / Review required / Would block /
  Estimated time saved), the readiness card with the three
  states, a bucket section showing operator outcomes per
  autopilot mode (with `Sent as-is` on the Blocked bucket
  highlighted red — those are the dangerous false-positives),
  and the recent-mismatches list with deep-links into the lead
  drawer.

The readiness signal is intentionally conservative. `promising`
is NOT permission to enable autonomy — it's the precondition
the next phase (8AZ — Autopilot Shadow Evaluation + False
Positive Review Queue) will use to start a structured review of
the cases where the system and the operator disagreed.
Operator approval remains the only gate that emits a message
until a future phase explicitly opens it.

## 7i. Safe autopilot guardrails (Phase 8AX)

Phase 8AX defines the safety gate that any future autonomy will
have to clear. The system does NOT send anything on its own; it
classifies every draft into one of three states and shows the
operator (and the audit trail) what would have happened if
autonomy were on.

The classifier is a pure helper (`lib/revenue-os/autopilot-
guardrails.ts`) consumed by the regenerate route, the lead
drawer, the audit row detail, and the calibration panel. Three
modes:

- **Eligible** — high confidence, no hard-risk flags, healthy
  context, clean operator history. Helper copy:
  *"This draft is low-risk, but still requires operator
  approval."*
- **Review required** — medium confidence, edited-before-send
  history, high lead score with only medium confidence, or a
  context-needs-more signal. Helper copy:
  *"Review before sending. The system detected medium confidence
  or context gaps."*
- **Blocked** — low confidence (final < 65 or heuristic < 55),
  selected-variant-was-low-confidence, or any **hard-risk
  category** firing (pricing / policy / availability), or
  needs-more-context combined with sub-80 confidence. Helper
  copy:
  *"Do not auto-send. Operator review is required because this
  draft may involve pricing, policy, availability, or low
  confidence."*

The hard-risk categories are deliberate. Pricing, policy, and
availability are the surfaces where an AI getting a detail wrong
costs real money or trust — exactly the categories an operator
HAS to own. They're detected by a deterministic keyword scan
(`detectDraftRiskFlags`) rather than another LLM call, so the
classifier is fast, free, and auditable.

The persistence shape is additive on
`ai_actions.metadata.autopilot_decisions` + `variant_risk_flags`
(parallel to `variants_offered`). The API response on
`/api/ai/draft` adds `autopilot_decisions[]` next to the existing
`drafts` / `confidences` arrays. None of the 8AV/8AW field names
moved — every previous reader keeps working.

The LeadDetailDrawer renders the decision pill + helper directly
under the existing confidence chip; switching variants updates
both. The AIDraftAuditCard appends the decision + risk flags to
the per-row detail line ("Final 82 · Model 88 · Heuristic 76 ·
Review required · pricing risk"). The Brand Voice Calibration
panel grows an **Autopilot readiness** breakdown (Eligible /
Review required / Blocked percentages over the loaded page) with
an explicit disclaimer that the percentages don't enable
autonomous sending.

Forbidden in this phase: any code path that emits a message
without an operator click. The autonomy gate is closed; the
`autonomous_sending_still_disabled` health flag exists so a
monitor can assert that posture hasn't regressed. Phase 8AY is
**Autopilot Simulation Mode** — logging "would have sent"
decisions under real traffic without sending anything — and
Phase 8AZ+ may eventually graduate the gate, but only after the
panel shows steady eligible/review rates over a meaningful
window.

## 7h. Brand Voice calibration telemetry (Phase 8AW)

Phase 8AW is the trust layer for the Phase 8AV confidence gate.
Before we hand the Brand Voice agent any autonomy, we have to be
able to answer: *is the confidence score itself trustworthy?* Telemetry
ships first, autonomy ships later (Phase 8AX).

What we measure now, per venue, on every regenerate:

- **Model self-rating** (`metadata.model_variant_confidences`) — what
  Claude thought of its own variant.
- **Heuristic score** (`metadata.heuristic_variant_confidences`) — what
  a deterministic text check thought.
- **Final shown to operator** (`metadata.variant_confidences`, kept
  under the original 8AV field name) — `min(model, heuristic + 10)`,
  the conservative cap so the model can't inflate.
- **Adjustment delta** (`metadata.confidence_adjustment_deltas`) —
  `final - model`. Big negative deltas mean the model is overrating
  itself.
- **`confidence_source`** — `model_and_heuristic` vs
  `heuristic_fallback` for the rare runs where the model didn't emit
  a CONFIDENCE line.

Operator behavior is the other half of the telemetry. The messages
POST route stamps the source draft action with an
`operator_outcome`: `sent_as_is` | `sent_after_edit` |
`regenerated` | `abandoned` | `unknown`, plus an
`edit_distance_bucket` (`none` | `minor` | `moderate` | `major`)
computed by normalizing length-ratio + Jaccard token overlap rather
than raw Levenshtein. Regenerating an unsent draft marks the prior
row `regenerated`; approving & sending marks it `sent_as_is` (or
`sent_after_edit` when the operator edited materially before
sending). Outcomes are terminal-once and best-effort — a telemetry
write never blocks a send.

The operator-facing surface is the **Brand Voice Calibration
panel** on `/dashboard/settings/billing`, mounted above the existing
AIDraftAuditCard. It renders four tiles (low-confidence rate, avg
confidence, regenerate rate, edit-before-send rate) plus two
signal cards:

- **Overconfidence signal** (low/medium/high) — derived from the
  average adjustment delta and the regenerate-or-edit rate.
  Operator-friendly copy ("Watch", "High") with a one-line
  explanation, never raw model-uncertainty jargon.
- **Venue context signal** (`healthy` / `needs_more_context`) —
  scans the per-row instruction + output_summary for phrases like
  *pricing*, *availability*, *policy*, *capacity*. When ≥25% of the
  page mentions any, we nudge the owner to add venue context
  rather than letting them blame the AI.

Below the panel, each AIDraftAuditCard row now shows a muted
"Final 68 · Model 84 · Heuristic 58 · sent after edit" detail line
when the row has 8AW data (pre-8AW rows stay quiet). Hovering
expands the full breakdown.

This phase deliberately ships no autonomy. The order is **8AV
gate → 8AW telemetry → 8AX cautious auto-regenerate**: we measure
whether the gate is calibrated *before* we let the gate fire
without a human in the loop.

## 7g. Brand Voice confidence + escalation (Phase 8AV)

Phase 8AV closes the high-ticket sales objection:

> *"How do I know the AI won't say something off-brand or send a
> reply it isn't confident about?"*

Every AI draft variant the regenerate endpoint produces now carries
a **confidence score 0–100**. The score originates from the model's
own self-rating (the system prompt asks Claude to append a
`CONFIDENCE: <int>` line per variant) and falls back to a text
heuristic when the model forgets to emit one. Confidence is
persisted on `ai_actions.metadata.variant_confidences` so the audit
trail can replay "operator sent option 2 with confidence 82" without
any data loss.

The dashboard surfaces this in three places:

1. **LeadDetailDrawer chip** — the AI draft card's status pill now
   reads `Awaiting review · 82/100` (or `Low confidence · 58/100`
   when below the floor). Tone is amber, not alarm-red.
2. **Escalation gate** — a venue-tunable
   `brandVoiceEscalationMode` (`off`/`warn`/`block`) decides whether
   Approve & send is hard-blocked when confidence dips below the
   floor. The default is `warn` — visible nudge, operator still in
   control.
3. **AIDraftAuditCard** — a `Low confidence` filter chip lets
   admins audit every regenerate that produced an under-floor
   variant, with the score on each row.

Settings live under `venues.metadata.revenue_os` next to the rest
of the Revenue OS thresholds (floor: 0–100, default 70; mode:
`off`/`warn`/`block`, default `warn`). No autonomous sending was
introduced — the gate makes sends safer, not faster.

## 7f. Revenue OS owner digest (Phase 8AU)

Phase 8AU reframed the existing operator activity digest from a
generic "tour status events count" email into an owner-facing
**Revenue OS report**. The body now leads with:

1. **Revenue leakage snapshot** — total attention items + the top
   priority label.
2. **Speed-to-Lead** — median first reply, SLA hit rate, overdue
   count, leads measured.
3. **Follow-up recovery** — stalled leads count + high-fit count +
   top 3 stalled leads with the suggested action title.
4. **Tour booking** — qualified-no-tour, unconfirmed, today + top 3
   next unconfirmed tours.
5. **Operator activity log** — the old tour-status-events tables,
   demoted to a quieter container at the bottom so the owner reads
   it as audit context rather than the headline.

Subject line is now `Your VenueRise Revenue OS summary`. CTAs route
to the dashboard + recovery queue + tour-booking queue so the email
is a habit-building loop into the product, not a one-way
notification.

Same digest cadence, same per-user preferences, same unsubscribe /
resubscribe links, same `send_kind` metadata, same audit feeds.
Cron + preview + manual sends all share one body via the pure
`composeRevenueOsDigestSummary` helper. No autonomous sends were
introduced.

## 7e. Tour Booking surfaces (Phase 8AT)

Phase 8AT operationalized the third Revenue OS agent — Tour Booking —
the bridge between qualified leads and revenue. Booked + confirmed
tours are the closest operational proxy we have for booked weddings,
so every tour we lose is a wedding we lose.

Shipped surfaces:

- `TourConfirmationQueueCard` on `/dashboard` — top 5 scheduled-but-
  unconfirmed tours with CTAs to the lead drawer + tour audit drawer.
- `LeadDetailDrawer` "Tour Booking Agent" panel that renders ABOVE
  the recovery explainer when the lead has an actionable tour state.
  Includes a `Schedule tour` CTA (reuses the existing
  ScheduleTourDrawer) and a `Use suggestion in draft` CTA.
- `TourConversionRollupCard` on `/dashboard/settings/billing` —
  Qualified → Scheduled → Confirmed counts + rates over 30 days.
- `?leakage=tour_booking` leads-board filter.

The five tour-shape signals (`qualified_no_tour`,
`tour_scheduled_unconfirmed`, `tour_today`,
`tour_completed_no_next_step`, `tour_no_show_recovery`) are
**operator-visible only** — none of them schedule or send anything
automatically. The whole point of this layer is to keep the operator
in the loop on the revenue-critical transition.

## 7d. Follow-Up Recovery surfaces (Phase 8AS)

Phase 8AS made the Follow-Up Recovery Agent visible to operators
**without giving the AI a steering wheel**:

- `RecoveryQueueCard` on `/dashboard` shows the top 5 stalled
  high-value leads, each with the reason it's slipping + a
  suggested next action.
- `LeadDetailDrawer` has a "Why this lead is slipping" panel that
  explains the active recovery reasons in operator language.
- A "Use suggestion in draft" CTA pre-fills the regenerate prompt's
  instruction field. **The operator must still click Regenerate +
  Approve** — no autonomous generation, no auto-send.
- `RecoveryRollupCard` on `/dashboard/settings/billing` gives the
  owner pipeline-level recovery counts.
- The leads board accepts `?leakage=follow_up_recovery` so any
  recovery surface deep-links to a filtered Kanban with the same
  helper-backed shortlist.

Net effect: stalled leads stop being invisible without the
operator losing control of any send.

## 7c. Speed-to-Lead reporting layer (Phase 8AR)

Phase 8AR closed the loop on the Speed-to-Lead metric by adding owner-
facing reporting + fixing a quiet under-counting bug:

- `SpeedToLeadRollupCard` on `/dashboard/settings/billing` — median +
  p90 first-reply, SLA met rate, overdue count, 7-day sparkline —
  derived from the same helper the per-lead chip uses, so the owner's
  weekly summary always matches what the operator sees on a specific
  lead.
- `KanbanCard` "Reply pending / Reply overdue" chip on new inquiries
  — at-a-glance Speed-to-Lead prompt without per-card DB fetches.
- **Cold-lead baseline fix.** Under the original rule, intake paths
  that didn't seed an inbound `messages.role='lead'` row caused leads
  to look cold the moment they aged past `coldLeadDays`. The helper
  now uses `lead.created_at` as a fallback baseline. The leakage
  count is more honest as a result.

Pattern: every Revenue OS metric is a settings shape + a pure helper
+ a surface that reads from it. Reporting is **derived**, not stored.

## 7b. First operationalized Revenue OS metric — Speed-to-Lead SLA

Phase 8AQ ships the first concrete Revenue OS metric tied to per-venue
configuration:

- **Per-venue SLA settings** live on `venues.metadata.revenue_os`
  (migration 023). First-reply SLA minutes, high-fit threshold, stale
  high-fit window, and cold-lead window are all venue-tunable through
  the admin "Revenue OS thresholds" card on `/dashboard/settings/billing`.
- **`lib/revenue-os/leakage.ts`** computes the leakage signals AND a
  per-lead **Speed-to-Lead score** (0–100) banded by SLA-met /
  within-2x / missed / pending-healthy / pending-overdue.
- The Overview brief, the leads board `?leakage=` filter, and the
  LeadDetailDrawer SLA chip all flow from the same helper, so what
  the owner sees on the Overview matches what an operator can act on
  in the drawer.

This is the model for every future Revenue OS metric: a settings
shape, a pure helper, and a surface that reads from it.

## 8. Where the thesis lives in the codebase today

The strategy isn't only in this doc. It shows up across the product:

- **`/dashboard` Overview** — the `RevenueLeakageBrief` card (Phase 8AP)
  surfaces revenue-at-risk language above the metric grid.
- **LeadDetailDrawer** — multi-variant regenerate + stale guards
  protect operators from sending a stale reply (speed + voice).
- **CommandPalette + message search** — operators find the lead and
  the conversation moment fast (speed-to-lead + recovery).
- **AIDraftAuditCard + VariantReplayDrawer** — accountability without
  micromanagement.
- **Operator activity digest** — daily owner brief (revenue visibility).
- **Tour status events + audit drawers** — tour cancellations and
  ownership are visible, not buried (tour conversion + recovery).

Every future phase should add a row to the list above — or sharpen one
that's already there. If it does neither, it's the wrong phase.

## 9. The Phase 9 reframe — defensibility, not features

Phase 8 made VenueRise valuable: Revenue OS, Brand Voice, Autopilot
simulation, reactivation. **Phase 9 makes it defensible.** The
mid-market wedding-venue buyer expects more than "the AI is good" —
they want to know that:

1. **Every sensitive write is auditable** — who touched what, when,
   from where, with the row state before and after.
2. **Every admin route has explicit tenant/RBAC posture** — no surface
   silently reads cross-tenant; cross-tenant forbidden collapses to
   404 by convention.
3. **Every important log line carries request, user, venue, and route
   context** — incidents reconstruct quickly because the structured
   logger always knows who and what.

Phase 9A delivered the first cut of all three:

- **`public.audit_events`** (migration 027) — venue-scoped, RLS-gated
  to owner/admin via `has_venue_role`, four query indexes for the
  surfaces a reviewer will actually use.
- **`lib/enterprise/audit-events.ts`** — best-effort writer. Sensitive
  keys (password, token, secret, api_key, authorization, cookie,
  webhook_payload, raw_body, stripe_secret) are recursively dropped;
  snapshots are size-capped (4 KB); IPs are salted-SHA-256
  fingerprinted (never stored raw); user-agent is truncated. Failures
  log + Sentry-capture but never throw — the helper NEVER blocks the
  business action.
- **Surfaces instrumented in this phase**: leads PATCH/DELETE
  (including lost-reason set), tours create/update/bulk-cancel,
  settings, venues, availability slots, blackouts, AI safety
  review/reject, operator message send (body length only — never
  the body), digest preferences + manual send, digest suppression
  remove/remove-all, tours clear-pause.
- **`/api/admin/audit-events`** + **`EnterpriseAuditEventsCard`** on
  `/dashboard/settings/billing` — the operator-facing audit surface
  for an investigation. Drawer fetches sanitized snapshots on demand.

What Phase 9A did NOT do (deliberate): no autonomous sending, no
autopilot toggle, no decision logic change, no agent prompt change.
The `autonomous_sending_still_disabled` health flag from 8AX stays
mounted. Phase 9 buys defensibility on top of Phase 8's value — it
does not redo Phase 8.

---

## Phase 8BE — Omnichannel inbox connector foundation

Real venue inquiries arrive on many surfaces: the website
widget, Instagram DM, Facebook Messenger, Meta lead ads,
email, The Knot, WeddingWire, manual entry, and SMS later.
Phase 8BE is the foundation that lets the existing Revenue
OS — kanban, inbox, AI drafts, Approve & send, Speed-to-Lead,
Recovery, Tour Booking, Brand Voice safety, Autopilot
simulation — operate identically regardless of channel.

What it adds:

- A typed channel vocabulary + capability matrix
  (`lib/integrations/channels/*`).
- `external_conversations` + `external_messages` mapping
  tables so the inbox can collapse external threads onto
  one internal conversation with idempotency.
- A `normalizeInboundChannelMessage` helper that every
  inbound route calls.
- Public inbound placeholder routes for website (structured),
  The Knot + WeddingWire (lead-forwarding), and a Meta
  webhook placeholder.
- A `ChannelConnectionsCard` settings surface + per-channel
  source badges in the inbox.
- A `ManualChannelReplyBanner` + `Mark sent manually`
  workflow for channels where VenueRise cannot deliver
  directly (Instagram / Facebook / Meta lead-ads / email /
  The Knot / WeddingWire today).

What it does NOT add: real Meta Send API, real Gmail / Resend
outbound, real WeddingWire / The Knot two-way API,
autonomous sending. `autonomous_sending_still_disabled` stays
mounted. See `docs/OMNICHANNEL-INBOX.md` for the full posture.

---

## Phase 8BH — Attribution sharpens the Revenue OS narrative

Venues don't just ask "who inquired?" — they ask "where are
the inquiries coming from, and which sources convert?"
Phase 8BH closes that loop by stamping derived source
labels on every new lead and surfacing them across the
inbox, kanban, lead drawer, Overview, and analytics.

What's new:

- **Per-lead attribution metadata** (UTM + click IDs +
  landing page + referrer + channel) parsed via a pure
  helper that never throws.
- **AttributionPerformanceCard** on `/dashboard` grouping
  leads + tours + estimated pipeline by source.
- **Attribution breakdown table** on `/dashboard/analytics`.
- **AttributionPanel** in `LeadDetailDrawer` for per-lead
  context.
- **Compact source badges** on `KanbanCard` and (already
  via Phase 8BE-2) `ConversationList`.

What it deliberately does NOT do: real ROAS, ad-spend
ingestion, ad-platform API calls, pixel implementation, or
multi-touch attribution. Phase 8BH preserves the honesty
contract — "estimated pipeline" comes from operator-entered
budgets, not paid-ad spend.

The Revenue OS now answers two of the three operator
questions ("what's broken right now?" + "where is revenue
coming from?"). The third — "what's it worth in real ROAS?"
— stays gated on a future ad-platform integration phase.

---

## Phase 8BI — Booked revenue attribution + ROI proxy

Phase 8BH made source labels visible. Phase 8BI answers the
next operator question: **"Which sources are actually
turning into booked weddings?"**

What's new:

- **AttributionRevenueRow** rollup: per source, leads /
  tours / booked counts + estimated pipeline + estimated
  booked value + lead-→-tour / tour-→-booked /
  lead-→-booked rates.
- **BookedRevenueAttributionCard** on `/dashboard` — top 5
  sources by estimated booked value with honest empty
  state.
- **Analytics section** "Booked revenue by source" with
  the full table.
- **LeadDetailDrawer** flips the Attribution panel header
  to "Booked source" for booked leads + surfaces an
  "Est. booked ~$X" pill when budget is present.
- **KanbanCard** Budget row relabels to "Est. booked" with
  emerald tone for booked leads — same density, sharper
  signal.

Positioning: this is the **Revenue Intelligence** layer
sitting on top of the Phase 8BH attribution capture. It
sits beneath the existing Revenue Leakage / Recovery /
Tour Booking / Reactivation agents and feeds the same
operator narrative: "where is real money coming from?"

NOT ROAS. Ad spend is not connected. Booked value is
estimated from `leads.budget` and labelled as such in
every surface. The full ROAS unlock requires Phase 8BJ+
(source-level leakage drilldowns) and eventually an
ad-platform spend integration.

---

## Phase 8BJ — Source-Level Revenue Leakage Drilldowns

The Revenue Intelligence layer answers "where is real money
coming from?" The 8BJ layer answers the follow-up: **for
each source, where exactly is that source's pipeline
leaking?**

What ships:

- **`buildSourceLeakageSummary`** pure helper
  (`lib/enterprise/attribution/leakage.ts`). Composes the
  existing Revenue OS signal helpers
  (`computeRevenueLeakage`, `computeRecoverySignals`,
  `computeTourBookingSignals`, `computeReactivationSignals`)
  and groups every output by the lead's attribution source
  label.
- **`SourceRevenueLeakageCard`** on `/dashboard` — top 5
  sources by at-risk lead count, top-leak chip per row, +
  a deep-link CTA into the leads board pre-filtered to that
  source AND the dominant leakage bucket.
- **`/dashboard/leads` `?source=<SourceLabel>` filter** that
  composes on top of `?leakage=`. The same URL produces a
  deterministic slice; the amber source filter pill renders
  above the blue leakage pill, each with an independent
  clear control.
- **AttributionPerformanceCard + BookedRevenueAttributionCard
  drilldowns**: per-row "View leads" CTA →
  `/dashboard/leads?source=<sourceLabel>`. Additive only;
  the cards' existing meaning is unchanged.
- **`/dashboard/analytics` "Source leakage breakdown"**
  section: per-source columns for Slow reply / No tour /
  Recovery / Reactivation / Top leak / At-risk + a per-row
  View leads CTA.
- **LeadDetailDrawer Attribution panel** gains a single
  read-only context line ("This lead is part of the Google
  Ads source cohort.") + (when active) a second line
  ("Current source leakage signal: No tour booked.").

Positioning: this is the actionable surface that turns
attribution from a reporting curiosity into a per-source
work queue. The same lead is still subject to the same
existing Revenue Leakage / Recovery / Tour Booking /
Reactivation agents — 8BJ just cuts the queue by source so
operators can ask "what is Google Ads leaking on?" without
hand-aggregating.

NOT ROAS. No ad-platform API calls, no spend ingestion, no
multi-touch attribution. Booked / pipeline values are
estimated from `leads.budget`. Legacy unattributed leads
group under `Unknown` so the operator always sees the
unattributed bucket. Source leakage is an **operator
prioritization lens**, not an accounting report.

---

## Phase GTM-ILR — Instant Lead Response is the wedge

The core pain VenueRise solves: a couple submits an inquiry, then
emotionally moves on if no human replies inside ~5 minutes. Wedding
venues lose deals not because their answer is wrong, but because
their answer is too late.

**Speed-to-first-reply is the moat.** Everything else (CRM,
follow-up cadence, attribution) is downstream. We win when the first
draft is ready in seconds, on-brand, grounded in the venue's KB,
and safe enough that an operator can approve-and-send in one click.

### Why venue voice training matters

A generic "warm and professional" reply reads as a chatbot. The same
reply written with the venue's actual phrasing — their preferred
greeting, their CTA style, two real sample replies the team
previously sent — reads as a coordinator. The lead can't tell the
difference. That's the bar.

The training profile lives at
`venues.metadata.revenue_os.instant_response` and is consumed by
`lib/ai/instant-lead-response.ts` at draft time. It's intentionally
small (tone preset, formality, preferred greeting/CTA,
phrases-to-use/avoid, ≤5 sample replies, safety notes) so a busy
operator can fill it in 5 minutes, not 5 weeks.

### Why auto-send defaults OFF (and stays scaffold-only here)

The risk profile of auto-sending is asymmetric. A single wrong
auto-reply about availability or pricing damages the venue's
reputation far more than a 30-minute delay would. So this phase
ships:

- **Instant AI DRAFT** on every new lead (the value)
- **Safety gate scaffolding** that records `auto_send_eligible: true`
  on the audit row when every check passes (the future plumbing)
- **No outbound integration**. Every reply still requires operator
  approval in the dashboard.

A future phase may graduate the scaffold to a real outbound send,
but only after the calibration panel proves the system can be
trusted at the per-venue level.
