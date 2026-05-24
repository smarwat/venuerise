# Inbound SMS Capture

Phase 8BS — closes the loop on 8BR. When a lead replies to the
configured `OUTBOUND_SMS_FROM` Twilio number, the reply is
received, matched to the correct conversation, and inserted as
`role:'lead'` on the left of the inbox thread.

## What this phase does

```
Lead ──text──> Twilio number ──webhook──> /api/inbound/sms
                                                    │
                                                    ▼
                                  verify Twilio HMAC-SHA1 signature
                                                    │
                                                    ▼
                                  normalize From/To/Body/MessageSid
                                                    │
                                                    ▼
                                  dedupe by MessageSid
                                                    │
                                                    ▼
                                  match conversation:
                                    1. recent outbound SMS to phone (HIGH)
                                    2. lead phone + single conversation (MEDIUM)
                                    3. else → ignore (orphan queue is 8BT)
                                                    │
                                                    ▼
                                  insert messages row as role:'lead'
                                  with channel_type='sms'
                                                    │
                                                    ▼
                                  ConversationThread realtime
                                  renders left-side bubble
```

## What this phase does NOT do

- **No SMS retry** (deferred).
- **No Twilio status callback** (deferred — outbound delivery
  status callback was already a known limitation in 8BR).
- **No SMS orphan queue.** Unmatched / low-confidence inbound
  is dropped silently. **Phase 8BT** will mirror 8BQ for SMS.
- **No MMS.** Attachments are not captured. If a payload
  arrives with both a body AND `NumMedia > 0`, we capture
  the text portion and flag `had_attachments` in metadata.
  Pure-MMS payloads (no body) get rejected at normalize.
- **No per-venue Twilio numbers.** All inbound for all venues
  arrives at the platform `OUTBOUND_SMS_FROM`. Matching by
  lead phone determines tenant routing.
- **No autonomous AI response.** Captured rows never trigger
  the AI orchestrator. Operator must manually review +
  respond.
- **No new lead creation.** If the inbound `From` doesn't
  match any existing lead, the message is dropped (orphan
  queue in 8BT). VenueRise does not invent leads from cold
  inbound SMS.
- **No DB schema changes.** All state lives on
  `messages.metadata`.

## Architecture

Three pieces — all new, all mirror the 8BO email pattern.

### `lib/integrations/inbound/sms.ts`
Pure helpers + the processInbound* function:
- `isInboundSmsEnabled()` — kill switch + `TWILIO_AUTH_TOKEN` present
- `normalizeInboundSmsPayload(input)` — accepts URLSearchParams or JSON; returns typed payload OR `{ error: 'invalid_from'|'invalid_to'|'empty_body' }`. Phone normalization runs through `normalizePhoneForSms()` from the outbound side so storage shapes match.
- `verifyTwilioSmsSignature({ url, params, signature, authToken })` — HMAC-SHA1 over `url + sorted_concat(key+value)`. Timing-safe comparison.
- `matchInboundSmsToConversation(payload)` — 90-day outbound-SMS lookup → lead-phone match → none.
- `processInboundSmsReply(payload)` — dedupe + match + insert.
- `bodyDedupeHash(payload)` — sha256 of `from|to|body` (exported for future fallback dedupe; not used this phase).

### `app/api/inbound/sms/route.ts`
The Twilio webhook. Reads `application/x-www-form-urlencoded` raw body, verifies signature, processes via the helper, returns TwiML.

### Health flags
5 new flags on `/api/health` (see "Health flags" section below).

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `INBOUND_SMS_ENABLED` | ✅ | `0` | Kill switch. `1`/`true` enables. |
| `TWILIO_AUTH_TOKEN` | ✅ | — | Reused from 8BR outbound config (Twilio uses one token per account for both directions). |
| `INBOUND_SMS_DEV_BYPASS_TOKEN` | optional | — | Dev-only signature bypass for local testing. IGNORED in production. |

When `INBOUND_SMS_ENABLED=0` the route returns `200` + empty TwiML so Twilio doesn't burn its retry budget. Operators notice the issue because Twilio's console shows messages delivered to the number but the VenueRise inbox stays quiet.

## Twilio signature verification

Twilio computes:
```
sign_string = full_public_URL + sorted_concat(key + value)
signature   = base64( HMAC-SHA1(sign_string, auth_token) )
```

Sorting is alphabetical by parameter name. Values are appended directly with no separator. Sent as `X-Twilio-Signature` header.

**Verification posture**:
- Public URL reconstructed from `x-forwarded-proto` + `x-forwarded-host` headers (Vercel/Cloudflare rewrite `request.url` to the internal host).
- Falls back to `NEXT_PUBLIC_APP_URL` then `request.url`.
- Timing-safe compare via `node:crypto.timingSafeEqual`.
- 401 on invalid signature, 200 + empty TwiML on disabled.

