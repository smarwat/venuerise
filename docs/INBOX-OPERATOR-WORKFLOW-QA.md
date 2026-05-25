# Inbox — Operator Workflow QA

**Audience:** pilot operators, internal QA, demo presenters.
**Goal:** one document covering the entire VenueRise inbox the way an operator actually uses it.

VenueRise drafts and sends only when an operator clicks the relevant
action. AI drafts are not sent automatically. Manual channels still
require replying in the original platform unless the operator
explicitly chooses email or SMS.

---

## 1. Inbox overview

The inbox lives at `/dashboard/inbox`.

- **Left rail** — every conversation for the venue, ordered by most-recent activity. Each row shows the lead's name, last preview line, channel-source badge, sentiment dot, and unread count.
- **Center column** — the active conversation thread.
- **Above the thread** — lead context strip (name, email, score, AI active badge) and the tour lifecycle strip (latest scheduled / confirmed / completed tour for the lead).
- **Below the thread** — `ReplyMethodBar` + `MessageComposer`.
- **Right column when no conversation is open** — `UnmatchedEmailQueueCard` (only when count > 0) + `WeekTourPanel` + onboarding card.

### Status conventions

VenueRise NEVER claims `Delivered` until the provider has confirmed delivery via webhook (Resend) or status callback (Twilio). Intermediate states stay honest:

| State | Meaning |
|---|---|
| **Sending…** | Provider has not returned a status yet. After 5 min escalates to "Status delayed". |
| **Accepted by Email** | Resend accepted the message for delivery. This does NOT guarantee inbox placement. |
| **Accepted by SMS** | Twilio accepted this text for delivery. Does NOT mean the lead read it. |
| **SMS sent** | Twilio handed the message to the carrier. Delivery not yet confirmed. |
| **Delivered** | Resend / Twilio confirmed delivery to the recipient. |
| **Email bounced** | Recipient mail server rejected. Retry only if the address was wrong. |
| **SMS undelivered** | Carrier could not deliver. Retry honors suppressions. |
| **Email failed** / **SMS failed** | Provider rejected or transport failed. Retry available. |
| **Saved in VenueRise** | Channel sending not connected — message saved locally only. |
| **Manual fallback** | Operator handled the reply outside VenueRise after a failure. |
| **Manual reply required** | Source channel cannot send directly (Instagram / The Knot / etc.). |

---

## 2. Email reply flow

**Prereqs:** lead has an email address; `OUTBOUND_EMAIL_DELIVERY_ENABLED=1` + Resend API key configured.

1. Open the lead's conversation.
2. Reply method bar reads `Replying via Email · sarah@example.com` with a green **Direct** pill.
3. Type the reply (or use AI mode — see §5).
4. Click send. The bubble appears on the right immediately with a **Sending…** pill.
5. Within 1–2 seconds the pill flips to **Accepted by Email**.
6. When Resend's `email.delivered` webhook fires, the pill flips to **Delivered** automatically (no refresh required).
7. If Resend fires `bounced` or `failed`, the pill turns red and a `Retry` button appears. `Mark handled manually` is also offered.

**Honesty contract:** the pill never says Delivered between Accepted and the webhook firing.

---

## 3. SMS reply flow

**Prereqs:** lead has a phone number; `OUTBOUND_SMS_DELIVERY_ENABLED=1` + Twilio credentials + `OUTBOUND_SMS_FROM` configured; optionally `TWILIO_SMS_STATUS_CALLBACK_ENABLED=1` for live delivered/undelivered events.

1. Open the lead's conversation.
2. Open the reply method dropdown (only present when the lead has both email + phone) and pick **SMS**.
3. Reply method bar reads `Replying via SMS · +1 555 555 5555` with a green **Direct** pill.
4. Type the reply (or use AI mode — drafts will come back short + plain-text when SMS is selected).
5. Click send. Bubble appears with **Sending…** pill.
6. Pill flips to **Accepted by SMS** then **SMS sent** as Twilio returns intermediate states.
7. When Twilio's status callback fires `delivered`, the pill becomes **SMS delivered**. If `undelivered` or `failed`, red pill + `Retry` + `Mark handled manually`.

**Honesty contract:** pill never says Delivered between Sent and the carrier callback firing.

---

## 4. Reply method switching

**When the dropdown appears:** the lead has more than one viable reply path (typically email AND phone).

- Default selection comes from the resolver (`resolveReplyMethod()`).
- Each option shows method label, destination, delivery-mode pill, helper text.
- Selecting an option flips both the bar and the metadata of the next send.
- Selection is per-composer session — switching conversations resets to that lead's default. No DB persistence.

**Server authority preserved:** the send route re-verifies `isOutboundEmailConfigured()` / `isOutboundSmsConfigured()` before any external send. If the operator picks SMS and SMS isn't actually wired, the message saves with `delivery_status='skipped'` and `delivery_skip_reason='delivery_disabled'`. No false delivery claim.

---

## 5. AI draft flow

1. With a conversation open, click **AI** in the composer mode toggle (next to **You**).
2. Type a short hint of what to say.
3. Click send. The composer calls `/api/ai/draft` (it does NOT send anything).
4. A draft preview appears below the textarea in a blue card. Two actions: **Use this draft** + **Dismiss**.
5. **Use this draft** loads the text into the composer + flips mode back to **You**. The operator can still edit before clicking send.
6. Selected reply method is preserved through this flow.

**Channel shape:** when SMS is the selected reply method, the AI is instructed to return 1–2 short sentences (≤ 280 chars, plain text, no signoff). Email keeps the default 2–4 sentence shape.

**Honesty contract:** AI drafts are NEVER auto-sent. The composer footer says so on every render in AI mode.

