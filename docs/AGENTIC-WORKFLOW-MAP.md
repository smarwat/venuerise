# VenueRise Agentic Workflow Map

> Companion to [PRODUCT-THESIS.md](./PRODUCT-THESIS.md). The thesis says
> *what* we sell; this map says *how the AI actually earns its keep.*

VenueRise is not "an AI assistant" — it is a **system of cooperating
agents** that protect revenue at every step of the venue lead lifecycle.
Each workflow below has:

- a single job-to-be-done,
- a clear trigger,
- explicit inputs / outputs,
- an escalation rule (when to hand off to a human operator),
- and a measurable success signal.

When we add a new feature, we either add a new workflow here or
strengthen an existing one. If a feature doesn't slot into a workflow,
it's a CRM-shaped distraction.

---

## Agent inventory at a glance

| # | Agent                              | Owns                                          | Today |
|---|------------------------------------|-----------------------------------------------|-------|
| A | Speed-to-Lead Agent                | The first reply within minutes of a new inquiry | 🟢 stronger (Phase 8AQ SLA + per-lead score) |
| B | Qualification Agent                | Extracting + scoring fit + urgency            | 🟢 live  |
| C | Tour Booking Agent                 | Driving qualified leads to a booked tour      | 🟢 stronger (Phase 8AT confirmation queue + drawer panel + conversion rollup, Phase 8BB venue-availability slot suggestions, Phase 8BC availability intelligence — duration, buffer, blackout dates, venue timezone) |
| D | Follow-Up Recovery Agent           | Re-engaging stalled leads                     | 🟢 stronger (Phase 8AS queue + drawer explainer + suggested actions, Phase 8BD reactivation queue for LOST leads with operator-supplied lost reason taxonomy) |
| E | Revenue Leakage Agent              | Surfacing what's slipping + why               | 🟢 stronger (Phase 8AP brief + 8AU owner digest reframe) |
| F | Operator Accountability Agent      | Tracking + replaying staff actions            | 🟢 live  |
| G | Brand Voice / Concierge Agent      | Keeping every reply on-tone + safe            | 🟢 hardened (Phase 8AV confidence + escalation gate, Phase 8AW calibration telemetry, Phase 8AX autopilot guardrails, Phase 8AY autopilot simulation mode, Phase 8AZ shadow evaluation + review queue, Phase 8BA per-venue readiness scorecard — autonomous send still disabled) |

Legend: 🟢 live and well-covered; 🟡 has some scaffolding, needs a focused phase.

---

## A. Speed-to-Lead Agent

**Job-to-be-done:** Make sure no inquiry waits more than a few minutes
for a substantive reply, especially after hours.

**Trigger:** New row in `leads` (today via widget intake), new
`role='lead'` message on an existing conversation.

**Inputs:**
- Lead identity, event date, guest count, budget, source.
- Venue knowledge base entries (existing).
- Time of day / venue business hours.

**Outputs:**
- A first-reply draft (or auto-send when configured).
- A response-time SLA timer on the lead.
- An escalation if the lead looks high-risk (e.g. tight event date,
  high-value budget, repeat domain).

**Escalation rule:** If the lead matches a configurable
"hot-lead" signature (high budget, tight date, high fit-score), the
agent prefers an operator review path over auto-send.

**Success signal:** Median time-to-first-reply across new inquiries;
percentage of inquiries answered within 5 / 15 / 60 minutes; share of
hot leads where an operator approved (rather than the AI auto-sent).

**Today:** The `/api/widget` intake hands off to the orchestrator,
which writes a `lead`, sets up a `conversation`, and (per Phase 8AK+)
operators can regenerate or send drafts. **Phase 8AQ** adds the
formal SLA contract: per-venue `firstReplySlaMinutes` setting,
`computeLeadSpeedToLeadScores` helper (`lib/revenue-os/leakage.ts`),
and the LeadDetailDrawer "SLA met / missed / pending" chip.
**Phase 8AR** closes the loop with the owner-facing roll-up card +
KanbanCard at-a-glance chip + a cold-lead baseline fix (uses
`lead.created_at` when no inbound message exists). The hot-lead
escalation contract (auto-route vs auto-send by signature) is the
remaining gap.