**Dev-only bypass**: when `NODE_ENV !== 'production'` AND `INBOUND_SMS_DEV_BYPASS_TOKEN` is set AND the request includes `x-inbound-sms-dev-bypass` header matching the token, signature failures are tolerated. Bypass cannot fire in production even if the token is accidentally set there.

## Matching strategy

Three tiers, tried in priority order:

| Tier | Match | Confidence | Behavior |
|---|---|---|---|
| **1** | `messages` where `role='human'` AND `metadata.reply_method='sms'` AND `metadata.reply_destination = fromPhone` within last 90 days | **high** | Insert immediately |
| **2** | Single `leads.phone` match → single conversation for that lead | **medium** | Insert immediately |
| **3** | Multiple conversations for the matching lead | **low** (`needsReview=true`) | Ignore this phase (8BT orphan queue) |
| **4** | No outbound, no lead phone match | **none** | Ignore this phase (8BT) |

Phone matching tries several stored shapes since `lead.phone` is operator-entered free text:
- `+15551231234`
- `15551231234`
- `5551231234`
- `+5551231234`

Future enhancement: regex-style normalization on the lead side at write time so a single index lookup matches.

## Insertion metadata

```json
{
  "source": "inbound_sms",
  "channel_type": "sms",
  "provider": "twilio",
  "provider_message_id": "SMxxxxxxxxxxxxxxxx",
  "inbound_from_phone": "+15551231234",
  "inbound_to_phone": "+15557654321",
  "match_method": "recent_outbound_sms_to_phone",
  "match_confidence": "high",
  "match_reasons": ["matched_recent_outbound_sms_within_90d"],
  "parse_needs_review": false,
  "parsed_at": "2026-05-24T18:14:22.000Z",
  "had_attachments": false,
  "attachments_ignored_count": 0
}
```

`had_attachments` + `attachments_ignored_count` only set when `NumMedia > 0`.

## Duplicate protection

