# SMS Delivery Status + Retry

Phase 8BU — closes the last outbound-SMS gap from 8BR. Mirrors
the email lifecycle work from 8BP. Adds the Twilio status
callback so message bubbles can flip from "Accepted by SMS" →
"Sent" → "Delivered" (or "Undelivered" / "Failed") as Twilio
reports lifecycle events, plus an SMS retry route + retry UI
that re-attempts the same recipient without creating a
duplicate bubble.

## What this phase does

Before 8BU, an SMS bubble's status was a one-shot from Twilio's
immediate API response — usually "Accepted by SMS" or "SMS
sent", forever. Carrier-side outcomes (delivered, undelivered)
were invisible. Failed sends had a "Mark handled manually"
escape but no retry button.

After 8BU:
- Every outbound SMS (with `TWILIO_SMS_STATUS_CALLBACK_ENABLED=1`)
  includes a Twilio `StatusCallback` URL. Twilio POSTs lifecycle
  updates to `/api/twilio/sms/status`, which patches the bubble.
- The pill renders the canonical lifecycle: **Sending… →
  Accepted by SMS → SMS sent → Delivered**, with **SMS
  undelivered** / **SMS failed** for terminal failures.
- Failed / undelivered / skipped SMS bubbles expose a **Retry**
  button (no duplicate row) plus the existing **Mark handled
  manually**.

## What this phase does NOT do

- **No inbound SMS changes.**
- **No SMS orphan queue changes.**
- **No MMS attachments.**
- **No per-venue Twilio numbers.**
- **No reply-method switching UI.**
- **No autonomous AI sending.**
- **Never claims SMS was delivered unless Twilio confirms it.**

## Provider / Webhook

**Twilio.** Status callback POSTs to
`<NEXT_PUBLIC_APP_URL>/api/twilio/sms/status` when configured.
Signed with the existing `TWILIO_AUTH_TOKEN` using the same
HMAC-SHA1 + sorted-form-params algorithm as inbound SMS (8BS).
The route reuses `verifyTwilioSmsSignature()` from
`lib/integrations/inbound/sms.ts` — one verifier across both
Twilio webhooks.

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `TWILIO_SMS_STATUS_CALLBACK_ENABLED` | optional | `0` | Set `1`/`true` to enable. When off, outbound sends omit the StatusCallback param. |
| `NEXT_PUBLIC_APP_URL` | ✅ when callback enabled | — | Public base URL (https in production). Used to build the StatusCallback param. |
| `TWILIO_AUTH_TOKEN` | ✅ when callback enabled | — | Reused from 8BR. Verifies the incoming callback signature. |

When `TWILIO_SMS_STATUS_CALLBACK_ENABLED=0` or `NEXT_PUBLIC_APP_URL` is missing:
- Outbound sends omit the `StatusCallback` form field.
- The callback route returns `200` + empty body on any inbound POST so Twilio doesn't burn its retry budget.
- Bubble status stays at the immediate Twilio response ("Accepted by SMS" / "SMS sent") forever — exactly the 8BR behavior.

## Twilio status callback behavior

`POST /api/twilio/sms/status`

1. **Kill switch** off → 200 + empty body.
2. **IP rate-limit** via `rateLimitWidget` (shared anonymous webhook bucket).
3. **Read raw form body** (Twilio signs the form-encoded body).
4. **Signature verify** before any DB lookup. Invalid → **401** (Twilio retries — we want it to). Dev-only bypass via `INBOUND_SMS_DEV_BYPASS_TOKEN` + `x-inbound-sms-dev-bypass` header; tightly scoped (NODE_ENV !== 'production' AND token match).
5. **Look up** `messages` row by `metadata.provider_message_id = MessageSid` AND `metadata.reply_method = 'sms'` AND `metadata.delivery_provider = 'twilio'`. The extra filters are defense in depth — a spoofed payload can't accidentally patch an email row.
6. **Normalize** Twilio's raw `MessageStatus` / `SmsStatus` via `normalizeTwilioRawStatus()`.
7. **Decide overwrite** via `shouldOverwriteSmsStatus()` (see below).
8. **Patch** `messages.metadata` (in place; no new row, no duplicate bubble).
9. Return **200** + empty body.

## Status normalization / overwrite behavior

`lib/integrations/delivery/sms-status.ts`

