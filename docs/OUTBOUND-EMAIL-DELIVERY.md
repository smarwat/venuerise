# Outbound Email Delivery (Operator Composer)

Phase 8BN — first real outbound channel wired from the inbox
composer. Builds directly on Phase 8BM's Reply Method Bar.

## What this phase does

A venue operator types a reply in the inbox composer, clicks
**Send**, and VenueRise delivers that reply to the lead's email
address via Resend while saving the message in the conversation
thread with accurate delivery metadata.

Concretely, when a website lead with an email is selected:

- Before 8BN — Reply Method Bar said:

  ```
  Reply method
  Email · sarah@gmail.com
  Internal
  Saved in VenueRise only — email sending is not connected yet.
  ```

- After 8BN — when `OUTBOUND_EMAIL_DELIVERY_ENABLED=1` AND Resend
  is configured, the same bar says:

  ```
  Reply method
  Email · sarah@gmail.com
  Direct
  Sends via email when you click send.
  ```

- The sent message appears on the right of the thread with a
  small **Sent via Email** pill.

## What this phase does NOT do

- **No SMS / Instagram / Facebook / The Knot / WeddingWire / Meta
  lead-ad outbound.** Those channels stay `manual` exactly as
  Phase 8BM left them.
- **No autonomous sending.** Direct email send only happens when
  an operator clicks Send. AI drafts never auto-deliver — they
  always route through the human `You`-mode send path.
- **No inbound email parsing.** If the lead replies to the email
  VenueRise sent, the response will NOT automatically appear in
  the conversation thread unless inbound email parsing is wired
  separately (out of scope for 8BN).
- **No per-venue From address.** All sends go from the
  platform-wide `OUTBOUND_EMAIL_FROM`. Per-venue verified-domain
  sending is a future phase.
- **No new admin route.** Reuses the existing
  `/api/conversations/[id]/messages` operator-message route.

## Environment variables

| Var | Required for direct send | Default | Notes |
|---|---|---|---|
| `RESEND_API_KEY` | ✅ | — | Already in `.env.example`. Used by digest + tour notifications today. |
| `RESEND_FROM_EMAIL` | ✅ | — | Platform-wide From address. Must use a verified domain at Resend. |
| `RESEND_REPLY_TO_EMAIL` | optional | — | Default Reply-To. If unset, omitted. |
| `RESEND_WEBHOOK_SECRET` | optional | — | Powers the webhook surface that flips `outbound_messages.status` from `queued` → `delivered` / `bounced` / `complained`. |
| `OUTBOUND_EMAIL_DELIVERY_ENABLED` | ✅ | `0` | New 8BN kill switch. Set `1` / `true` to enable composer-direct sends. |

The new kill switch is intentionally **separate** from the
existing Resend config so a workspace can keep digest +
transactional email running while operator-direct sending stays
off during pilot.

Behavior matrix:

| `OUTBOUND_EMAIL_DELIVERY_ENABLED` | Resend configured | Composer behavior |
|---|---|---|
| `0` / unset | any | `Internal` pill, "Saved in VenueRise only" |
| `1` | ❌ | `Internal` pill, "Email delivery is not fully configured." |
| `1` | ✅ | `Direct` pill, real email send on click |

## Delivery modes (recap from Phase 8BM)

| Mode | Tone | What it means today |
|---|---|---|
| `direct` | Emerald | VenueRise sends the reply via the provider. **8BN: email-bearing leads only, when the kill switch + Resend config are on.** |
| `manual` | Champagne | Operator must copy + send externally. Instagram, Facebook, The Knot, WeddingWire. |
| `internal_only` | Slate | Reply saved in VenueRise; no external delivery. Website widget; email/SMS when the kill switch is off. |
| `unavailable` | Red | No working delivery path. Meta lead ad with no contact info. |

## Failure behavior

The route is **insert-first, send-second, patch-on-result**:

1. The operator's message inserts as `role:'human'` with
   `delivery_status: 'pending'`. It is durable on disk before
   we touch the provider.
2. `sendOutboundEmail()` calls Resend (via the existing
   `sendEmail()` helper).
