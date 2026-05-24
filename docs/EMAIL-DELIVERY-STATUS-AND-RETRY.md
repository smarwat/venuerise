# Email Delivery Status + Retry

Phase 8BP — operational polish on top of 8BN (outbound) and
8BO (inbound). Closes the gap between "the provider accepted
this email" and "the operator knows what to do next when it
goes wrong."

## What this phase does

- Defines a **canonical email delivery status model** that
  the webhook, UI, and retry route all read from. One
  dictionary, no parallel copy lists.
- Extends the existing Resend webhook to **patch the linked
  `messages.metadata`** when an event arrives — not just
  `outbound_messages.status`. Composer sends now show
  `accepted → delivered → bounced` lifecycle changes on the
  conversation bubble in real time.
- Adds a **retry route** that re-attempts delivery against
  the same recipient without creating a duplicate bubble.
- Adds a **manual fallback route** so operators can flip a
  failed send to `manual_fallback` after handling it outside
  VenueRise.
- Upgrades the `DeliveryStatusPill` to render the full
  lifecycle, surface inline Retry + "Mark handled manually"
  buttons, and escalate to "Status delayed" when a send has
  been pending too long.
- The UI never claims `Delivered` until a provider webhook
  actually confirms delivery.

## What this phase does NOT do

- **No SMS.**
- **No per-venue verified domains.**
- **No Gmail/Outlook OAuth.**
- **No autonomous AI sending.**
- **No full email operations dashboard** — this is bubble-
  level polish.
- **No DB schema changes.** All new state lives on
  `messages.metadata` (jsonb).
- **No admin route count bump.** Two new public routes
  (`/api/messages/[id]/retry-email`, `/api/messages/[id]/
  mark-fallback`) — `/api/admin/*` unchanged.

## Canonical status model

`lib/integrations/delivery/email-status.ts`

| Status | Meaning |
|---|---|
| `pending` | VenueRise saved the message and is awaiting a provider response. |
| `accepted` / `sent` | Provider acknowledged the send. **Does NOT mean delivered.** |
| `delivered` | Provider's delivery webhook confirmed it landed at the recipient mail server. |
| `bounced` | Recipient mail server rejected the message. |
| `complained` | Recipient marked it as spam. |
| `failed` | Provider rejected or transport failed. |
| `skipped` | Not attempted — kill switch off, suppression, or missing config. |
| `manual_fallback` | Operator handled this reply outside VenueRise after a delivery issue. |
| `unknown` | Legacy or unrecognized state — defaults to "Saved in VenueRise" copy. |

### Display dictionary

`getEmailDeliveryDisplay(status)` returns:

```ts
{ label, helper, tone, isTerminal, canRetry, canMarkManual }
```

| Status | Label | Tone | canRetry | canMarkManual |
|---|---|---|---|---|
| pending | Sending… | info | false | false |
| accepted/sent | Accepted by Email | success | false | false |
| delivered | Delivered | success | false | false |
| bounced | Email bounced | danger | true | true |
| complained | Marked as spam | danger | **false** | true |
| failed | Email failed | danger | true | true |
| skipped | Saved in VenueRise | neutral | true (when configured) | true |
| manual_fallback | Manual fallback | warning | false | false |

`canRetry` is the UI gate. The retry **route** additionally
enforces: `isOutboundEmailConfigured()`, recipient not
suppressed (suppression list is checked inside
`sendOutboundEmail`), max 5 retries per message.

### Honesty rule

> **"Accepted by the email provider"** means the provider
> accepted the message for delivery. It does NOT guarantee
> inbox placement. **"Delivered"** is shown ONLY when a
> provider delivery event confirms it.

The webhook patcher honors `shouldOverwriteStatus()` so a
late `email.sent` event can never downgrade a row already at
`delivered`. A `delivered → bounced` sequence is preserved
in its forensic timestamps (`delivered_at` + `bounced_at`
both set; `delivery_status` shows the latest terminal
state).

## Provider event mapping

`/api/resend/webhook` — Resend events map to canonical
statuses via `normalizeEmailDeliveryStatus`:

| Resend event | Canonical |
|---|---|
| `email.sent` | `accepted` |
| `email.delivered` | `delivered` |
| `email.bounced` | `bounced` |
| `email.complained` | `complained` |
| `email.failed` | `failed` |
| `email.delivery_delayed` | `pending` (still trying) |
| `email.opened` / `email.clicked` | (accepted but not tracked) |

## Webhook → messages.metadata patch

When the Resend webhook fires:

1. Look up the matched `outbound_messages` row.
2. If `related_table === 'messages'` AND `related_id` is set
   (composer-origin sends), read the linked `messages` row.
3. Compute the canonical next status via
   `normalizeEmailDeliveryStatus(event.type)`.
4. Decide whether to overwrite via `shouldOverwriteStatus()`:
   - Always allow forward progress (`pending → accepted →
     delivered`).
   - Never let `accepted` overwrite `delivered`.
   - Allow terminal failures to override earlier success
     (a `bounced` arriving after `sent` is real).
   - Never overwrite `manual_fallback` (operator took
     over).