---

## B. Qualification Agent

**Job-to-be-done:** Convert raw inquiry fields into a usable fit + urgency
signal so operators know which lead to touch first.

**Trigger:** New lead or a lead whose `notes` / message body changes
materially.

**Inputs:** Lead row + venue capacity + venue base price + recent
inquiry messages.

**Outputs:**
- `lead.lead_score` (0–100)
- `lead.urgency` ('low' | 'medium' | 'high' | 'critical')
- A short rationale (stored on `ai_actions.output_summary`) explaining
  *why* the score is what it is.

**Escalation rule:** When the rationale cites a hard mismatch
(capacity, date, budget), the agent flags `lead.stage='lost'` only as a
suggestion — never auto-flips a stage.

**Success signal:** Operator agreement rate with the suggested score
when they triage; ratio of high-score leads that ever reach `tour_scheduled`.

**Today:** Live via `lib/agents/lead-qualifier.ts`. The score and
urgency are persisted on the lead row and surfaced across drawer +
Kanban. The rationale lives in `ai_actions`. A future Phase should give
the rationale a first-class UI surface ("Why this score?") instead of
hiding it in the audit log.

---

## C. Tour Booking Agent

**Job-to-be-done:** Take a qualified lead and get them onto the calendar,
because **booked tours are the single biggest predictor of booked weddings.**

**Trigger:** `lead.stage` transitions to `qualified`; an existing
conversation surfaces tour-related keywords; or an operator clicks
"Schedule tour" from the drawer / palette.

**Inputs:** Lead context, available tour slots (today operator-curated),
venue availability rules.

**Outputs:**
- A suggested slot list (today rendered in `ScheduleTourDrawer`).
- A draft tour confirmation message.
- A `tours` row + `tour_status_events` entry.
- A reminder to the operator when a tour is `scheduled` but not yet
  `confirmed` 24h before the slot.

**Escalation rule:** If a lead asks specific questions about
availability that we can't verify, hand off to an operator instead of
guessing.

**Success signal:** Qualified-to-scheduled-tour ratio; tour
confirm-vs-cancel ratio; share of scheduled tours that get a confirmation
touch from the operator (or auto-confirm).

**Today:** ScheduleTourDrawer + tour status realtime + tour audit
surfaces exist. **Phase 8AT** adds the operator-visible scoring layer:
`computeTourBookingSignals` (`lib/revenue-os/tour-booking.ts`),
`TourConfirmationQueueCard` on `/dashboard`, the LeadDetailDrawer
"Tour Booking Agent" panel (with Schedule + Use-suggestion CTAs),
`TourConversionRollupCard` on `/dashboard/settings/billing`, and the
`?leakage=tour_booking` leads-board filter. **Phase 8BB** closes the
"auto-slot suggestions from a real availability source" gap: the
TourReadinessPanel now renders up to 2 clickable chips computed by
`suggestTourSlots` (`lib/revenue-os/tour-slot-suggestions.ts`) over
the venue's saved `tour_availability` windows + existing tour
calendar. Clicking a chip pre-fills the existing ScheduleTourDrawer
via the Phase 8I `defaultScheduledAt` prop — the operator still
confirms inside the drawer. No autonomous scheduling. **Phase 8BC**
makes those suggestions operationally realistic for real venues:
new per-venue `tourDurationMinutes` + `tourBufferMinutes` settings
(RevenueOsSettings extension), a new `public.tour_blackouts` table
(migration 025) with operator-managed UI inside Settings →
Availability, and venue-timezone awareness threaded into both the
candidate generation + chip-label formatting. Buffer is applied
AFTER existing tours during the conflict check; blackout dates
drop matching candidates; the chip caption + tooltips reflect
which signals are in play. Still operator-confirmed. An automatic
reminder loop remains a gap for a later phase.

---

## D. Follow-Up Recovery Agent

**Job-to-be-done:** Catch leads going cold and re-engage them with a
sequence that adapts in tone over time.

**Trigger:** A lead has had no `message` activity for N hours (config
per stage); a tour was cancelled and no follow-up message exists; the
operator-approved draft was sent more than 48h ago with no inbound reply.

