# AI Inbox Scheduling QA

**Phase 8BJ — P0 regression fix.** Manual + transcript-based QA for
the inbox AI's tour availability awareness and contact-info handling.

---

## The bug we fixed

A real lead transcript:

```
Lead: yes when is avail for next week
Lead: email is 67676@gmail.com and 3332323223 is number
Lead: just tell me all the avail times
```

Previous AI behavior (broken):

> "I don't have access to the live calendar right in this chat..."

That response was unacceptable because:

1. VenueRise **does** have access to the venue's calendar — `tour_availability`, `tours`, and `tour_blackouts` are all in the database.
2. The lead had already given email and phone in plain text. The AI's previous turn asked for them again.
3. Saying "I don't have access" makes the AI sound like a generic chatbot, breaking the entire "Revenue OS for wedding venues" promise.

---

## Expected AI behavior after Phase 8BJ

Given the same transcript, the AI should respond similar to:

```
Sarah, here are a few tour openings we have next week:
  - Tuesday, May 26 at 11:00 AM
  - Thursday, May 28 at 2:00 PM
  - Saturday, May 30 at 10:00 AM

Which one works best for you? I have your email and phone on file,
so once you pick a time, we can get it prepared for confirmation.
```

The exact dates depend on the venue's saved `tour_availability` rows
and the test clock. **What must match:**

- ✅ The reply offers actual numbered slots (not "let me check with the team")
- ✅ The reply does NOT say "I don't have access to the calendar" / "I can't see the calendar"
- ✅ The reply does NOT ask for email or phone
- ✅ The reply does NOT say the tour is "confirmed" / "booked" / "scheduled" — only "prepared for confirmation"

---

## Manual QA — full procedure

### Prereqs

- Demo seed loaded (`Settings → Billing → Revenue Recovery load / stress demo`, 250 leads, `sales_demo`, reset checked)
- Venue has at least one row in `tour_availability` (the seed populates this; if blank, add via `Settings → Availability`)
- AI is active for the lead (`leads.ai_active = true`)

### Test 1 — "next week" availability ask, contact already known

1. Open `/dashboard/inbox`
2. Pick a lead in `new_inquiry` or `qualified` that already has email + phone
3. Send: `yea do you have any timing available this week`
4. Send: `yes when is avail for next week`
5. Send: `just tell me all the avail times`

**Pass criteria:**

- ✅ AI reply lists 2–5 specific tour slots
- ✅ Slots are in the future (not past)
- ✅ AI does NOT say it lacks calendar access
- ✅ AI does NOT re-ask for email or phone
- ✅ No tour row is created in the `tours` table

**Inspect the AI message metadata** (Inbox → click the AI reply → look at the metadata block) to confirm:

```json
{
  "scheduling_intent": {
    "timeframe": "next_week",
    "specific_booking": false,
    "availability_configured": true,
    "suggested_slots_count": 3,
    "unavailable_reason": null
  },
  "contact_signals": {
    "email_known": true,
    "phone_known": true,
    "extracted_from_this_message": { "email": false, "phone": false }
  }
}
```

### Test 2 — Lead types email + phone in chat (no prior contact data)

1. Open a fresh lead with `email = null` and `phone = null` (or pick a meta_lead_ads lead from the demo seed where parser left fields blank)
2. Send: `Hi, interested in your venue`
3. Send: `email is 67676@gmail.com and 3332323223 is number`

**Pass criteria:**

- ✅ After turn 2, the `leads` row has `email = '67676@gmail.com'` and `phone = '3332323223'`
- ✅ AI does NOT re-ask for email or phone in any subsequent turn
- ✅ Message metadata shows `extracted_from_this_message.email === true` and `phone === true`

### Test 3 — Venue has no availability configured

1. Edit a test venue: delete all rows from `tour_availability` (or set `is_active = false`)
2. Open a lead under that venue
3. Send: `when can I tour next week?`

**Pass criteria:**

- ✅ AI says something like "I'll check with our team and get back to you with available times"
- ✅ AI does NOT invent specific slots
- ✅ AI does NOT say "I don't have access to the calendar" (this is the bug)
- ✅ Message metadata shows `availability_configured: false` and `unavailable_reason: 'no_availability'`

### Test 4 — Availability exists but all windows are booked

Harder to reproduce on demo seed; document the expected behavior.

- ✅ AI says "Let me check with the team for the nearest openings" (no invented times)
- ✅ Message metadata shows `availability_configured: true`, `suggested_slots_count: 0`, `unavailable_reason: 'no_open_windows'`

### Test 5 — Scheduling intent miss (false negative check)

Send messages that should NOT trigger scheduling intent:

