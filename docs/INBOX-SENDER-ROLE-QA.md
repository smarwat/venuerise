# Inbox Sender Role + Operator Direction QA

## Root cause

The MessageComposer POSTed to `/api/ai/chat` regardless of mode.
That route is the **inbound-lead path** — it runs
`handleIncomingMessage(conversationId, text)`, which inserts the
text into `messages` as `role: 'lead'` AND triggers the AI to
generate a reply as if the lead had spoken.

So every operator-typed message:
1. Was saved as `role: 'lead'` → rendered on the LEFT
2. Triggered an AI auto-response

Both wrong. The product model has three sender identities; the
composer was collapsing the venue side into the lead side.

## Canonical message roles

The `messages.role` enum has been stable since migration 001.
The fix is purely on the writers + UI, no schema change.

| Role | Source | Direction | Triggers AI? |
|---|---|---|---|
| `lead` | Inbound from couple (widget, channel webhook, /api/ai/chat) | Left bubble (white card) | Yes — orchestrator drafts a reply |
| `human` | Venue operator/team reply (composer 'you' mode, drawer "Approve & send") | Right bubble (navy) | No |
| `ai` | AI-generated venue-side message (approved draft, instant reply) | Right bubble (navy, optional AI badge) | No |
| `system` | System notes (tour confirmed by link, etc) | Centered slate chip | No |

## Composer behavior — before / after

### Before

| Mode | POST target | Inserted role | AI fires? |
|---|---|---|---|
| You | `/api/ai/chat` | `lead` (bug) | Yes (bug) |
| AI | `/api/ai/chat` (visual toggle only) | `lead` (bug) | Yes (bug) |

### After

| Mode | POST target | Inserted role | AI fires? |
|---|---|---|---|
| You | `/api/conversations/[id]/messages` with `sender_type: 'operator'` | `human` | No |
| AI | `/api/ai/draft` (regenerate path) with operator text as `current_draft` | None — returns draft variants for review | No (draft only, never auto-sent) |

AI mode now surfaces a draft inline with **Use this draft** / **Dismiss** controls. Clicking Use loads the draft into the textarea + flips mode to `you`, so the operator sends it manually as a `human` message.

## ConversationThread rendering — before / after

No render code change needed. The existing alignment logic in `ConversationThread.tsx`:

```tsx
const isLead = msg.role === 'lead'
const isAI = msg.role === 'ai' || msg.role === 'human'
const isSystem = msg.role === 'system'
```

…was already correct. `human` and `ai` both render right-aligned with the navy bubble. The bug was purely on the send side — once messages are written with `role: 'human'`, they render correctly.

## AI trigger guard

The orchestrator's `handleIncomingMessage` is by definition the lead-inbound path. Two changes documented the invariant explicitly:

1. **`lib/agents/orchestrator.ts`** — new JSDoc INVARIANT block on `handleIncomingMessage` clarifies the function only processes inbound lead messages; operator replies must use `/api/conversations/[id]/messages`.
2. **`app/api/ai/chat/route.ts`** — new warning comment on the POST handler saying "Do NOT call this from the operator composer."

The function itself already enforces the guard: it only writes `role: 'lead'`. There is no code path inside the orchestrator where operator-typed text could be saved as a lead message — the bug was always at the caller. With the composer fixed, the orchestrator can keep its existing contract for legitimate inbound callers (widget, channel webhooks).

## Realtime behavior

`ConversationThread`'s realtime subscription on `messages` postgres_changes prepends new rows by id. After the fix:
- A `human` insert from the operator composer arrives via realtime → renders on the right.
- A `lead` insert from a widget/webhook arrives via realtime → renders on the left.
- No duplicates: the operator's POST returns success, then the realtime INSERT fires; the dedupe check on `id` prevents a double-render.

## Manual QA checklist

### Case 1 — Lead inbound (still works)
1. Trigger an inbound message via the widget or `/api/ai/chat` (curl).
2. Expect: row inserted with `role: 'lead'`, rendered on the left, AI orchestrator generates a draft reply.

### Case 2 — Human/operator reply (FIXED)
1. Open any conversation in `/dashboard/inbox/<leadId>`.
2. Confirm composer mode is `You` (default unless `lead.ai_active = true`).
3. Type: `Thanks, we would love to show you the venue.`
4. Send.
5. Expect:
   - Bubble renders on the RIGHT, navy background.
   - DB row has `role: 'human'`, `metadata.source: 'operator_composer'`.
   - NO AI auto-response is generated.

### Case 3 — AI mode (FIXED)
1. Toggle composer to `AI`.
2. Type: `confirm her Saturday tour`.
3. Send.
4. Expect:
   - NO message is inserted as `lead`.
   - An AI draft preview appears inline above the footer.
   - Click "Use this draft" → text loads into the textarea, mode flips to `you`.
   - Click Send → row inserted with `role: 'human'`.

### Case 4 — Manual external channel
1. Pick a conversation with `metadata.channel_type` of The Knot / WeddingWire / Instagram.
2. Type an operator reply → sends successfully, saves as `human`, renders on the right.
3. The existing `mark-sent-manually` workflow is unchanged. The composer does NOT claim external delivery.

### Case 5 — Realtime
1. Send a `human` message.
2. Refresh the page.
3. Expect: message still on the right, no duplicates, no AI follow-up.

### Case 6 — AI trigger guard
1. Send a `human` message → confirm no AI orchestrator run in `ai_actions`.
2. Trigger a `lead` message via widget/webhook → confirm AI orchestrator still runs and a draft AI row appears.

## Honesty contract

- Composer does NOT claim external delivery — it only inserts a message row.
- AI mode does NOT auto-send anything; it generates a draft for the operator to review and send.
- Manual-channel reply workflow preserved — operator may still need to copy + send externally + mark sent manually.

## Files modified

- `components/dashboard/MessageComposer.tsx` — mode-aware send path
- `app/api/ai/chat/route.ts` — clarifying warning comment
- `lib/agents/orchestrator.ts` — INVARIANT JSDoc on handleIncomingMessage
- `app/api/health/route.ts` — 4 new flags

No DB schema changes. No new routes. No AI prompt changes.

## Known limitations

- **AI mode uses the regenerate endpoint** (`/api/ai/draft`) with the operator's typed text as `current_draft`. A pure "fresh draft from scratch" path would need a different endpoint; the regenerate flow works because the route variant-polishes whatever seed text it's given. Acceptable for now; clean up if a buyer reports it.
- **The composer's AI mode currently surfaces only the first variant.** The endpoint can return up to 3; a future polish could expose all variants similar to how LeadDetailDrawer does.
- **`/api/ai/chat` is no longer called by any in-app caller** after this fix. It's preserved for widget/webhook inbound paths that don't exist today but are designed for. If those paths never materialize, the route can be marked deprecated in a future cleanup.