5. Merge the patch onto existing `messages.metadata`:
   - `delivery_status: <next>`
   - `delivery_provider: 'resend'`
   - `delivery_event_type: <raw provider event name>`
   - `delivery_last_event_at: <iso>`
   - Per-status timestamp: `accepted_at` / `delivered_at` /
     `bounced_at` / `complained_at` / `failed_at`.
   - On bounce/complaint/failed: `delivery_error_code` +
     `delivery_safe_error` (short, sanitized).
   - On success: error fields cleared.
6. Realtime postgres_changes pushes the UPDATE into the
   inbox; `ConversationThread`'s new UPDATE subscriber
   refreshes the bubble.

Critically: digest / tour-notification / trial-reminder
sends keep their `outbound_messages.status` as the source
of truth — the patch branch is a no-op when
`related_table !== 'messages'`.

## Retry route

`POST /api/messages/[id]/retry-email`

Preconditions (all enforced server-side):

- Authenticated user with `SALES_ROLES` on the message's venue.
- Active subscription (billing gate).
- `message.role === 'human'`.
- `metadata.reply_method === 'email'`.
- `metadata.reply_destination` is present.
- `metadata.delivery_status ∈ { failed, bounced, skipped }`
  (via `isStatusRetryable`).
- `isOutboundEmailConfigured()` returns true.
- `metadata.delivery_retry_count < 5`.
- Per-user-per-message rate limit allows.

Behavior:

1. Stamp `delivery_status: 'pending'` + increment
   `delivery_retry_count` + `last_retry_at` + `last_retry_by`.
   Realtime pushes "Sending…" immediately.
2. Best-effort audit:
   `email_delivery_retry_attempted`.
3. Call `sendOutboundEmail` with the same body + recipient.
4. Patch metadata with the real result (`accepted` +
   `provider_message_id`, or `failed` + error code/string).
5. Audit:
   `email_delivery_retry_succeeded` or `..._failed`.
6. Return JSON `{ ok, status, message_id, retry_count, ... }`.

The retry **never** creates a new message row. The
existing bubble updates in place.

## Manual fallback route

`POST /api/messages/[id]/mark-fallback`

Preconditions:

- Same auth + ownership posture as retry.
- `message.role === 'human'`.
- `display.canMarkManual === true` (bounced / complained /
  failed / skipped).

Behavior:

1. Patch metadata:
   - `delivery_status: 'manual_fallback'`
   - `manual_reply_marked_at: <iso>`
   - `manual_reply_marked_by: <user.id>`
   - `manual_fallback_reason: 'email_delivery_issue'`
   - `manual_fallback_from_status: <prior status>`
   - Error fields cleared.
2. Audit: `email_delivery_manual_fallback_marked`.
3. Return `{ ok: true, status: 'manual_fallback' }`.

Pill flips to "Manual fallback" (warning tone). VenueRise
never claims it sent the email.

This is **distinct** from `/api/conversations/[id]/mark-sent-
manually` (which INSERTS a new message for manual-only
channels like Instagram). The two coexist.

## Stale pending escalation

`isStalePending(status, pendingSinceMs)` — true when
`status === 'pending'` and the pending timestamp is older
than `STALE_PENDING_AFTER_MS` (5 minutes).

Pill behavior:
- ≤ 5 min: "Sending…" (spinner)
- \> 5 min: "Status delayed" (operator can Retry)

No background job in this phase — the UI detects on render.

## DeliveryStatusPill behavior

`components/dashboard/messages/DeliveryStatusPill.tsx`

- Reads `messages.metadata` from `ConversationThread`.
- Resolves canonical status via `normalizeEmailDeliveryStatus`.
- Looks up display props via `getEmailDeliveryDisplay`.
- Renders label + tone-coordinated icon + tooltip with helper.
- Inline action buttons:
  - **Retry** — when `canRetry` is true AND email is the
    method AND `retry_count < 5` AND status ≠ `complained`.
  - **Mark handled manually** — when `canMarkManual` is true.
- Shows "retry N" hint when `delivery_retry_count > 0`.
- Inverts swatches when rendered against dark AI/human bubbles.
- Never displays provider message ids.
- `safeError` only surfaces in the tooltip — already
  sanitized server-side.

## Audit + rate-limit

Audit actions added:
- `email_delivery_retry_attempted`
- `email_delivery_retry_succeeded`
- `email_delivery_retry_failed`
- `email_delivery_manual_fallback_marked`

Safe fields only — message id, conversation id, venue id,
status before/after, retry count, provider name, error code,
`provider_message_id_present` (boolean). Never the full
recipient email, never the message body, never the raw
provider response, never API keys.

Rate-limit catalog:
- `messageDelivery.retryEmail: 'message:delivery:retry-email'`
- `messageDelivery.markFallback: 'message:delivery:mark-fallback'`

Both routes use `rateLimitUserAction` with the key
`<prefix>:<user_id>:<message_id>`. A runaway click on one
message can't deny retries on others.

## QA checklist