- `What's the parking like?` → no scheduling intent
- `Do you cater?` → no scheduling intent
- `What's your pricing?` → no scheduling intent
- `How big is the room?` → no scheduling intent

**Pass criteria:**

- ✅ Message metadata shows `scheduling_intent: null` (the block is omitted when intent is false)
- ✅ AI responds normally to the actual question

### Test 6 — Specific date request (lead picks a slot)

1. After the AI offers slots in Test 1, send: `Tuesday at 11 works`

**Pass criteria:**

- ✅ AI says something like "Great — I can get that time prepared for confirmation"
- ✅ AI does NOT say "you're booked" or "tour is scheduled"
- ✅ No `tours` row is created automatically (operator must use ScheduleTourDrawer)

---

## What the AI prompt sees (debug output)

Inside `handleIncomingMessage`, the orchestrator builds and injects
two structured blocks into the conversation prompt.

### Example: Test 1 prompt blocks

```
TOUR_AVAILABILITY_CONTEXT:
- Lead is asking for tour availability: yes
- Timeframe hint: next_week
- Lead's exact wording: "next week"
- Venue timezone: America/New_York
- Default tour duration: 60 minutes
- Available suggested slots:
  1. Tue, May 26 · 11:00 AM
  2. Thu, May 28 · 2:00 PM
  3. Sat, May 30 · 10:00 AM
- Instruction: Offer these specific slots to the lead and ask them
  to pick one. Phrase it as "I have these tour openings available…"
  — never say "I don't have access to the calendar." Do NOT say
  the tour is confirmed; a tour record only exists after an
  operator schedules it.

KNOWN_CONTACT:
- email: present
- phone: present
- Instruction: Do NOT ask the lead for their email or phone — both
  are already on file.
```

### Example: Test 3 prompt blocks

```
TOUR_AVAILABILITY_CONTEXT:
- Lead is asking for tour availability: yes
- Timeframe hint: next_week
- Lead's exact wording: "next week"
- Default tour duration: 60 minutes
- Availability configured: no
- Instruction: Do not invent times. Say the team will confirm
  available tour times manually. Do NOT claim you lack calendar
  access (we have the venue's profile, just no availability
  windows yet).

KNOWN_CONTACT:
- email: missing
- phone: missing
- Instruction: If natural to the conversation, ask the lead for the
  missing contact fields (email and/or phone) — but only after
  answering their actual question.
```

---

## Manual-channel preservation

Phase 8BJ does NOT change manual-channel behavior:

- Instagram, The Knot, WeddingWire, Meta Lead Ads messages still
  flow through the same `manual_required` reply path
- The AI still generates a DRAFT; the operator still copies + sends
- The new TOUR_AVAILABILITY_CONTEXT block is included in the
  drafted reply text, so the operator's manual-send reply offers
  the same specific slots

**Verify:** open a lead with `metadata.channel_type = 'instagram'`,
send a scheduling question, confirm the AI draft includes real slots
AND the inbox UI shows the "Mark sent manually" affordance (Phase
8BE behavior, unchanged).

---

## Auto-send posture

Phase 8BJ does NOT enable autonomous tour booking.

- Slots come from `suggestTourSlots` (pure suggestion helper)
- The AI offers slots to the lead
- The lead picks a slot
- The AI says "I can get that prepared for confirmation"
- The operator uses ScheduleTourDrawer to create the actual `tours` row

If a future phase wires AI → tour creation, it must:

1. Go through `/api/tours` POST with operator-equivalent auth
2. Set `status = 'scheduled'` (not `confirmed`)
3. Write an `ai_actions` row with `action = 'tour_auto_scheduled'`
4. Require the venue setting `instantResponse.autoSendEnabled === true`

None of that happens today.

---

## Rollback

If a venue reports the AI is offering wrong slots or breaking on
scheduling messages, the fastest mitigation is to set the venue's
`metadata.revenue_os.instant_response.enabled = false`. This
disables the new path AND falls back to the original
`generateConversationReply` — but the orchestrator's
`handleIncomingMessage` still includes the new context blocks.

If a deeper rollback is needed, revert this commit. The change is
fully additive to `handleIncomingMessage` and the conversation
agent's `extraContextBlocks` parameter defaults to `[]`, so
removing the wiring restores the pre-8BJ behavior exactly.

---

## Known limitations

- **Timezone math is JS-runtime local** in `suggestTourSlots`. If the venue is in PT and the server is in UTC, slot times may be off by hours. Per-venue TZ-aware math is a future phase.
- **No "this week" bias.** The scan starts from `now` for everything except `next_week`. If the lead says "this week", they get the earliest slot regardless of when in the week.
- **No multi-day grouping.** The helper de-duplicates by calendar date, so a lead asking "any time Saturday?" gets at most one Saturday slot.
- **No lead-side direct booking.** Even when the AI offers slots and the lead picks one, the actual `tours` row is created by the operator. A future phase may add a lead-facing confirmation link.