**Inputs:** Conversation history, lead stage + score, time since last
inbound message, prior follow-up cadence on this lead.

**Outputs:**
- A scheduled follow-up message via `follow_up_schedules` (table
  exists today; agent live but operator surface is thin).
- A "this lead is cooling" signal on the dashboard / Kanban card.
- Tone progression: nudge → check-in → graceful close-out.

**Escalation rule:** A high-fit lead that's about to drop into the
close-out tone gets surfaced to the operator first — closing out an
$80k wedding inquiry without a human touch is not acceptable.

**Success signal:** Cold-lead reactivation rate (cold lead → next-step
within 14 days); share of high-fit cold leads that get manual touch
before close-out.

**Today:** `lib/agents/followup.ts` + `follow_up_schedules` table
exist. **Phase 8AS** adds operator-visible recovery surfaces:
`computeRecoverySignals` (`lib/revenue-os/recovery.ts`),
`RecoveryQueueCard` on the Overview, the LeadDetailDrawer "Why this
lead is slipping" panel + "Use suggestion in draft" CTA (pre-fills
the regenerate instruction; operator stays in control of the actual
send), the `?leakage=follow_up_recovery` leads-board filter, and
the `RecoveryRollupCard` on `/dashboard/settings/billing`.
Autonomous sending is intentionally NOT shipped — the agent is an
operator-visible queue, not a worker.

**Phase 8BD** extends Follow-Up Recovery to LOST leads with an
operator-supplied reason taxonomy: migration 026 adds
`leads.metadata` (jsonb + GIN); the LeadDetailDrawer surfaces a
skippable "why was this lead lost?" prompt on the lost-stage
transition; `lib/revenue-os/reactivation.ts` classifies lost
leads as `strong_candidate` / `possible_candidate` based on
reason + cooling window + pre-event no-touch guard; a
`ReactivationQueueCard` lives on the Overview; a
`ReactivationPanel` mirrors the recovery explainer inside the
LeadDetailDrawer; the leads board accepts
`?leakage=reactivation` (DnD suppressed); a new admin endpoint
`/api/admin/leads/reactivation-queue` surfaces the same
roll-up; the operator digest gets a "Reactivation candidates
this week" section. Still operator-confirmed — reactivation
replies flow through the existing brand-voice + autopilot
safety stack and the operator clicks Approve & send.

---

## E. Revenue Leakage Agent

**Job-to-be-done:** Make every place a lead can die *visible* and
*addressable* — for the operator AND for the owner.

**Trigger:** Continuous (read-only over existing tables). No write
behavior; this agent is a lens, not an actor.

**Inputs:** `leads`, `conversations`, `messages`, `tours`,
`ai_actions`, `tour_status_events`.

**Outputs:**
- A live "Revenue leakage watch" card on the Overview dashboard
  (Phase 8AP).
- A daily / weekly owner digest (Phase 8R+ operator activity digest is
  the early version; should evolve toward revenue framing).
- Per-lead leakage reason chips on Kanban cards / drawer ("No reply",
  "Tour unconfirmed", "Stalled after tour").

**Categories of leakage we surface:**

1. **No first reply.** New inquiry, no outbound message in N minutes.
2. **No tour booked.** Qualified lead with no `tours` row.
3. **Tour cancelled, no recovery.** `tours.status='cancelled'` + no
   follow-up message after the cancellation.
4. **No follow-up after tour.** `tour_completed` stage + no outbound
   message in 48h.
5. **High-fit lead ignored.** `lead_score >= 80` with no activity in 24h.
6. **Cold leads to recover.** Last inbound > 14 days, not lost/booked.

**Escalation rule:** Owner-facing surfaces should never blame an
operator publicly; aggregate-level only. Per-operator visibility lives
in Agent F.

**Success signal:** Leakage count trending down week-over-week;
operator action rate on flagged items.

**Today:** RevenueLeakageBrief (Phase 8AP) ships the Overview card.
**Phase 8AU** ships the owner digest reframe: the daily/weekly
email now leads with leakage / speed-to-lead / recovery / tour
booking sections instead of raw tour_status_events counts.
Composes the four pure helpers via
`lib/revenue-os/digest-summary.ts` so the digest body and the
dashboard tiles never drift. Per-lead leakage chips on Kanban
cards are the remaining gap.