Canonical statuses (added `sending` in this phase):
```ts
type SmsDeliveryStatus =
  | 'pending' | 'queued' | 'accepted' | 'sending'
  | 'sent' | 'delivered' | 'undelivered' | 'failed'
  | 'skipped' | 'manual_fallback' | 'unknown'
```

Twilio raw → canonical:

| Twilio | Canonical |
|---|---|
| `queued` | `queued` |
| `accepted` | `accepted` |
| `sending` | `sending` |
| `sent` | `sent` |
| `delivered` | `delivered` |
| `undelivered` | `undelivered` |
| `failed` | `failed` |
| `receiving` / `received` | `unknown` (inbound; ignored on this route) |

Display copy (from `getSmsDeliveryDisplay`):

| Status | Label | Tone | canRetry | canMarkManual |
|---|---|---|---|---|
| pending | Sending… | info | false | false |
| queued/accepted | Accepted by SMS | success | false | false |
| sending | Sending SMS | info | false | false |
| sent | SMS sent | success | false | false |
| delivered | Delivered | success | false | false |
| undelivered | SMS undelivered | danger | **true** | true |
| failed | SMS failed | danger | **true** | true |
| skipped | Saved in VenueRise | neutral | **true** (when configured) | true |
| manual_fallback | Manual fallback | warning | false | false |

`shouldOverwriteSmsStatus(current, next)` rules:
- Same status → no-op.
- Never overwrite `manual_fallback` (operator took over).
- `unknown` never overwrites a concrete state.
- `delivered` can't be downgraded to `sent` / `sending` / `queued` / `accepted`.
- `delivered → undelivered/failed` IS allowed (rare carrier rescissions).
- `sent` can't be downgraded to pre-sent.
- Terminal failure (`failed` / `undelivered`) can't be downgraded to pre-sent.

Late events that don't flip the visible status still stamp `delivery_last_event_at` + per-status timestamps so an audit drawer can reconstruct the lifecycle.

## Metadata patch behavior

Patch shape (merged onto existing metadata):

```json
{
  "delivery_status": "delivered",
  "delivery_provider": "twilio",
  "delivery_channel": "sms",
  "delivery_provider_status": "delivered",
  "delivery_event_type": "twilio.sms.status",
  "delivery_last_event_at": "2026-05-24T18:14:22.000Z",
  "queued_at": "...",
  "sent_at": "...",
  "delivered_at": "...",
  "undelivered_at": "...",
  "failed_at": "...",
  "delivery_error_code": "twilio_30003",
  "delivery_safe_error": "Unknown destination handset"
}
```

Preserved across patches (never overwritten): `reply_method`, `reply_destination`, `delivery_retry_count`, `manual_fallback_*`, inbound/orphan fields.

Cleared on successful transitions: `delivery_error_code` / `delivery_safe_error`.

Set on failure transitions: `delivery_error_code` = `twilio_<ErrorCode>` or fallback, `delivery_safe_error` = sanitized Twilio message.

