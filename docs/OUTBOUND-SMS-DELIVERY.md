# Outbound SMS Delivery

Phase 8BR — operator-composer direct SMS sending for leads with
phone numbers on file. Mirrors the 8BN email pipeline using
Twilio. Outbound-only this phase — inbound SMS, retry, status
callback, and orphan queue are explicitly deferred.

## What this phase does

A venue operator types a reply in the inbox composer, clicks
**Send**, and VenueRise sends that text via Twilio to the lead's
phone number while saving the message in the conversation thread
with accurate delivery metadata.

When `OUTBOUND_SMS_DELIVERY_ENABLED=1` AND Twilio is fully
configured, the Reply Method Bar flips phone-bearing
conversations from:

```
SMS · (555) 123-1234
Internal
Saved in VenueRise only. SMS sending is not connected.
```

to:

```
SMS · (555) 123-1234
Direct
Sends via SMS when you click send.
```

After send, the bubble shows a small **Accepted by SMS** pill
(or **SMS sent** when Twilio's immediate response says `sent`).

## What this phase does NOT do

- **No inbound SMS.** Lead text replies to the
  `OUTBOUND_SMS_FROM` number are NOT captured back into the
  conversation thread. Operators must monitor the Twilio
  console manually until 8BS ships.
- **No retry route.** SMS failures save the operator's text +
  flip the pill to "SMS failed", but there's no Retry button.
  Mark-handled-manually is available so an operator can
  declare "I texted them from my phone" — deferred from
  building a Twilio-specific retry pathway.
- **No status callback.** Twilio's `delivered` / `undelivered`
  events require a callback URL we'd need to host + sign-verify.
  Until that ships (separate phase), the pill stays on
  "Accepted by SMS" / "SMS sent" after a successful API response
  — we never claim "Delivered".
- **No SMS orphan queue.** The 8BQ pattern for inbound email
  doesn't apply yet because we don't capture inbound SMS at all.
- **No autonomous AI sending.** SMS sends only fire from an
  explicit operator click. The AI orchestrator never calls
  `sendOutboundSms`.
- **No SMS sending on Instagram / Facebook / The Knot /
  WeddingWire conversations** unless the lead has a phone AND
  the resolver picks SMS as the default. Today these channels
  stay on the manual pill — switching UI is deferred (8BT).
- **No per-venue Twilio numbers.** All sends use the
  platform-wide `OUTBOUND_SMS_FROM`. Per-venue numbers are a
  future enhancement.
- **No new admin route.** Reuses `/api/conversations/[id]/messages`.
- **No DB schema changes.** All state lives on `messages.metadata`.

## Provider

**Twilio.** We POST directly to Twilio's REST API:

```
POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
Authorization: Basic base64(SID:auth_token)
Content-Type: application/x-www-form-urlencoded
Body: To=+15551231234&From=+15557654321&Body=<message>
```

Rationale for direct HTTP vs the `twilio` npm package: saves
~250kB on the bundle for one API call, narrows the secret
handling surface, no server-startup-cost dep.

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `OUTBOUND_SMS_DELIVERY_ENABLED` | ✅ | `0` | Kill switch. `1`/`true` to enable. |
| `TWILIO_ACCOUNT_SID` | ✅ | — | From Twilio console. |
| `TWILIO_AUTH_TOKEN` | ✅ | — | From Twilio console. SERVER-ONLY. |
| `OUTBOUND_SMS_FROM` | ✅ | — | Verified Twilio phone number in E.164 (e.g. `+15551234567`). |
| `OUTBOUND_SMS_MAX_LENGTH` | optional | `1200` | Per-message body cap (160-1600 inclusive). |

Behavior matrix:

| Kill switch | Twilio config | Composer behavior |
|---|---|---|
| `0` / unset | any | `Internal` pill, "Saved in VenueRise only" |
| `1` | partial | `Internal` pill (resolver checks ALL three fields) |
| `1` | full | `Direct` pill, real SMS send on click |

## SMS helper behavior

`lib/integrations/delivery/sms.ts`

Exports:
- `isOutboundSmsConfigured(): boolean` — kill switch + all three env vars present
- `normalizePhoneForSms(input): string | null` — E.164 normalizer (US-default for bare 10-digit; explicit `+` for international)
- `sendOutboundSms(input): Promise<OutboundSmsResult>` — never throws

Result envelope:
```ts
{ ok: true, provider: 'twilio', providerMessageId, deliveryStatus: 'accepted'|'queued'|'sent', to }
| { ok: false, provider: 'twilio', deliveryStatus: 'failed'|'skipped', errorCode, safeError }
```

Error codes:
- `delivery_disabled` — kill switch off / missing config
- `invalid_phone` — recipient couldn't normalize
- `missing_body` — empty body
- `message_too_long` — exceeds `OUTBOUND_SMS_MAX_LENGTH`
- `missing_venue_id` — internal error (defensive)
- `missing_from` — `OUTBOUND_SMS_FROM` couldn't normalize
- `provider_rejected` — Twilio 4xx/5xx
- `provider_threw` — network / DNS / abort

Twilio API call has a 15-second timeout via `AbortSignal.timeout()`.

## Reply method resolver

`lib/integrations/channels/reply-method.ts` already accepts
`smsDirectDeliveryEnabled?: boolean` (added in 8BM). 8BR wires
the inbox thread page to pass the live value:

```ts
const smsDirectDeliveryEnabled = isOutboundSmsConfigured()
resolveReplyMethod({
  channelType,
  leadEmail,
  leadPhone,
  emailDirectDeliveryEnabled,
  smsDirectDeliveryEnabled,
})
```

| Lead has | Channel | SMS configured | Result |
|---|---|---|---|
| email | website | any | email = default (existing behavior) |
| phone only | website | OFF | sms = `internal_only` |
| phone only | website | ON | sms = **`direct`** ⭐ NEW |
| both | website | any | email default; sms appears in `switchOptions` |
| any | instagram/fb/knot/ww | any | manual (unchanged) |
| no phone, no email | meta_lead_ads | any | unavailable |

SMS direct is **not** silently used for manual-required
channels even if the lead has a phone — the resolver picks the
channel-native manual method per the existing priority order.
Operator-driven SMS-on-manual-channel waits for the switching
UI (8BT).

## Operator message route

`/api/conversations/[id]/messages` — extended with SMS path
parallel to the email path:

1. Read `clientMeta.reply_method` + `reply_delivery_mode`.
2. Branch into 4 cases:
   - `email + direct` → 8BN email pipeline (unchanged)
   - `sms + direct` (authorized) → set `delivery_status:'pending'`, `delivery_provider:'twilio'`, `delivery_channel:'sms'`; insert; send; patch
   - `sms + direct` (not authorized: kill switch off / config missing) → downgrade to `internal_only` + `delivery_status:'skipped'`; insert; no provider call
   - any other → existing internal/manual behavior
3. Re-verifies server-side via `isOutboundSmsConfigured()`. Never trusts client's `direct` claim alone.
4. Insert-then-send-then-patch ordering preserves operator text on provider failure.
5. Audit row (`operator_message_send`) records `delivery_channel`, `delivery_status`, `delivery_provider`, `delivery_error_code`, `provider_message_id_present`. Recipient phone deliberately NOT included on audit row (lives on `messages.metadata.reply_destination` which the audit-events helper sanitizes).
6. Response payload includes `delivery: { attempted, status, provider, error_code, safe_error }` so the composer can react immediately.

## DeliveryStatusPill behavior

`components/dashboard/messages/DeliveryStatusPill.tsx` —
multi-method aware:

- `reply_method === 'email'` → email status dictionary
  (`getEmailDeliveryDisplay` from `email-status.ts`)
- `reply_method === 'sms'` → SMS status dictionary
  (`getSmsDeliveryDisplay` from `sms-status.ts`)
- `reply_delivery_mode === 'manual'` (no status) → "Manual reply required"
- `reply_delivery_mode === 'unavailable'` → "No delivery path"
- No metadata → renders nothing

SMS-specific copy (per `sms-status.ts`):

| Status | Label | Tone |
|---|---|---|
| `pending` | Sending… | info |
| `queued` / `accepted` | Accepted by SMS | success |
| `sent` | SMS sent | success |
| `delivered` | Delivered | success (future — needs callback) |
| `undelivered` | SMS undelivered | danger (future — needs callback) |
| `failed` | SMS failed | danger |
| `skipped` | Saved in VenueRise | neutral |
| `manual_fallback` | Manual fallback | warning |

SMS icon: `MessageSquare` for success/pending states (vs `Mail`
for email). Failure / fallback / manual states share the same
icons across both channels (`AlertTriangle`, `Hand`, `Inbox`).

**Retry**: NOT shown for SMS in this phase (no retry route
exists). UI re-suppresses even when the status dictionary's
`canRetry` flag would otherwise say true.

**Mark handled manually**: shown for failed / undelivered /
skipped SMS so an operator can record "I texted them from my
phone" via the existing message-level `mark-fallback` route
(8BP).

## ReplyMethodBar behavior

Unchanged from 8BM. The bar's helper text comes from the
resolver's `helperText` field, which already reads:

- `emailDirectDeliveryEnabled=false` → "Saved in VenueRise only — email sending is not connected yet."
- `emailDirectDeliveryEnabled=true` → "Sends via email when you click send."
- `smsDirectDeliveryEnabled=false` → "SMS on file — direct sending is not connected."
- `smsDirectDeliveryEnabled=true` → "Sends via SMS when you click send."

8BR's only contribution at the bar level is flipping the flag
upstream — no UI code changes needed.

## Compliance / consent guardrails

- **VenueRise does NOT currently store `sms_opt_in` / `sms_consent`
  on leads.** Production SMS rollouts must respect TCPA (US)
  and equivalent consent regulations BEFORE enabling this.
- The operator's explicit Send click is the only authorization
  this phase enforces.
- Kill switch defaults to `0` specifically so a pilot operator
  must enable it deliberately AND own the compliance posture.
- No autonomous AI sending. No bulk send. No scheduled SMS.

## Audit / rate-limit

- Reuses the existing `operator_message_send` audit row
  (extended to include `delivery_channel`).
- Reuses the existing per-user-per-conversation rate limit on
  the operator message route.
- No new audit actions added.
- No new rate-limit bucket added.
- No new admin routes — `ADMIN_ENDPOINT_COUNT` unchanged.
- No new public routes — `check:fetch-routes` count unchanged.

## QA checklist

### Disabled (default)
1. `OUTBOUND_SMS_DELIVERY_ENABLED=0`, lead has phone.
2. Reply Method Bar shows `Internal` for SMS-default leads.
3. Sending does NOT call Twilio.
4. Message saves as `role:'human'`, pill shows "Saved in VenueRise".
5. Health route reports `outbound_sms_delivery: 'disabled'`.

### Enabled + valid Twilio
1. All 4 env vars set, lead has valid phone.
2. Resolver flips phone-only-default leads to `Direct`.
3. Send human reply → message saves on right.
4. `messages.metadata` includes `reply_method:'sms'`, `delivery_provider:'twilio'`, `delivery_status:'accepted'|'queued'|'sent'`, `provider_message_id`, `accepted_at`.
5. Pill shows "Accepted by SMS" or "SMS sent".
6. Lead receives the SMS at the recipient phone.
7. No AI orchestrator fires.
8. Health route reports `outbound_sms_delivery: 'mounted'`.

### Invalid phone
1. Lead with phone `"not-a-number"`.
2. Send attempt fails fast with `errorCode: 'invalid_phone'`.
3. Message still saves.
4. Pill shows "SMS failed".
5. No false delivery claim.
6. Mark-handled-manually button available.

### Email unaffected
1. Email lead Direct still works.
2. Email lifecycle (8BP) still flips accepted→delivered via webhook.
3. Email retry route still works.
4. Inbound email capture + orphan queue unchanged.

### Manual channels
1. Instagram / The Knot / WeddingWire conversations still show
   "Manual reply required" regardless of whether the lead has a
   phone.
2. SMS direct is not silently used for those.

### Missing env vars
1. Build passes with all SMS env vars missing (no crash on
   module load — env reads happen at call time).
2. Scanners pass.

## Honesty contract

> SMS delivery means VenueRise can send an operator-approved
> text message to the lead's phone number through the
> configured SMS provider. It does not mean VenueRise captures
> SMS replies yet.

> Accepted or sent by the SMS provider does not guarantee the
> recipient read the message. "Delivered" appears only when a
> status callback confirms it (out of scope for 8BR).

## File map

- **NEW** `lib/integrations/delivery/sms.ts` — Twilio direct-fetch wrapper
- **NEW** `lib/integrations/delivery/sms-status.ts` — canonical status dictionary
- `app/api/conversations/[id]/messages/route.ts` — SMS path + audit extension
- `app/(dashboard)/dashboard/inbox/[leadId]/page.tsx` — calls `isOutboundSmsConfigured()`
- `components/dashboard/messages/DeliveryStatusPill.tsx` — method-aware
- `app/api/health/route.ts` — 5 new flags
- `.env.example` — 4-5 new env vars documented

## Recommended next phase

- **8BS — Inbound SMS capture.** Mirror 8BO for Twilio's
  inbound webhook (`POST` to a route signed with the Twilio
  signature header). Match by `From` phone → recent outbound
  to that number → conversation. Land as `role:'lead'`.
- After 8BS: **8BT — SMS orphan queue** (mirror 8BQ).
- After 8BT: **8BU — SMS retry route + status callback** (mirror 8BP for the SMS lifecycle).

Then SMS will be operationally complete + symmetric with email.

---

## Phase 8BS update — inbound capture wired

8BS closes the loop opened here. A lead's text reply to
`OUTBOUND_SMS_FROM` is now received via a Twilio webhook,
matched to the source conversation (recent outbound SMS or
lead phone), and inserted as `role:'lead'`. The "no inbound
SMS capture" caveat above is (mostly) addressed — see
`docs/INBOUND-SMS-CAPTURE.md`.

Remaining inbound-side gaps:
- Unmatched / low-confidence replies still drop silently
  (8BT will mirror the 8BQ orphan queue).
- AI never auto-fires on captured SMS — operator must
  explicitly compose the response via this outbound pipeline.