---

# Phase 8BK Addendum — Tour Slot Selection + One-Click Create Tour

After 8BJ closed the "I don't have calendar access" bug, 8BK closes
the loop: when the lead picks one of the offered slots, the operator
sees a one-click "Create tour" affordance.

---

## What's new

1. AI message metadata now persists `offered_tour_slots` (structured,
   not just human text) — so the next inbound reply can be matched
   against the exact set of offered options.
2. Lead message metadata persists `tour_slot_selection` when the
   deterministic detector matches the lead's reply against the prior
   AI message's offered slots.
3. LeadDetailDrawer renders a **Tour time selected — Create tour**
   panel above TourReadinessPanel when the most recent lead message
   has a selection.
4. Clicking **Create tour** opens the existing `ScheduleTourDrawer`
   prefilled with the selected time.
5. The AI prompt picked up a TOUR SLOT SELECTION RULES section that
   forbids saying "confirmed" / "booked" / "scheduled" — the right
   framing is **"prepared for confirmation."**

---

## Selected-slot detection rules

The detector lives in `lib/revenue-os/tour-slot-selection.ts`. Pure,
deterministic, no model call.

| Pattern type | Example | Confidence |
|---|---|---|
| Ordinal | "I'll take the second one" / "option 3 works" | high |
| Weekday + time | "Tuesday at 11 works" / "Thursday 2pm" | high |
| Time-only (unique hour match) | "11 works" / "the 11am" | high |
| Weekday-only (unique day match) | "Saturday works" | high |
| Single-slot affirmative | "yes" / "that works" (when 1 slot offered) | medium |
| Multi-slot bare affirmative | "yes" (when 3 slots offered) | low (ambiguous — no selection) |
| No match | "What's parking like?" | low (no selection) |

When confidence is `medium`, the UI shows a **Medium confidence
match — review before scheduling** chip on the panel.

When confidence is `low` because the reply is ambiguous, the AI
prompt asks the lead to clarify by referencing the offered times.

---

## Manual QA — 8BK test cases

### Case 1 — Single slot, "yes that works"