The patch never:
- Stores the raw Twilio payload.
- Stores the full recipient phone (already on `reply_destination`).
- Stores the Twilio auth token.
- Patches non-SMS messages (the SELECT filters on reply_method + delivery_provider).
- Patches lead-side inbound SMS (those don't have `provider_message_id` matching outbound SIDs).

## SMS retry route

`POST /api/messages/[id]/retry-sms`

Preconditions (all server-enforced):
1. Authenticated user with `SALES_ROLES` on the message's venue.
2. Active subscription (billing gate).
3. `message.role === 'human'`.
4. `metadata.reply_method === 'sms'`.
5. `metadata.reply_destination` present.
6. `currentStatus ∈ { failed, undelivered, skipped }` via `isSmsStatusRetryable`.
7. `isOutboundSmsConfigured()` true.
8. `delivery_retry_count < 5`.
9. Per-user-per-message rate limit allows.

Flow:
1. Stamp `delivery_status: 'pending'` + increment `delivery_retry_count` + `last_retry_at` + `last_retry_by`. UI shows "Sending…" immediately via realtime.
2. Archive the previous `provider_message_id` to `previous_provider_message_ids[]` (capped at 5 entries) so an audit drawer can show every attempt's SID.
3. Best-effort audit: `sms_delivery_retry_attempted`.
4. Call `sendOutboundSms` with the same body + recipient.
5. Patch metadata with the real result:
   - **Success**: new `provider_message_id`, `accepted_at` (+ `sent_at` if Twilio returned `sent`), cleared error fields.
   - **Failure**: `delivery_status: 'failed'|'skipped'`, `delivery_error_code`, `delivery_safe_error`, `failed_at` if failed.
6. Audit: `sms_delivery_retry_succeeded` or `..._failed` with safe metadata only.
7. Return `{ ok, status, message_id, retry_count, ... }`.

**Never creates a new message row.** The same bubble updates in place. **Never triggers AI.**

## DeliveryStatusPill behavior

Updated for SMS:
- `getSmsDeliveryDisplay` now returns `canRetry: true` for `failed` / `undelivered` / `skipped` (was hard-disabled in 8BR).
- Pill's `showRetry` allows SMS in addition to email (`isEmail || isSms`).
- `onRetry` routes to `/api/messages/[id]/retry-sms` when `replyMethod === 'sms'`, otherwise `/retry-email`.
- New `sending` status maps to a "Sending SMS" info-tone label.
- Stale pending escalation (5-minute threshold) still works via the channel-agnostic `isStalePending` helper.

**Retry hidden** for: `delivered`, `sent` (unless stale), `complained` (doesn't apply to SMS), `manual_fallback`.

**Mark handled manually** preserved for all terminal failure states (existing 8BP `/api/messages/[id]/mark-fallback` route handles both channels — no changes needed).

## Manual fallback behavior

Unchanged. The 8BP message-level `mark-fallback` route already works for any `role:'human'` message regardless of channel. SMS rows flip to `delivery_status: 'manual_fallback'` with the same warning-tone "Manual fallback" pill.

## AI / no-auto-send behavior

Five guarantees (documented via `sms_delivery_no_ai_autosend_guard: 'mounted'`):
1. Outbound SMS sends only from the operator-composer route.
2. The Twilio status callback only patches metadata; no AI helper called.
3. The retry route only re-sends + patches metadata; no AI.
4. The retry UI dispatches a single fetch; no AI orchestrator hop.
5. Inbound SMS (8BS) + orphan capture (8BT) remain no-AI.

## Audit / rate-limit

**Audit actions added** (in `lib/enterprise/audit-actions.ts`):
- `sms_delivery_retry_attempted`
- `sms_delivery_retry_succeeded`
- `sms_delivery_retry_failed`
- `sms_delivery_status_callback_received` (for future operator-side surface)
- `sms_delivery_status_callback_ignored` (for future operator-side surface)

The callback route itself is **AUDIT_EXEMPT** per the webhook convention; the message metadata patch + pino logs are the forensic trail.

Safe metadata only — never includes SMS body, full phone (when project policy avoids PII), raw Twilio payload, or auth token.

**Rate-limit catalog entries**:
- `messageDelivery.retrySms` — per-user-per-message bucket for the retry route
- `inboundChannel.smsStatusCallback` — documents the bucket for the callback route (uses widget IP limiter, 10/min)

**Scanner deltas**:
- `check:audit-coverage` 84 → **86** (+2: callback exempt, retry covered)
- `check:rate-limit-coverage` 118 → **120** (+2)
- `check:fetch-routes` 131 → **133** (+2: callback + retry)
- `ADMIN_ENDPOINT_COUNT` unchanged

## QA checklist

### Callback disabled
1. `TWILIO_SMS_STATUS_CALLBACK_ENABLED=0`. POST a valid callback.
2. Route returns 200 + empty body.
3. No metadata patch.
4. Health flag `disabled`.

### Invalid signature
1. Enable callback. POST with wrong `X-Twilio-Signature`.
2. Route returns 401.
3. No metadata patch.

### Queued → sent → delivered lifecycle
1. Send outbound SMS via composer.
2. Simulate Twilio callback with `MessageStatus=queued`.
3. Pill: **Accepted by SMS** (queued).
4. Simulate `sent`.
5. Pill: **SMS sent**.
6. Simulate `delivered`.
7. Pill: **Delivered**.
8. Late `sent` callback after `delivered` → status stays `delivered`. Pino log: `sms.status.skipped_overwrite`.

### Failed / undelivered + retry
1. Simulate `undelivered` callback.
2. Pill: **SMS undelivered**. Retry button visible. Mark handled manually visible.
3. Click Retry → POST `/api/messages/[id]/retry-sms`.
4. Pill flips to **Sending…** → either **Accepted by SMS** on success or **SMS failed** again.
5. `delivery_retry_count` increments. Same bubble updates; no duplicate.
6. `metadata.previous_provider_message_ids` includes the failed SID.

### Retry disabled config
1. Disable `OUTBOUND_SMS_DELIVERY_ENABLED`.
2. Click Retry → 409 `sms_not_configured`.
3. Pill error: "SMS sending is not connected for this workspace."

### Retry cap
1. Force `delivery_retry_count` to 5.
2. Retry button hides (UI) OR route returns 429 `retry_limit_exceeded`.

### Email unaffected
1. Email retry + delivery callback + orphan queue all still work.

### Inbound SMS unaffected
1. Inbound SMS capture + orphan queue + ChannelSourceBadge all still work.

### Build / scanners
1. Build passes with all SMS env vars missing.
2. All 5 scanners clean.

## Honesty contract

> **Accepted by SMS** means Twilio accepted the message for delivery.
> **SMS sent** means Twilio handed it to the carrier.
> **Delivered** means Twilio received carrier confirmation that the
> handset received it.
> None of these guarantee that the lead read it.

The pill never claims "Delivered" without a Twilio
`MessageStatus=delivered` callback. When the callback is
disabled, the pill caps at "SMS sent" (Twilio's immediate
response).

## Known limitations

- **Callback requires `NEXT_PUBLIC_APP_URL`** to be set + reachable from Twilio. Local dev with `localhost` needs a tunnel (ngrok / Cloudflare Tunnel) or the dev bypass token.
- **No bulk retry** — operator must click per failed message.
- **No carrier-side delivery confirmation for short-codes** — Twilio reports `delivered` based on carrier response which varies by region/operator.
- **5-retry cap** is hardcoded.
- **Stale-pending threshold** (5 min) shared with email; not separately tunable.
- **No status callback URL signing/secret rotation** — relies on `TWILIO_AUTH_TOKEN`.
- **MMS attachments** still not captured.
- **No retry button for `sent`** by default. Stale-pending escalation kicks in after 5 minutes if a `sent` never escalates to `delivered` — but most operators won't notice. Acceptable for now.

## File map

- `lib/integrations/delivery/sms-status.ts` — added `sending`, `isSmsStatusRetryable`, `shouldOverwriteSmsStatus`, `normalizeTwilioRawStatus`; `canRetry: true` for failed/undelivered/skipped
- `lib/integrations/delivery/sms.ts` — `statusCallbackUrl()` helper; `StatusCallback` param on Twilio POST when enabled
- **NEW** `app/api/twilio/sms/status/route.ts` — Twilio status callback handler
- **NEW** `app/api/messages/[id]/retry-sms/route.ts` — operator retry route
- `components/dashboard/messages/DeliveryStatusPill.tsx` — SMS retry button + endpoint dispatch
- `lib/enterprise/audit-actions.ts` — 5 new constants
- `lib/rate-limit-catalog.ts` — `messageDelivery.retrySms` + `inboundChannel.smsStatusCallback`
- `app/api/health/route.ts` — 7 new flags
- `.env.example` — `TWILIO_SMS_STATUS_CALLBACK_ENABLED` documented

## Recommended next phase

SMS is now operationally complete + symmetric with email:
- Outbound (8BR)
- Inbound (8BS)
- Orphan queue (8BT)
- Lifecycle + retry (8BU) ✅

Two natural follow-ons:

**Phase 8BV — Reply method switching UI.** The resolver has returned `switchOptions[]` since 8BM. Add a dropdown on `ReplyMethodBar` so operators can pick Email vs SMS for leads with both contact methods. Pure UI, no new routes, high operator value now that both channels are real.

**Phase 8BW — Per-venue Twilio numbers.** Replace the platform-wide `OUTBOUND_SMS_FROM` with per-venue verified numbers (mirrors the per-venue domain phase deferred from email). Needed for venues that want branded short-codes or dedicated long-codes for compliance/throughput.

Pick by pilot need. 8BV is small + universal; 8BW unlocks high-volume venues but is heavier.