Twilio retries webhooks on non-2xx responses. We dedupe by `MessageSid` (Twilio's unique-per-account id):

```sql
SELECT id, conversation_id
FROM messages
WHERE metadata->>'source' = 'inbound_sms'
  AND metadata->>'provider_message_id' = $MessageSid
LIMIT 1;
```

Hit → return `{ ok: true, ignored: true, reason: 'duplicate' }`. No insert, no AI fire, no conversation touch.

Fallback: `bodyDedupeHash()` (sha256 of `from|to|body`) is exported for future use if a provider omits MessageSid. Twilio always includes it, so unused this phase.

## Webhook response

Twilio expects TwiML or 200. We return:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response></Response>
```

with `Content-Type: application/xml; charset=utf-8`. The empty `<Response>` tells Twilio "no auto-reply to send" — we explicitly never send an auto-reply because:
- That would be autonomous AI sending (forbidden).
- It would also count against Twilio's per-message billing.

Status code matrix:
- Disabled → **200** + empty TwiML (don't waste Twilio retry budget)
- Invalid signature → **401** (Twilio will retry — we want it to)
- Unparseable payload → **200** + empty TwiML (provider shouldn't retry malformed)
- Rate-limited → **429**
- Platform-side throw → **200** + empty TwiML (Sentry'd internally; don't pile up Twilio retries on our bug)

## UI behavior

Inbound SMS messages render through the existing `ConversationThread` left-side bubble path. `ChannelSourceBadge` already supports `channel_type='sms'` (added in Phase 8BE). No UI changes were needed for this phase — the bubble shows the SMS badge naturally.

## AI / no-auto-trigger behavior

**Strict rule** — captured inbound SMS NEVER triggers AI:

- The webhook does NOT call `handleIncomingMessage`.
- No `ai_actions` row is created.
- Health flag `inbound_sms_no_ai_guard: 'mounted'` documents the contract.

Rationale: SMS is intimate + high-risk + asymmetric. A surprise AI auto-response erodes the operator's trust + can violate carrier guidelines. Operators must explicitly compose any reply via the existing 8BR outbound pipeline.

## Audit / rate-limit

**Audit**: route is `AUDIT_EXEMPT` per the Phase 9A "don't touch webhooks" rule, matching `/api/inbound/email` and `/api/resend/webhook`. The `messages` row insertion + pino logs constitute the forensic trail. Four audit action constants exist in `lib/enterprise/audit-actions.ts` (`INBOUND_SMS_RECEIVED`, `INBOUND_SMS_MATCHED`, `INBOUND_SMS_IGNORED`, `INBOUND_SMS_DUPLICATE`) for future operator-side surfaces (e.g. an inbox-side relink action when 8BT orphan queue ships).

**Rate-limit**: `rateLimitWidget()` (IP bucket — 10/min). Shared with other anonymous public webhooks. Twilio's legitimate egress stream sits well under it. New catalog entry `inboundChannel.inboundSmsReply` documents the prefix.

**Safe metadata only** — when audit rows are eventually written, they will NEVER include: full SMS body, raw Twilio payload, full phone (depending on project PII policy), auth token.

## QA checklist

### Disabled
1. `INBOUND_SMS_ENABLED=0`. POST a Twilio-shaped form payload.
2. Route returns **200** + empty TwiML.
3. No row inserted in `messages`.
4. Pino log: `inbound.sms.disabled_ignored`.
5. Health: `inbound_sms_capture: 'disabled'`.

### Invalid signature
1. `INBOUND_SMS_ENABLED=1` + `TWILIO_AUTH_TOKEN` set.
2. POST with bad `X-Twilio-Signature`.
3. Route returns **401**.
4. No row inserted.

### High-confidence match
1. Send an outbound SMS to a lead via 8BR composer.
2. Simulate Twilio inbound from that same phone to your `OUTBOUND_SMS_FROM`.
3. New `messages` row appears in that conversation with `role='lead'`.
4. `messages.metadata.source === 'inbound_sms'`, `match_confidence === 'high'`.
5. ConversationThread renders the bubble on the LEFT with the SMS channel badge.
6. No `ai_actions` row created.
7. `conversations.last_message_at` touched.

### Duplicate (Twilio retry)
1. POST the same payload (same `MessageSid`) twice.
2. Only one `messages` row.
3. Second response is `200` + empty TwiML.
4. Pino log: `inbound.sms.ignored` with reason `duplicate`.

### No match
1. Inbound SMS from a phone that hasn't received outbound AND doesn't match any `leads.phone`.
2. No row inserted. Response `200` + empty TwiML.
3. Pino log: `inbound.sms.no_match`. Will become an orphan once 8BT ships.

### MMS
1. Payload includes `NumMedia=2` AND a non-empty `Body`.
2. Body captured. `metadata.had_attachments=true`, `attachments_ignored_count=2`.
3. Attachments themselves are NOT downloaded or stored.

### Email unaffected
1. Inbound email (8BO) + outbound (8BN) + lifecycle (8BP) + orphan queue (8BQ) all still work.

### Build / scanner
1. Build passes with `INBOUND_SMS_ENABLED` and/or `TWILIO_AUTH_TOKEN` missing.
2. All 5 scanners clean.

## Known limitations

- **No orphan queue.** Unmatched inbound is dropped silently. 8BT will mirror 8BQ for SMS.
- **No new-lead creation from cold inbound.** Cold inbound from a phone we don't recognize is dropped.
- **Phone matching is heuristic.** `lead.phone` is free-text so we try multiple shapes. Future enhancement: normalize at write time.
- **Single-conversation lead assumption** for medium confidence. Leads with multiple active conversations get flagged `needsReview` and skipped (8BT).
- **No status callback** for outbound. "Delivered" / "Undelivered" lifecycle for the outbound side still requires the Twilio status callback URL (deferred).
- **No MMS attachment capture.** Body-only.
- **Single platform-wide Twilio number.** Per-venue numbers are deferred.
- **Local testing requires the dev bypass token** (signature can't be reproduced against `localhost`). Production never uses the bypass.
- **No realtime push** to the inbox card — operators see the new bubble when the existing `ConversationThread` realtime subscription delivers the INSERT.

## File map

- `lib/integrations/inbound/sms.ts` — NEW
- `app/api/inbound/sms/route.ts` — NEW (webhook)
- `lib/enterprise/audit-actions.ts` — 4 new constants
- `lib/rate-limit-catalog.ts` — `inboundChannel.inboundSmsReply` entry
- `app/api/health/route.ts` — 5 new flags
- `.env.example` — `INBOUND_SMS_ENABLED` + dev bypass documented

## Recommended next phase

**8BT — SMS Orphan Queue.** Mirror 8BQ for the SMS side:

- New table `inbound_sms_orphans` (or extend `inbound_email_orphans` with a `channel` column — judgment call). Stores unmatched / low-confidence inbound SMS with safe fields (`from_phone`, `to_phone`, `body_preview`, `match_method`, `match_confidence`, `match_reasons`, `provider_message_id`).
- Webhook switches from "ignore" to "persist orphan" when no/low match.
- Inbox queue card extended (or new SMS-specific surface) so operators can manually link/dismiss.
- Strict no-AI guard preserved through link action.

After 8BT, SMS will be a complete two-way channel with a safety net for unmatched replies — matching the email surface end-to-end.