Setup: AI offers ONE slot (e.g. only one slot fits next week given
the venue's availability).

Lead reply: `yes that works`

**Pass criteria:**
- ✅ Lead message metadata has `tour_slot_selection.selected = true`, `confidence = 'medium'`, `match_reason = 'single_slot_affirmative'`
- ✅ LeadDetailDrawer shows "Tour time selected" panel with the "Medium confidence" chip
- ✅ AI response acknowledges the selected time naturally
- ✅ AI does NOT say "tour is confirmed"

### Case 2 — Multiple slots, ordinal reference

Setup: AI offers 3 slots (Tue 11, Thu 2, Sat 10).

Lead reply: `I'll take the second one`

**Pass criteria:**
- ✅ Lead message metadata records `confidence = 'high'`, `match_reason = 'ordinal_reference (2)'`
- ✅ Drawer panel shows the Thursday 2:00 PM slot
- ✅ No "Medium confidence" chip (high confidence hides it)
- ✅ AI says "Perfect — Thursday at 2:00 PM works..."

### Case 3 — Multiple slots, weekday + time

Setup: same 3 slots.

Lead reply: `Tuesday at 11 works`

**Pass criteria:**
- ✅ `match_reason = 'weekday_and_time'`, confidence `'high'`
- ✅ Drawer panel shows Tuesday 11:00 AM slot
- ✅ Clicking "Create tour" opens ScheduleTourDrawer with that time prefilled

### Case 4 — Ambiguous "yes"

Setup: AI offers 3 slots.

Lead reply: `yes`

**Pass criteria:**
- ✅ Lead message metadata does NOT have `tour_slot_selection` set (or `selected = false`)
- ✅ Drawer panel does NOT appear
- ✅ AI response asks for clarification: "I want to make sure I pick the right time — did you mean Tuesday at 11:00 AM, Thursday at 2:00 PM, or Saturday at 10:00 AM?"

### Case 5 — Panel hides after tour created

Setup: complete Case 3. Click "Create tour", save the tour.

**Pass criteria:**
- ✅ The "Tour time selected" panel disappears from the drawer
- ✅ TourReadinessPanel updates to show `tour_scheduled_unconfirmed` for the newly-created tour
- ✅ Tours page shows the new tour
- ✅ AI continues to say "prepared for confirmation" if asked again (never claims confirmed unless the actual confirm flow runs)

### Case 6 — Operator opens panel for the same selection twice

Setup: same as Case 3. Click "Create tour" — ScheduleTourDrawer opens
prefilled. Operator closes WITHOUT saving.

**Pass criteria:**
- ✅ Panel still shows (operator didn't actually create the tour)
- ✅ Clicking "Create tour" again re-opens ScheduleTourDrawer with the same prefill

---

## What the prompt sees (8BK addendum)

When a selection is detected:

```
TOUR_SLOT_SELECTION:
- Lead selected: Tue, May 26 · 11:00 AM
- Match confidence: high
- Instruction: Acknowledge the selected time naturally. Say "I can
  get [time] prepared for confirmation" — do NOT say the tour is
  confirmed/booked/scheduled. Do NOT ask the lead to pick again.
```

When ambiguous (multi-slot bare yes):

```
TOUR_SLOT_SELECTION:
- Lead's reply may be selecting a time, but it's ambiguous.
- Instruction: Ask the lead to clarify which of the listed slots
  they meant. Reference the offered times by their labels.
```

---

## What persists in DB

**AI message metadata** (when the AI offered slots):

```json
{
  "offered_tour_slots": [
    {"starts_at": "2026-05-26T15:00:00.000Z", "ends_at": "2026-05-26T16:00:00.000Z", "label": "Tue, May 26 · 11:00 AM", "rationale": "..."},
    {"starts_at": "2026-05-28T18:00:00.000Z", "ends_at": "2026-05-28T19:00:00.000Z", "label": "Thu, May 28 · 2:00 PM", "rationale": "..."}
  ],
  "tour_availability_context_used": true,
  "slot_selection_ack": null
}
```

**Lead message metadata** (when the detector matched the reply):

```json
{
  "tour_slot_selection": {
    "selected": true,
    "starts_at": "2026-05-26T15:00:00.000Z",
    "ends_at": "2026-05-26T16:00:00.000Z",
    "label": "Tue, May 26 · 11:00 AM",
    "confidence": "high",
    "match_reason": "weekday_and_time",
    "matched_from_message_id": "<uuid of the AI message that offered the slot>"
  }
}
```

**AI message metadata** (when the AI is acknowledging the selection):

```json
{
  "slot_selection_ack": {
    "label": "Tue, May 26 · 11:00 AM",
    "confidence": "high"
  }
}
```

---

## Honesty + safety (8BK)

- No autonomous tour creation. The detector + panel produce a
  one-click affordance; the operator confirms in
  `ScheduleTourDrawer` (existing component, unchanged).
- No public confirmation link. That's a separate future phase
  with token logic + abuse prevention.
- Manual-channel workflows are unchanged. The detector + panel work
  identically on Instagram / The Knot / WeddingWire drafts; the
  operator copies the draft text as usual, then uses the "Create
  tour" affordance separately.
- AI never says "confirmed" / "booked" / "scheduled" — even when the
  operator HAS just created the tour, the AI doesn't auto-respond
  with confirmation language. The operator's manual approval of the
  next AI reply still gates outgoing wording.

---

## Known limitations (8BK-specific)

- **Hour heuristic for bare numbers.** "11" without AM/PM is treated
  as AM in `extractHour` (8-11 = AM; 1-7 = PM). This misclassifies
  "12" as noon — usually correct, but a lead saying "12 at night
  works" would be misinterpreted (vanishingly rare). The fix is
  context-aware AM/PM disambiguation in a future pass.
- **Single weekday match only.** If the venue has two Tuesday slots
  (e.g. 11 AM and 3 PM), a bare "Tuesday works" doesn't auto-select
  — falls back to `low` confidence and the AI asks for clarification.
  By design.
- **Per-message metadata only.** Selection is computed against the
  most recent AI message with `offered_tour_slots` (we scan back up
  to 3 AI messages). If the operator manually sends a list of slots
  outside the AI draft path, those slots aren't in the metadata and
  selection won't trigger.
- **No realtime selection check.** Once the panel is rendered, it
  doesn't poll for new lead messages — the operator sees the
  selection state at drawer-load time. Refresh the drawer (or
  re-open the lead) to see updates.

---

# Phase 8BL — Lead-Side Tour Confirmation Links

## What changed

The AI now embeds a **signed, expiring, single-use confirmation
link** next to each slot it offers. When the lead clicks the link:

1. `GET /tour/confirm-slot/<token>` validates the token + status +
   expiry server-side and renders a confirm button (NOT a
   tour-creating side effect — link previewers can't book by
   accident).
2. `POST /api/tour/confirm-slot/<token>` validates the token again,
   re-checks slot availability (blackouts + conflicts + window
   membership), atomically flips the token to `used` (single-use
   claim), creates the `tours` row tagged
   `metadata.source = 'lead_confirmation_link'`, writes a system
   message into the conversation, and records both a
   `tour_status_events` row and an `audit_events` row
   (`tour_confirmed_by_public_link`).
3. The operator sees the system message render in the
   ConversationThread with a blue confirmation chip — distinct
   from neutral system messages — so they can immediately see
   that a tour was self-confirmed by the lead.

Honesty contract preserved:
- No autonomous outbound messaging. The lead's click is the
  trigger; the operator still gates every other reply.
- No external calendar sync (Google / Calendly etc).
- No public listing of all venue availability.
- No raw token storage (DB stores SHA-256 of the URL token).
- 7-day default expiry, single-use enforced at the DB layer.

## Manual test cases

### 8BL-1 · Happy path: AI offers slot with link → lead clicks → tour created

1. Set `TOUR_ACTION_SECRET` (≥16 chars) and `NEXT_PUBLIC_APP_URL`.
2. Configure tour_availability (e.g. Mon-Fri 10:00-17:00) and at
   least one open weekday.
3. Lead sends "Can I tour next Tuesday?" via the widget.
4. **Expect AI reply** to include one or more lines shaped like
   `Tue, May 26 · 11:00 AM — confirm: https://<app-url>/tour/confirm-slot/<token>`
   — the URL MUST be the exact one provided in the prompt block,
   not a paraphrase.
5. Open the URL in a fresh browser window. **Expect** a neutral
   white card with "Confirm your tour at <venue>" and a single
   "Confirm this time" button. No tour row should exist yet.
6. Click "Confirm this time". **Expect** the button → "Confirming…"
   → "You're all set" copy.
7. Verify `tours` row exists for `(venue_id, lead_id, scheduled_at)`,
   `metadata.source = 'lead_confirmation_link'`.
8. Verify the token row in `tour_slot_confirmation_tokens` flipped
   `status: 'used'`, `used_at` populated, `used_tour_id` matches.
9. Verify the inbox conversation now shows a blue-chipped system
   message: "Lead confirmed tour for Tue, May 26 · 11:00 AM via
   confirmation link."
10. Verify `audit_events` has a `tour_confirmed_by_public_link`
    row with `actor_kind = 'system'`, `target_table = 'tours'`,
    `target_id = <new tour id>`.
11. Verify `tour_status_events` has an `action = 'confirm'`,
    `actor_kind = 'lead_token'`, `metadata.source =
    'lead_confirmation_link'` row.

### 8BL-2 · Re-click after success: idempotent, no duplicate tour

1. After 8BL-1 succeeds, refresh the confirm-slot page in the
   same browser.
2. **Expect** the page to render the `already_used` failure
   surface: "This tour time is already on hold."
3. POST the same token directly: `curl -X POST <url>`. **Expect**
   HTTP 409 with `{ error: 'already_used', ... }`.
4. Verify no additional `tours` row was created.

### 8BL-3 · Expired token

1. Manually update one token row in psql:
   `update tour_slot_confirmation_tokens set expires_at = now() - interval '1 hour' where id = '<id>';`
2. Click the link. **Expect** the "Link expired" failure page.
3. POST the same token. **Expect** HTTP 410 with
   `{ error: 'expired', ... }`.
4. No tour, no audit row.

### 8BL-4 · Revoked by newer AI reply

1. Trigger an AI reply with slots offered (8BL-1 steps 1-4).
2. Without clicking, send another inbound message that triggers
   the AI to re-offer slots (e.g. "Actually can I get Tuesday
   morning?").
3. **Expect** all prior `active` tokens for this
   (lead_id, conversation_id) to flip to `revoked` in the DB.
4. Click the OLD link. **Expect** "This link was replaced by a
   newer one" page. POST returns HTTP 410 `revoked`.
5. Click the NEW link. **Expect** happy path 8BL-1 step 6+.

### 8BL-5 · Slot conflict at click time

1. Trigger an AI reply with a slot. Capture the token URL.
2. As an operator, schedule a different tour that overlaps the
   offered slot (use the ScheduleTourDrawer).
3. Click the confirmation link. The SSR page should render the
   confirm button (the page doesn't re-check at SSR — that's by
   design, it's a heavy check we run on POST).
4. Click "Confirm this time". **Expect** HTTP 409 with
   `{ error: 'slot_unavailable', reason: 'conflict', ... }` and
   the in-page error: "This time slot is no longer available."
5. Verify the token row stayed `active` (no `used_at`).
6. Verify no second tour row was created.

### 8BL-6 · `TOUR_ACTION_SECRET` not configured → graceful fallback

1. Unset `TOUR_ACTION_SECRET` and restart the server.
2. Lead sends "Can I tour Tuesday?". **Expect** AI reply offers
   the times in plain text (no `Confirm:` URL lines).
3. AI message metadata's `confirmation_links_summary` should
   record `{ issued: 0, skipped_reason: 'secret_not_configured' }`.
4. No rows in `tour_slot_confirmation_tokens`.
5. The "team will confirm" pathway still works — operator
   schedules manually as in 8BK.

## Known limitations (8BL-specific)

- **One token per slot per AI reply.** If the AI offers 3 slots,
  3 tokens are minted. Each lead click consumes one; the other
  two stay `active` until the orchestrator's next slot offer
  revokes them (or the 7-day expiry fires).
- **No realtime token-status surface for the operator.** The
  confirmation summary on the AI message metadata snapshots the
  issue-time state (`issued: N`). To see redemptions / revocations
  the operator currently has to look at the inbox thread (system
  message) or `tours` row.
- **No "click-to-cancel" yet.** Phase 8K's `/tour/cancel?token=...`
  cancels an EXISTING tour by id. A lead who clicked a slot-
  confirmation link and now wants to cancel needs to reply to
  the conversation; the cancel flow re-uses the existing 8K
  email + token surface.
- **Future-only.** The SSR page rejects past-time slots before
  ever rendering the confirm button. The POST route re-checks
  the same guard.
- **No tour_action_events row.** The single-use claim lives on
  `tour_slot_confirmation_tokens` (unique `token_hash`) — we do
  NOT also write `tour_action_events` because that table is keyed
  on an existing `tour_id` and is owned by the 8K/8L email-link
  flow.
- **`offered_by_message_id` is back-filled.** The token row is
  inserted before the AI message is saved (we need the URL to
  paste into the prompt), then the orchestrator updates the
  token row with `offered_by_message_id` once the message lands.
  A crash between insert and back-fill leaves the column null;
  the token still works.

---

# Phase 8BL-Hotfix — Public links hidden from AI chat

## Why

Phase 8BL shipped lead-side public confirmation links and the AI
started pasting raw `/tour/confirm-slot/<token>` URLs into chat
bubbles. In practice that produced three problems:

1. The URLs broke the inbox layout horizontally on narrower thread
   widths.
2. Raw URLs look unrefined for a luxury wedding-venue audience —
   the demo loses its premium feel the moment a 200-char `https://`
   string lands in the bubble.
3. The public confirmation route depends on migration 039 being
   applied; until then the links 500 silently.

The 8BK operator-confirmed flow (lead picks a slot → drawer panel
→ operator clicks "Create tour") is more controlled and looks
better. This hotfix routes everyone back to that flow without
deleting the 8BL infrastructure.

## What changed

- `lib/agents/orchestrator.ts` — feature flag
  `LEAD_SIDE_CONFIRMATION_LINKS_ENABLED = false`. When `false`:
  no `tour_slot_confirmation_tokens` rows minted, no
  `offered_by_message_id` back-fill, AI message metadata still
  records `confirmation_links_summary.skipped_reason =
  'links_hidden_from_ai_chat'` for audit visibility.
- `lib/revenue-os/tour-availability-context.ts` — prompt-block
  renderer NEVER emits `Confirm:` URLs anymore (even if a
  `confirmationUrl` field somehow appears on a slot — defense in
  depth). Instruction text explicitly bans URLs.
- `lib/agents/conversation.ts` — TOUR CONFIRMATION LINK RULES
  block replaced with TOUR SLOT MESSAGE FORMAT block. Required
  format: bulleted list, "• Day, Date at Time" per line, asking
  which slot works. Explicit ban on pasting `https://`, `/tour/`,
  or any clickable string.
- `components/dashboard/ConversationThread.tsx` — message bubble
  gets `min-w-0 overflow-hidden whitespace-pre-wrap break-words`
  so long URLs in HISTORICAL messages from the pre-hotfix
  orchestrator wrap inside the bubble instead of blowing out the
  thread width.
- `app/api/health/route.ts` — 5 new flags
  (`lead_side_confirmation_links_hidden_from_ai`,
  `ai_tour_links_hidden_from_chat`,
  `premium_tour_slot_message_format`,
  `inbox_message_overflow_guard`,
  `operator_tour_creation_flow_preserved`). The original 5 8BL
  flags stay `mounted` because the infrastructure still exists.

## Expected behavior after hotfix

- AI offers slots as a clean bulleted list. No raw URLs anywhere.
- Long URLs that exist in historical (pre-hotfix) messages now
  wrap inside the bubble — the thread no longer scrolls
  horizontally.
- Lead selection still triggers the 8BK detector → drawer panel →
  operator-prefilled ScheduleTourDrawer.
- Public confirmation route at `/tour/confirm-slot/<token>` still
  compiles and runs. Without active tokens in the DB, every
  request resolves to `not_found` or `invalid_link` — by design.
- `tour_slot_confirmation_tokens` table receives ZERO new rows
  until the feature flag is flipped back on.

## Manual test cases

### 8BL-HF-1 · Plain bullet list, no URLs

1. In the inbox, send "do you have a tour for next week" as the
   lead.
2. **Expect AI reply** to contain bullet points like:
   ```
   I have these tour openings next week:

   • Saturday, May 23 at 9:00 AM
   • Sunday, May 24 at 9:00 AM
   • Monday, May 25 at 9:00 AM

   Which one works best for you?
   ```
3. **Verify** zero occurrences of `http`, `https`, `/tour/`,
   `confirm-slot`, or any UUID-shaped string in the reply.
4. Verify `messages.metadata.offered_tour_slots` for that AI
   message is still populated (the 8BK detector relies on it),
   but every entry's `confirmation_url` is `null`.
5. Verify `messages.metadata.confirmation_links_summary.skipped_reason
   = 'links_hidden_from_ai_chat'`.
6. Query `tour_slot_confirmation_tokens` — no new rows since the
   hotfix.

### 8BL-HF-2 · Operator-confirmed selection flow preserved

1. Continue from 8BL-HF-1. As the lead, reply "lets do may 27
   at 9 am" (or whichever bullet was offered).
2. **Expect AI** to acknowledge the time without saying
   "confirmed" / "booked" / "scheduled." Phrasing should be
   "I'll get that prepared for confirmation."
3. Open the LeadDetailDrawer for that lead.
4. **Expect** the "Tour time selected" panel to render above the
   TourReadinessPanel with the lead's chosen slot label and a
   "Create tour" button.
5. Click "Create tour." ScheduleTourDrawer opens with
   `scheduled_at` prefilled to the selected slot's start.
6. Save the drawer. Tour row created; conversation thread shows
   the standard tour-scheduled chip.

### 8BL-HF-3 · Inbox overflow guard

1. Open a conversation where a pre-hotfix AI reply contained a
   raw confirmation URL (or insert one for testing via SQL).
2. **Verify** the bubble wraps the URL across multiple lines
   inside the bubble. No horizontal scrollbar appears on the
   thread panel.
3. **Verify** AI bubbles (right-aligned, navy background) and
   lead bubbles (left-aligned, white card) both wrap consistently.
4. Resize the inbox panel narrower (drag the divider). Confirm
   no overflow at any width down to the panel's minimum.

### 8BL-HF-4 · Public route stays dormant

1. Without applying migration 039, hit
   `GET /tour/confirm-slot/abc123def456789` in a browser.
2. **Expect** the friendly "Link not valid" or "Not found"
   surface (the page validates the token + DB row both of which
   fail without migration applied).
3. **Verify** no 500 page, no leaked stack trace, no leaked env
   variable name in the response body.

## Demo cleanup tip

If a demo venue's conversation history contains broken URLs from
the brief window 8BL was live (between commit `3bc5ebd` and the
hotfix), you can either:

- Delete the offending AI messages via SQL
  (`delete from messages where conversation_id = '<id>' and
  metadata->>'confirmation_links_summary' is not null;`), then
  re-trigger the conversation to get a clean reply, OR
- Leave them. The overflow guard (8BL-HF-3) wraps them safely;
  they're cosmetically noisy but functional.

Do NOT add an automatic cleanup job — wiping messages in a
conversation table without operator review is destructive and
out of scope for a UX hotfix.

## Re-enabling links in a future phase

The infrastructure (migration 039, token helper, public page,
POST route, audit catalog, rate-limit catalog entry) is
preserved. To re-enable in a future phase:

1. Build a premium embedded card UI for the AI message bubble
   (the current bubble is plain-text only).
2. Flip `LEAD_SIDE_CONFIRMATION_LINKS_ENABLED` to `true` in
   `lib/agents/orchestrator.ts`.
3. Update the prompt block + conversation rules to instruct the
   AI to render the card-shape, not paste raw URLs.
4. Add a venue-level opt-in (`venues.metadata.revenue_os.lead_side_confirmation_links_enabled`)
   so only venues that asked for it get the surface.
5. Apply migration 039 in any environment that doesn't have it
   yet.

Until those four pieces are in place, leave the flag off.

---

# Phase 8BL-Hotfix-2 — Inbox thread layout regression

## Bug

`/dashboard/inbox` and `/dashboard/inbox/[leadId]` rendered the
conversation thread with a massive blank whitespace below the
messages. The composer floated mid-page; the right-side scroll
continued well past the actual thread content. Visible on any
viewport where a banner (BillingBanner, DemoModeBanner) was active.

## Root cause

Layout chain failure. The inbox roots used
`h-[calc(100vh-60px)] min-h-[640px]`, which assumes ONLY the 60px
sticky topbar consumes viewport. When a banner renders between
the topbar and `<main>`, the inbox is pushed down by the banner
height but still claims `100vh-60px` of its own height. Total
page height exceeds viewport → body scrolls → the inbox's
composer (pinned at the bottom of its flex column) leaves visible
empty space below itself as the user scrolls.

Compounding factors:
- `<main>` in `app/(dashboard)/layout.tsx` lacked `min-h-0`, so a
  flex-1 child using viewport math couldn't constrain itself.
- The inbox thread inner column (`<div className="flex-1 flex
  flex-col bg-white">`) lacked `min-h-0`, so
  `ConversationThread`'s internal `flex-1 overflow-y-auto`
  couldn't engage — message list grew to content size.
- `MessageComposer` lacked `shrink-0`, leaving it vulnerable
  to flex contention compression.
- `min-h-[640px]` forced the inbox taller than available
  viewport on smaller laptops, magnifying the overflow.

## What changed (layout-only)

| File | Change |
|---|---|
| `app/(dashboard)/layout.tsx` | `<main>` adds `min-h-0` (defensive — no-op for pages without explicit height). |
| `app/(dashboard)/dashboard/inbox/page.tsx` | Root: `h-[calc(100vh-60px)] min-h-[640px]` → `h-[calc(100dvh-60px)] min-h-0 overflow-hidden`. Empty-state column gains `min-h-0`. |
| `app/(dashboard)/dashboard/inbox/[leadId]/page.tsx` | Root: same swap. Inner column adds `min-h-0 overflow-hidden`. Lead header div adds `shrink-0`. |
| `components/dashboard/ConversationThread.tsx` | Scroll root adds `min-h-0 overflow-x-hidden`. |
| `components/dashboard/MessageComposer.tsx` | Root adds `shrink-0`. |
| `components/dashboard/inbox/TourLifecycleStrip.tsx` | Root adds `shrink-0`. |

## Expected behavior

- The whole page does not scroll. Only the message list inside
  the thread scrolls.
- The composer is pinned at the bottom of the inbox column.
- Banners (BillingBanner, DemoModeBanner) appearing above the
  inbox do NOT introduce blank whitespace below the thread —
  they trim the inbox's visible height instead.
- Conversation list scrolls independently from the thread.
- Long URLs from pre-hotfix historical messages still wrap
  inside the bubble (Phase 8BL-Hotfix-1 wrapping classes
  preserved).
- Mobile/iOS viewport math now uses `100dvh`, which excludes
  the dynamic browser chrome (URL bar) instead of including
  it — the inbox no longer has a stale gap after the URL bar
  collapses on scroll.

## Manual QA — `/dashboard/inbox`

1. Open `/dashboard/inbox` with no conversation selected.
2. Confirm conversation list on the left + empty-state card on
   the right. No body scrollbar visible.
3. Resize browser shorter (~700px). Empty-state stays centered;
   no blank whitespace appears below.

## Manual QA — `/dashboard/inbox/[leadId]`

1. Open a conversation with 2–5 messages.
2. Scroll inside the thread. Only the message list scrolls;
   the composer stays pinned at the bottom of the column.
3. Confirm NO blank whitespace below the thread.
4. Open a long conversation (20+ messages). Scroll up and down.
   Composer remains pinned; body never scrolls.
5. Resize browser to a small laptop height (~720px). Still no
   overflow.
6. Trigger DemoModeBanner (toggle demo mode on in settings) or
   simulate a billing banner. Re-open the inbox. Confirm the
   inbox trims to fit below the banner — no whitespace below.
7. Click a deep-link `?message=<id>` URL to verify scroll-to-
   message + highlight still works.
8. Send a message via the composer. Confirm the new bubble
   appears and the thread scrolls to the bottom automatically
   (the existing bottom-ref `scrollIntoView` still works).
9. Verify the manual-channel banner + tour lifecycle strip
   render in their normal positions (above the thread, not
   compressed).
10. Verify the Tour-time-selected drawer panel still opens (8BK
    flow preserved).

## Known limitations

- We use `100dvh` which is ES-modern (~95% browser support).
  Older Safari (<15.4) falls back to acting as `100vh`. The
  same overflow bug would re-appear on those browsers when a
  banner renders, but they're well below the venue-operator
  user-base threshold.
- The `h-[calc(100dvh-60px)]` assumes the topbar is always
  exactly 60px. If a future redesign changes the topbar
  height, this calc has to be updated. Pulling the value into
  a Tailwind theme constant would be a cleaner long-term fix
  but is out of scope for a hotfix.
- We did NOT convert the dashboard column to `h-screen
  overflow-hidden` because that would break natural body
  scroll on every other dashboard page (overview, leads,
  tours, analytics, settings). The fix is intentionally
  inbox-local.