### Provider accepted
1. Send via composer → pill shows **Accepted by Email**.
2. Does NOT claim Delivered.

### Delivered webhook
1. Resend fires `email.delivered`.
2. `messages.metadata.delivery_status` updates to
   `delivered`.
3. Realtime UPDATE pushes the change.
4. Pill flips to **Delivered**.

### Bounced webhook
1. Resend fires `email.bounced` → status = `bounced`.
2. Pill shows **Email bounced**.
3. Retry button appears (UI), but if the bounced address
   was added to `email_suppressions` by the hard-bounce
   path, the retry route's downstream call to `sendEmail`
   will return `suppressed` — pill stays "Saved in
   VenueRise" with a soft tooltip.

### Complaint webhook
1. Resend fires `email.complained` → status = `complained`.
2. Pill shows **Marked as spam**.
3. Retry button does NOT appear (`canRetry: false` for
   complaints).
4. "Mark handled manually" still available.

### Failed send
1. Use invalid recipient or bad provider config.
2. Composer save → pill shows **Email failed**.
3. Click **Retry** → pill flips to "Sending…" → either
   "Accepted by Email" on success or "Email failed" again.
4. `delivery_retry_count` increments visible in pill hint.

### Skipped
1. `OUTBOUND_EMAIL_DELIVERY_ENABLED=0`, send.
2. Pill = **Saved in VenueRise**.
3. Retry shown only if config is now valid.

### Manual fallback
1. Failed email → click **Mark handled manually**.
2. Pill flips to **Manual fallback** (warning tone).
3. `metadata.manual_reply_marked_at` set.
4. No claim VenueRise sent the email.

### Duplicate prevention
1. Click Retry → existing bubble updates; no new bubble.

### Manual channels untouched
1. Instagram / The Knot / WeddingWire still show "Manual
   reply required" exactly as Phase 8BM left them.

### Inbound capture untouched
1. 8BO inbound reply still lands on the left as
   `role: 'lead'`.
2. Delivery pills only appear on `role: 'human'` bubbles.

## Known limitations

- **No retry queue UI.** A failed send is visible only by
  scrolling the conversation. A future inbox-level "stuck
  sends" surface could aggregate them.
- **No background stale-pending sweeper.** If the UI is
  never rendered, the pill never flips to "Status delayed."
  Visible only when an operator opens the conversation.
- **Bounced → Retry path may still skip** if the address
  was hard-bounce-suppressed by the existing webhook.
  Surfaced as `Saved in VenueRise` after retry. Operator
  can mark fallback.
- **No per-event drawer.** The full lifecycle
  (`accepted_at` / `delivered_at` / `bounced_at`) is on
  metadata but there's no UI to inspect it beyond the pill
  tooltip. Future audit drawer enhancement.
- **5 minute stale threshold** is hardcoded. Could be
  configurable per venue later.
- **Manual fallback route is message-level** and does NOT
  create a parallel `external_messages` row (unlike the
  conversation-level mark-sent-manually). The operator is
  declaring "I handled this outside VenueRise" on an
  existing send — the original message stays the record.

## File map

- `lib/integrations/delivery/email-status.ts` — canonical
  model + display dictionary + helpers (NEW).
- `app/api/resend/webhook/route.ts` — extended with
  `patchMessageMetadataFromWebhook` for composer sends.
- `app/api/messages/[id]/retry-email/route.ts` — retry
  route (NEW).
- `app/api/messages/[id]/mark-fallback/route.ts` — manual
  fallback route (NEW).
- `components/dashboard/messages/DeliveryStatusPill.tsx` —
  rewritten to read the canonical dictionary + render
  inline actions.
- `components/dashboard/ConversationThread.tsx` — UPDATE
  realtime subscription added; pill wired with messageId +
  pending-since timestamp + retry_count.
- `lib/enterprise/audit-actions.ts` — 4 new audit actions.
- `lib/rate-limit-catalog.ts` — `messageDelivery` bucket
  added.
- `app/api/health/route.ts` — 5 new flags.

## Recommended next phase

The natural follow-on per your roadmap is **8BQ —
Unmatched Inbound Email Queue**. Today's `/api/inbound/email`
route drops orphan replies (no header match + no recent
recipient match) with a `200 { captured: false }` and a
pino warning. That's safe but invisible to the operator.
A small admin queue surface (or an inbox-level "Possible
orphans" pill) would:

- Persist orphan replies into a dead-letter table.
- Surface them in admin with sender + subject + body
  preview so an operator can manually relink to a
  conversation.
- Stop replies from silently disappearing.

This protects against lost revenue when a venue's lead
forgets to include the original subject in their reply
(or when a webmail client strips the In-Reply-To header).

---

## Phase 8BQ update — orphan inbound surface

8BQ doesn't change delivery status semantics for outbound
sends, but closes a loop on the inbound side: if a lead replies
to a delivery you sent but the matcher can't tie their email
back (headers stripped, replied from a different address, etc.),
the reply now lands in the new unmatched email queue instead
of disappearing. See `docs/UNMATCHED-INBOUND-EMAIL-QUEUE.md`.