---

## F. Operator Accountability Agent

**Job-to-be-done:** Show owners *who did what* with revenue-critical
actions, without becoming punitive surveillance.

**Trigger:** Continuous (read-only over audit tables we already write).

**Inputs:** `ai_actions` (reject markers, draft regenerations), the
`messages.metadata.ai_action_id` + `selected_variant_index` allowlist,
`tour_status_events` (actor_kind / actor_id), digest send audits.

**Outputs:**
- AIDraftAuditCard (live) — who regenerated, instruction used,
  accepted variant, latency.
- VariantReplayDrawer (live) — exactly what option was sent on each
  message, with all alternatives the operator declined.
- Tour audit drawer (live) — who scheduled, who cancelled, what
  reason.
- Future: an owner-facing weekly accountability roll-up
  ("3 hot leads went 24h+ without a reply this week — here are the
  conversations.").

**Escalation rule:** Owner-facing roll-ups frame *outcomes* not
*blame*. Surfacing "lead X went unanswered for 26h" is fine; surfacing
"operator Y ignored lead X for 26h" is not, in the public roll-up. The
data is there for an owner who wants to dig in privately.

**Success signal:** Operators don't game the system because they know
the audit exists and is fair; owners can answer "where did we drop the
ball this week?" in under 60 seconds.

**Today:** All the audit surfaces above are live (Phase 8N through
8AO). The owner-facing weekly accountability roll-up is the next
unbuilt surface in this agent.

---

## G. Brand Voice / Concierge Agent

**Job-to-be-done:** Make every AI-authored sentence sound like the
venue's coordinator, not like a chatbot.

**Trigger:** Every AI message generation across every other agent
(qualification rationale, first reply, follow-up, regenerate variant).

**Inputs:** Venue `ai_persona_name`, `ai_tone`, knowledge base entries,
recent conversation history.

**Outputs:**
- Generated text constrained by:
  - Never mention being AI.
  - Never quote hard prices unless the KB supports it.
  - Address the lead by first name.
  - Maintain warm, premium tone.
  - End with one clear next step.
- An escalation when the model isn't confident enough to send safely.

**Escalation rule:** When the answer would require quoting a specific
date, a specific price, or a competitor comparison the venue hasn't
authorized, the agent surfaces an operator review path rather than
inventing detail.

**Success signal:** Operator approval rate on AI drafts; share of
drafts the operator regenerates with an adjustment chip
(`Warmer`, `More concise`, `Add pricing`, `Mention dietary`); share of
draft rejections.

**Today:** Live across the orchestrator + the regenerate path.
**Phase 8AV** makes the "escalate when uncertain" surface explicit:
every regenerate variant carries a 0–100 confidence score (model
self-rating with text-heuristic fallback), the venue picks a floor
+ mode (`off`/`warn`/`block`) on RevenueOsSettingsCard, the
LeadDetailDrawer chip + Approve gate reflect both, and the
AIDraftAuditCard offers a "Low confidence" filter chip + per-row
badge for forensic review. No autonomous sends were added —
escalation means "make the operator pause", not "send something
without permission".

**Phase 8BA** closes the read-only safety stack with a per-venue
readiness scorecard. The new `GET /api/admin/ai/autopilot-readiness`
endpoint reuses the 8AY simulation projection + the 8AZ review
join (no new storage) to produce a single verdict
(`not_eligible` / `watch` / `eligible`) plus a six-gate
breakdown: simulation readiness promising (blocking),
≥ 50 scored rows (blocking), ≥ 80% disagreement coverage
(blocking), no rule false-positive rate above 25% (warning),
zero unreviewed operator-less-conservative rows (blocking),
≥ 14 active days of data (warning). Verdict requires every
blocking gate passing; `watch` allows one warning miss.
**AutopilotReadinessScorecard** mounts ABOVE the simulation
panel on `/dashboard/settings/billing` and renders the verdict
banner, gate checklist with next-step copy, and a permanent
"autonomous sending is still disabled" disclaimer on every
state — including `eligible`. There is no toggle. There is
no action button. Returning `eligible: true` is the
PRECONDITION for a future opt-in phase, not the opt-in
itself. `autonomous_sending_still_disabled` flag remains
`mounted`.

**Phase 8AZ** adds the disagreement-review surface that turns
the 8AY simulation data into structured calibration evidence.
Migration 024 introduces `public.ai_action_reviews` (unique on
`ai_action_id`); two new admin endpoints
(`GET /api/admin/ai/autopilot-reviews` + the per-action POST
sibling) back an **AutopilotReviewQueue** UI on
`/dashboard/settings/billing` where operators label each
disagreement as `confirmed_guardrail_too_strict`,
`confirmed_guardrail_correct`, `confirmed_operator_error`, or
`deferred`. The simulation endpoint's `summary` now carries
`reviewed_disagreements_pct` plus per-rule false-positive
signals, surfaced as a **Guardrail rule signals** card on the
simulation panel. The hard contract: labels are CALIBRATION
EVIDENCE, never CONTROLS — a `confirmed_guardrail_too_strict`
row never weakens its rule, and a `confirmed_operator_error`
row never blocks the operator. The
`autonomous_sending_still_disabled` health flag stays
`mounted`. Phase 8BA is the per-venue autonomy readiness gate
(still read-only) that will eventually consume
`reviewed_disagreements_pct` + the false-positive rates as the
PRECONDITION for any future opt-in autonomy toggle.

**Phase 8AY** ships the simulation layer that bridges measurement
to (eventual) autonomy. Every regenerate now carries a per-row
`simulation_mode` (`would_send` / `would_require_review` /
`would_block`) and an `operator_alignment` classification
(`aligned` / `operator_more_conservative` /
`operator_less_conservative` / `unknown`). A dedicated
`/api/admin/ai/autopilot-simulation` endpoint rolls these up
over a 1–90 day window (default 30) into a summary block — total
scored rows, sent-as-is counts per autopilot mode, an estimated
time-saved figure for the rows autopilot WOULD have sent, and a
tri-state readiness signal (`not_ready` / `watch` /
`promising`). A new **AutopilotSimulationPanel** on
`/dashboard/settings/billing` (between BrandVoiceCalibrationPanel
and AIDraftAuditCard) renders the tiles, readiness card, per-mode
buckets, and up to 5 recent mismatches with deep-links into the
lead drawer. Critically, this phase introduces **zero**
autonomous sending; the `autonomous_sending_still_disabled` flag
from 8AX remains `mounted`. `promising` readiness is the
PRECONDITION for the next phase (8AZ — Autopilot Shadow
Evaluation + False Positive Review Queue, where operators
review every case where the system and the human disagreed) —
NOT permission to flip an autonomy switch.

**Phase 8AX** adds the safety classifier that future autonomy will
have to clear. Every regenerate now persists a per-variant
autopilot decision (`eligible` / `review_required` / `blocked`)
plus the deterministic risk flags that fired (pricing / policy /
availability). The LeadDetailDrawer renders the decision pill +
operator-readable helper directly under the existing confidence
chip; switching variants updates both. The AIDraftAuditCard row
detail line and a new **Autopilot readiness** breakdown on the
Brand Voice Calibration panel surface the trend at the venue
level. Critically, this phase introduces **zero** autonomous
sending — the decision is informational, Approve & send is still
manual, and a dedicated `autonomous_sending_still_disabled`
health flag exists so monitors can assert the posture hasn't
regressed. Phase 8AY ships **Autopilot Simulation Mode** (log
"would have sent" decisions under real traffic without sending),
and only after the calibration panel shows steady eligible/review
percentages over a meaningful window will Phase 8AZ+ consider
graduating the gate.

**Phase 8AW** adds the calibration telemetry that has to land before
any autonomy: every draft persists the raw model self-rating, the
heuristic score, the conservative-capped final, the adjustment
delta, and a `confidence_source` (`model_and_heuristic` |
`heuristic_fallback`) alongside the existing `variant_confidences`
array. The messages POST + draft routes stamp the source
`ai_actions` row with an `operator_outcome` (`sent_as_is` |
`sent_after_edit` | `regenerated` | `abandoned` | `unknown`) plus
an `edit_distance_bucket` derived from length-ratio + Jaccard
token overlap (not Levenshtein — too sensitive to reword). A new
**Brand Voice Calibration panel** on
`/dashboard/settings/billing` renders four operator-friendly tiles
(low-confidence rate, avg confidence, regenerate rate,
edit-before-send rate) plus an **Overconfidence signal**
(low/medium/high) and a **Venue context signal** (`healthy` /
`needs_more_context`). The AIDraftAuditCard rows now carry a muted
"Final 68 · Model 84 · Heuristic 58 · sent after edit" detail
line so operators can scan whether the confidence number actually
predicted what they did. Telemetry only — no autonomous sending
yet; Phase 8AX is the next gate.

---

## Glossary — how this maps to existing code

| Concept                             | Where it lives today                                  |
|-------------------------------------|-------------------------------------------------------|
| Lead intake + conversation creation | `app/api/widget`, `lib/agents/orchestrator.ts`         |
| Qualification rationale + score     | `lib/agents/lead-qualifier.ts`                         |
| Conversation reply generation       | `lib/agents/conversation.ts`                           |
| Draft regenerate (variant aware)    | `app/api/ai/draft`                                     |
| Follow-up scheduling                | `lib/agents/followup.ts` + `follow_up_schedules`       |
| Tour status audit                   | `tour_status_events` + `RealtimeTourStatusLayer`       |
| Operator accountability             | `ai_actions` + `messages.metadata` + audit drawers     |
| Revenue leakage view                | `RevenueLeakageBrief` (Phase 8AP)                      |

## Phase-planning rule

When the next phase prompt arrives, find the agent it strengthens
**before** writing code. If you can't pick an agent in 30 seconds, the
phase is probably building a CRM feature and should be reframed.

---

## Phase 8BE — Omnichannel inbox foundation

Phase 8BE introduces the channel layer beneath every agent
without re-rooting the agent set. The lead intake / qualifier
/ reply drafter / approve & send loop continues to fire
exactly as before — the only difference is that the lead row
now records `metadata.channel_type` and the inbox bubbles
render the source badge so operators know what surface they
are looking at.

When `manualReplyRequired` is true for the channel the
operator's Approve action is supplemented (not replaced) by
the `Copy reply` + `Mark sent manually` workflow. The brand
voice + autopilot guardrails still gate the draft; the
operator still confirms; the per-message audit row still
fires. The only differece is that the actual delivery happens
out-of-band, recorded as `delivery_status='marked_sent_manually'`
on the `external_messages` row.

Connector phases (8BF Meta, 8BG email/forwarding parser,
8BH SMS) will plug back into the same agent set — only the
delivery + inbound parsing changes. The agent map stays
stable.

---

## Phase 8BH — Attribution

Attribution sits beneath every agent without changing the
agent map. The lead intake agent (widget + omnichannel
normalization) now stamps `metadata.attribution` on each
new lead. Downstream agents (Speed-to-Lead, Recovery,
Tour Booking, Reactivation, Brand Voice) keep operating
identically — they read the lead, not the attribution.

Where attribution affects UX:

- **Overview**: AttributionPerformanceCard groups inquiries
  by source label.
- **Analytics**: attribution breakdown table.
- **Lead drawer**: AttributionPanel shows the per-lead
  campaign / landing / click ID detail.
- **Kanban + inbox**: compact badge next to the lead email.

The attribution layer is purely additive — no agent
prompts change, no scoring changes, no autonomous behaviour
changes. Source labels are an honest reporting surface,
not a routing signal.

---

## Phase 8BI — Revenue Intelligence layer

Classified under the existing **Revenue OS Intelligence**
bucket rather than spinning up a new autonomous agent. The
"Booked revenue by source" rollup is pure inference over the
already-stamped attribution metadata + lead stage + budget;
no new write path, no new prompt, no agent loop.

The Revenue Leakage / Recovery / Tour Booking / Reactivation
agents continue to operate on individual lead state. The
Revenue Intelligence layer answers the per-source rollup
question: "of leads from source X, what fraction reach
booked, and what's the estimated booked value?"

When Phase 8BJ ships (source-level leakage drilldowns), the
existing Leakage agent will be extended to filter by source
label — still no new agent, just a richer cross-section.

---

## Phase 8BJ — Source-level revenue leakage drilldowns

Still **no new agent**, still **no autonomous behavior**.
Phase 8BJ is the cross-section the previous note promised:
the Revenue Leakage / Recovery / Tour Booking / Reactivation
agents continue to run unchanged, and the new pure helper
(`lib/enterprise/attribution/leakage.ts`) joins their
existing signal outputs against the lead's
`metadata.attribution.source_label`.

Operator-facing surfaces:

- **Overview**: `SourceRevenueLeakageCard` — top 5 sources
  by at-risk lead count + top leak chip + deep-link CTA
  into the leads board (`?source=` + `&leakage=`).
- **Leads board**: `?source=` filter composes on top of the
  existing `?leakage=` filter; both have independent clear
  controls; DnD disables while either is active.
- **Analytics**: per-source "Source leakage breakdown"
  table.
- **Lead drawer**: read-only "source cohort" + "current
  source leakage signal" lines in the Attribution panel.
- **Existing attribution cards**: per-row "View leads" CTAs.

No agent prompt changes, no scoring changes, no autonomous
behaviour changes. Source leakage is purely a prioritization
lens layered on top of the existing per-lead signals.

---

## Phase GTM-ILR — Instant Lead Response Agent

**Helper:** `lib/ai/instant-lead-response.ts` →
`generateInstantLeadResponse({ venue, lead, knowledgeBase, training, ... })`

**Trigger path:** widget intake → `enqueueLeadCreated` → orchestrator
`handleNewLead` → `generateInstantLeadResponse`. Same idempotency
guard as before (skip if any `messages.role='ai'` exists for the
conversation).

**Inputs:**
- `venue` — name, description, capacity, base_price, style_tags, persona
- `lead` — name, contact, event_date, guest_count, budget, notes,
  source, lead_score, stage
- `knowledgeBase` — top-N active KB rows, ranked by lead-keyword
  overlap (pricing/capacity/availability/catering/...)
- `training` — `InstantResponseSettings` from
  `venues.metadata.revenue_os.instant_response`

**Output (structured JSON from Claude):**
- `response` — draft text
- `confidence` 0–100 (model self-rating, capped by heuristic)
- `needs_human_review` boolean
- `unsupported_claims[]`, `detected_questions[]`
- `suggested_next_step` ∈ {schedule_tour, ask_clarifying_question,
  team_follow_up, send_pricing_overview}
- `venue_context_signal` ∈ {healthy, needs_more_context}

**Safety stack (composed):**
1. Brand-voice calibration (`computeFinalConfidence`) caps the model
   self-rating at heuristic + 10.
2. Autopilot guardrails (`computeAutopilotDecision`) classify the
   draft as `eligible | review_required | blocked` based on pricing
   / policy / availability detection + confidence floor.
3. `auto_send_eligible` requires ALL of: autoSendEnabled,
   finalConfidence ≥ floor, no unsupported_claims, autopilot=eligible,
   not fallback, not needsHumanReview.

**Failure path:** Anthropic 503 / timeout / malformed JSON →
deterministic warm fallback ("A member of our team will review your
details and follow up shortly"). Lead creation never fails. Fallback
sets `needs_human_review=true` + `fallback_used=true`.

**Relationship to existing agents:**
- Sits BEFORE the follow-up scheduler. The orchestrator still
  schedules the 5-touch sequence after the instant draft is saved.
- Reuses brand-voice-calibration + autopilot-guardrails — does NOT
  duplicate them.
- Replaces the unstructured `generateConversationReply` path inside
  `handleNewLead`. The legacy path is kept as a fallback for venues
  that disable instant response via setting.

**Audit:** writes one `ai_actions` row per call. Action is one of
`instant_lead_response.generated`, `.fallback_created`, or
`.auto_send_eligible`. Metadata includes confidence, needs_human_review,
auto_send_enabled, auto_send_eligible, reasons, latency_ms, model.