---

## 6. Delivery statuses

See the status conventions table in §1.

Pills render only when message metadata can defend the claim. Long safe-error strings show only in the pill's tooltip, never as inline text that could break layout. The pill always shows the channel-correct icon (Mail for email, MessageSquare for SMS).

---

## 7. Retry failed email

1. Bubble shows `Email bounced` / `Email failed` / `Saved in VenueRise (delivery disabled)`.
2. Click `Retry` on the pill.
3. The pill flips to **Sending…** and `/api/messages/[id]/retry-email` is invoked.
4. Server re-verifies configuration + suppression list + destination + retry count (max 5).
5. On success the bubble does NOT duplicate — the original row is patched, the original `provider_message_id` is archived to `previous_provider_message_ids[]`.

Retry is NEVER offered for `complained` (recipient marked spam).

---

## 8. Retry failed SMS

1. Bubble shows `SMS undelivered` / `SMS failed` / `Saved in VenueRise (delivery disabled)`.
2. Click `Retry`. The pill button is channel-aware ("Retry SMS delivery" tooltip).
3. `/api/messages/[id]/retry-sms` is invoked. Same insert-once / patch flow as email.
4. Max 5 retries enforced server-side.

---

## 9. Manual fallback

When the pill is in a terminal failure state, a `Mark handled manually` button appears next to `Retry`. Clicking it POSTs to `/api/messages/[id]/mark-fallback` which:

- Flips `delivery_status` to `manual_fallback`.
- Stamps `manual_fallback_at`.
- Removes the Retry button.

Use this after replying through the lead's mailbox / phone outside VenueRise so the inbox record stays accurate.

---

## 10. Inbound email reply

When a lead replies to a VenueRise-sent email:

1. The provider POSTs the inbound payload to `/api/inbound/email`.
2. HMAC-SHA256 signature is verified.
3. The matcher resolves the message to a conversation by Message-Id headers, then by recent-recipient fallback.
4. On match: a `role:'lead'` message row is inserted; the conversation jumps to the top of the sidebar. **AI does not auto-respond** — the operator drafts the reply.
5. On no match: the payload is normalized into `inbound_email_orphans` and surfaces in the Unmatched Replies queue (§12).

---

## 11. Inbound SMS reply

When a lead texts the venue's Twilio number:

1. Twilio POSTs to `/api/inbound/sms`.
2. HMAC-SHA1 signature is verified.
3. Matcher resolves by phone number → most recent conversation.
4. On match: lead-side message inserted. AI does not auto-respond.
5. On no match: normalized into `inbound_email_orphans` with `channel='sms'` (the table is shared with email — operator UI is channel-aware).

---

## 12. Unmatched replies queue

`UnmatchedEmailQueueCard` (internal name; user-facing label is **Unmatched replies**) appears at the top of the inbox empty state when the queue has unresolved entries.

Each row shows:

- Channel icon + sender (email address or phone) + time-ago.
- Subject (email) or "SMS reply" badge.
- Body preview (capped at 280 chars; no raw payloads / headers / provider IDs).
- Match confidence chip.
- A suggested conversation (when the matcher had a candidate) OR a "No suggestion — search below" hint.
- **Link suggestion** button (when present) and **Choose another** to open the inline picker.
- **Dismiss** dropdown with reasons: Spam / Wrong venue / Duplicate / Not relevant / Auto-responder / Other.

The picker is a local filter over the conversation pool already loaded by the inbox page — no extra API call, zero new attack surface. Search by lead name or email; SMS phone numbers can be pasted into the search too.

Linked replies appear in the selected conversation as `role:'lead'` messages. **AI does not auto-respond after linking.**

---

## 13. Manual channel workflow

For channels VenueRise cannot deliver back through (Instagram, Facebook Messenger, The Knot, WeddingWire, Meta lead ads):

1. The reply method bar defaults to the channel-native option with a **Manual** pill and helper text such as `Reply in The Knot, then mark sent manually.`
2. `ManualChannelReplyBanner` (mounted from a draft surface) offers `Copy reply` + `Mark sent manually`.
3. `Mark sent manually` POSTs to `/api/conversations/[id]/mark-sent-manually` which inserts a `role:'human'` message row + an `external_messages` row recording the operator action.
4. **No email/SMS goes out unless the operator explicitly picks Email or SMS from the reply method dropdown.** Those options appear in the picker when the lead has the corresponding contact method on file.

---

## 14. What VenueRise does not do yet

This list reflects the honest current product surface — operators should not promise these to leads.

- **No per-venue Twilio numbers.** All SMS sends go from a single platform-level `OUTBOUND_SMS_FROM`. (Phase 8BW reserved → renamed to 8BX once implemented.)
- **No autonomous AI sending.** AI only drafts; operator clicks Send.
- **No Instagram / Facebook / The Knot / WeddingWire direct send.** These remain manual workflows.
- **No inbound email forwarding fallback** beyond the provider webhook. If the inbound webhook isn't configured, replies aren't captured.
- **No MMS** — only SMS.
- **No automatic A2P 10DLC registration** — operators must register the sending number themselves before high-volume SMS.
- **No persistent per-lead reply method preference.** Selection is per-composer session.
- **Voice + attachments in the composer are placeholders.** The buttons are disabled with explanatory tooltips.

---

## Honesty contract recap

VenueRise drafts and sends only when an operator clicks the relevant
action. AI drafts are not sent automatically. Manual channels still
require replying in the original platform unless the operator
explicitly chooses email or SMS.

If you ever see UI copy that contradicts this, file a bug — it's a regression of the 8BM → 8BV honesty work, not intended behavior.