3. The message row's `metadata` is patched with the result:
   - **Success**: `delivery_status: 'sent'`,
     `delivery_provider: 'resend'`, `provider_message_id`,
     `delivered_at`.
   - **Failure**: `delivery_status: 'failed'`,
     `delivery_error_code`, `delivery_safe_error`. The operator's
     typed text is preserved — they can retry, mark sent
     manually, or escalate.
   - **Skipped** (kill switch off, suppression, etc.):
     `delivery_status: 'skipped'` + reason code. Pill shows
     "Saved in VenueRise" with a friendly tooltip.

The UI pill (`DeliveryStatusPill`) reads `delivery_status` and
renders honestly. We **never** claim "Sent via Email" unless the
provider accepted the message and returned an id.

## Reply-To limitation

We do **not** set `Reply-To` to the lead's own address (that
would route lead replies back to themselves). The platform-wide
`RESEND_REPLY_TO_EMAIL` is used if set, otherwise the header is
omitted.

Because we do not currently parse inbound email, **a lead reply
to a 8BN-sent email may not automatically appear in the
conversation thread**. Operators should monitor the configured
Reply-To inbox manually, or wait for the future inbound parsing
phase.

## Audit + observability

- The existing `outbound_messages` table logs every send (queued
  → delivered/bounced/complained via Resend webhook). Composer
  sends are tagged `surface=operator_composer` for easy filtering.
- The `operator_message_send` audit event row now carries
  `delivery_attempted`, `delivery_status`, `delivery_provider`,
  `delivery_error_code`, and `provider_message_id_present`. The
  recipient email is intentionally NOT included on the audit row
  (it lives on `messages.metadata.reply_destination`, which the
  audit-events helper sanitizes downstream).
- Health route exposes:
  - `outbound_email_delivery: 'mounted' | 'disabled'`
  - `outbound_email_reply_method_direct: 'mounted'`
  - `outbound_email_delivery_status_pills: 'mounted'`
  - `outbound_email_failure_honesty: 'mounted'`

## QA checklist

### With `OUTBOUND_EMAIL_DELIVERY_ENABLED=0` (or unset)

1. Website lead with email → bar shows `Internal` + "Saved in
   VenueRise only…".
2. Operator types reply, clicks Send → message saves as
   `role:'human'`, renders on right, no external send.
3. Health route reports `outbound_email_delivery: 'disabled'`.

### With `OUTBOUND_EMAIL_DELIVERY_ENABLED=1` + valid Resend

1. Website lead with email → bar shows `Direct` + "Sends via
   email when you click send."
2. Operator types reply, clicks Send → message renders on right
   with **Sent via Email** pill.
3. Lead receives the email at the recipient address.
4. `messages.metadata` includes `delivery_status: 'sent'`,
   `provider_message_id`, `delivered_at`.
5. Health route reports `outbound_email_delivery: 'mounted'`.
6. AI does NOT fire a follow-up reply.

### Provider failure path

1. Set `RESEND_API_KEY=re_invalid` (or use a recipient like
   `not-an-email`).
2. Send a reply → message still saves; pill shows **Email failed**
   with the safe-error tooltip.
3. `messages.metadata.delivery_status === 'failed'`,
   `delivery_error_code` populated.
4. No false "Sent via Email" pill anywhere.
5. Operator can re-type or mark-sent-manually.

### Manual channel preservation

1. Instagram / The Knot / WeddingWire leads continue to show
   the `Manual` pill from Phase 8BM.
2. No email send is attempted regardless of whether the lead
   has an email on file (resolver picks the channel-native
   manual method for those sources).
3. `ManualChannelReplyBanner` + `mark-sent-manually` route still
   work unchanged.

### AI mode preservation

1. AI draft generation (`/api/ai/draft`) returns a variant.
2. "Use this draft" loads it into the textarea + flips to
   You mode.
3. Sending then routes through the human send path — if the
   reply method is `direct` email, the AI-drafted reply
   delivers via Resend.
4. AI mode itself never triggers a send.

## Honesty contract

The phrases this surface IS allowed to use:

- "Sent via Email" — provider accepted + returned id.
- "Sending…" — request in flight.
- "Email failed" — provider rejected; operator action needed.
- "Saved in VenueRise" — no external send was attempted.
- "Saved in VenueRise only — email sending is not connected" —
  kill switch off.
- "Manual reply required" — channel needs operator-side copy.

Phrases this surface is NOT allowed to use:

- "Delivered" (different from "Sent" — only the Resend webhook
  can confirm inbox delivery; the pill stays "Sent via Email"
  until then).
- "Auto-sent".
- "Fully automated email".
- "Connected" as a delivery claim without a verified provider id.

## File map

- `lib/integrations/delivery/email.ts` — composer-shaped wrapper
  around `lib/integrations/email.ts` (`sendEmail`).
- `app/api/conversations/[id]/messages/route.ts` —
  insert-then-send-then-patch flow.
- `components/dashboard/messages/DeliveryStatusPill.tsx` — the
  honest pill component.
- `components/dashboard/ConversationThread.tsx` — renders the
  pill on `role:'human'` bubbles.
- `lib/integrations/channels/reply-method.ts` — resolver
  consumes `emailDirectDeliveryEnabled` boolean (no internal env
  reads — caller passes the server-resolved flag).
- `app/(dashboard)/dashboard/inbox/[leadId]/page.tsx` — calls
  `isOutboundEmailConfigured()` server-side and threads the
  result through the resolver.
- `app/api/health/route.ts` — four new flags.
- `.env.example` — `OUTBOUND_EMAIL_DELIVERY_ENABLED` documented.

## Recommended next phases

- **8BO — Inbound email parsing.** Capture lead replies to the
  configured Reply-To and stitch them back into the conversation.
- **8BP — Per-venue verified-domain sending.** Let high-volume
  pilot venues send from their own brand domain instead of the
  platform-wide From.
- **8BQ — SMS outbound via Twilio.** Mirror this 8BN pattern
  for the `sms` reply method.

---

## Phase 8BO update — inbound reply capture wired

Phase 8BO closes the email loop opened here. When a lead replies
to a composer-sent email, the reply now lands back in the
conversation thread as `role: 'lead'` via the new HMAC-
authenticated webhook at `/api/inbound/email`. See
`docs/INBOUND-EMAIL-CAPTURE.md` for the full spec.

The "Reply-To limitation" caveat above is now (mostly) addressed:

- **Matched replies** (via `In-Reply-To` header) → auto-appear in
  the right conversation with high confidence.
- **Header-stripped replies** → fall back to recent-recipient
  matching (medium confidence).
- **Orphan replies** (cold inbound, no prior outbound) → still
  drop; future enhancement.

`messages.metadata.delivery_status = 'sent'` (outbound) and the
corresponding inbound reply now share the same conversation, so
operators see a true two-way thread.

---

## Phase 8BP update — full lifecycle wired

Phase 8BP turned the binary "Sent via Email" pill into a
proper lifecycle: **Sending… → Accepted by Email →
Delivered**, with `Email failed` / `Email bounced` /
`Marked as spam` / `Manual fallback` for failure modes.

Key honesty refinement: the pill no longer says **"Sent
via Email"**. It now says **"Accepted by Email"** when the
provider acknowledged the send, and only escalates to
**"Delivered"** when the Resend `email.delivered` webhook
fires.

Operators can also:
- **Retry** failed/bounced/skipped sends without creating
  a duplicate bubble (`POST /api/messages/[id]/retry-email`).
- **Mark handled manually** when they handled the reply
  outside VenueRise after a delivery issue
  (`POST /api/messages/[id]/mark-fallback`).

See `docs/EMAIL-DELIVERY-STATUS-AND-RETRY.md` for the full
spec, status dictionary, and webhook event mapping.

---

## Phase 8BV — operator can switch reply method per message

The composer now hosts a Radix DropdownMenu (when the
resolver returned `switchOptions.length > 1`). For leads
with both email and phone, the operator can pick SMS for
this one reply without leaving the composer.

For email specifically, behavior is unchanged when email
remains selected — the resolver's existing
`emailDirectDeliveryEnabled` flag drives `Direct` vs
`Internal`, the send route still calls `sendOutboundEmail()`,
and the delivery-status pill flow (Accepted → Delivered) is
preserved.

If the operator switches AWAY from email, this route is
simply not invoked for that message — the SMS path takes
over (see `docs/OUTBOUND-SMS-DELIVERY.md`).

The AI draft route now accepts an optional `reply_method`
hint. When email is selected (or the field is omitted),
draft shape is identical to pre-8BV.
