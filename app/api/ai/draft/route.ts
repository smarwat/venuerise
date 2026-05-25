// AUDIT_EXEMPT: every successful draft generation writes a row to
// `public.ai_actions` (Phase 8AN) which IS the canonical forensic
// record for AI draft activity. The AIDraftAuditCard +
// BrandVoiceCalibrationPanel + AutopilotSimulationPanel + Autopilot
// review queue all read from that table. Duplicating into
// `audit_events` would create noise without forensic value; the two
// surfaces already cross-link via `aiActionId`. Documented in
// docs/AUDIT-COVERAGE.md.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { assertOwnsLead, OwnershipError } from '@/lib/auth/assert-ownership'
import { SALES_ROLES } from '@/lib/auth/roles'
import {
  requireActiveSubscription,
  SubscriptionRequiredError,
} from '@/lib/billing/subscription-status'
import { rateLimitAi, rateLimitedResponse } from '@/lib/rate-limit'
import { anthropic, MODEL, AnthropicNotConfiguredError } from '@/lib/anthropic'
import { withAnthropicRetry } from '@/lib/anthropic-retry'
import { computeFinalConfidence } from '@/lib/revenue-os/brand-voice-calibration'
import {
  computeAutopilotDecision,
  detectDraftRiskFlags,
  type AutopilotDecision,
  type DraftRiskFlags,
} from '@/lib/revenue-os/autopilot-guardrails'
import { log } from '@/lib/log'
import {
  getOrCreateRequestId,
  withRequestIdHeader,
} from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'

/**
 * POST /api/ai/draft  (Phase 8AK)
 *
 * Regenerates an AI draft reply for the LeadDetailDrawer "Regenerate"
 * action. Takes the operator's current draft text + an optional natural-
 * language adjustment instruction (e.g. "Warmer", "More concise",
 * "Add pricing") and returns a new variant.
 *
 * Why a new route instead of reusing /api/ai/chat or /api/ai/followup:
 *   - /api/ai/chat takes a LEAD-side message and triggers the full
 *     handleIncomingMessage orchestrator (writes a lead message row,
 *     runs qualification etc.). Inappropriate here — the operator
 *     isn't simulating an inbound message.
 *   - /api/ai/followup is for the scheduled drip system.
 *   - /api/ai/qualify is for the qualifier agent.
 * None of those produce a "rewrite this draft" surface, so this route
 * keeps the responsibility narrow: one Anthropic call, no side effects
 * beyond writing an ai_actions audit row.
 *
 * Security posture (mirrors /api/ai/chat + /api/conversations/[id]/messages):
 *   - Authenticated dashboard user (401 unauthorized).
 *   - assertOwnsLead with SALES_ROLES gate. Cross-tenant access collapses
 *     to 404 lead_not_found.
 *   - requireActiveSubscription billing gate (402 subscription_required).
 *   - Rate-limit per user + lead: `ai-draft-regenerate:{user.id}:{leadId}`.
 *   - Missing ANTHROPIC_API_KEY surfaces as 503 generation_failed (we
 *     map to a humanized vocabulary; the route never leaks the SDK's
 *     raw "Could not resolve authentication method" string).
 *
 * Response error vocabulary:
 *   unauthorized | forbidden | subscription_required | lead_not_found
 *   | validation_failed | rate_limited | generation_failed
 *
 * Audit:
 *   On both success and failure we INSERT one ai_actions row via the
 *   service client with agent='venuerise', action='draft_regenerate'.
 *   On success the row's id is returned to the client so the drawer
 *   can treat the new draft as the "active" pending review for any
 *   subsequent Reject call.
 */

const BodySchema = z.object({
  lead_id: z.string().uuid(),
  // Empty current_draft is rejected — the regenerate intent only makes
  // sense when there's an existing draft to vary against.
  current_draft: z.string().min(1).max(8000),
  // Optional adjustment chip text. We cap length so an adversarial
  // payload can't smuggle a huge prompt into the system message.
  instruction: z.string().max(240).nullable().optional(),
  // Phase 8AL — operators can ask for multiple variants in one call.
  // Hard-capped at 3 server-side regardless of client request so we
  // don't burn tokens on someone fat-fingering `variant_count: 50`.
  // Default 1 preserves the 8AK single-draft contract for any caller
  // that hasn't updated.
  variant_count: z.number().int().min(1).max(3).optional(),
  // Phase 8BV — when the composer's reply-method dropdown sits on
  // SMS, drafts come back too long + too email-shaped. The route
  // honors the operator's selected method by tweaking ONLY the
  // system prompt's length + tone rules; tokens / audit / safety
  // posture stay identical. An unknown value falls back to the
  // email-shaped default (no validation error — the field is
  // advisory). Allowlist mirrors the resolver's ReplyMethodKey.
  reply_method: z
    .enum([
      'email',
      'sms',
      'instagram',
      'facebook',
      'the_knot',
      'weddingwire',
      'meta_lead_ads',
      'website',
      'internal',
    ])
    .optional(),
  reply_delivery_mode: z
    .enum(['direct', 'manual', 'internal_only', 'unavailable'])
    .optional(),
})

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  const reqLog = log.child({
    requestId,
    route: '/api/ai/draft',
    op: 'ai.draft.regenerate',
  })
  const respond = <T extends Response>(r: T) =>
    withRequestIdHeader(r, requestId)

  // 1. Auth.
  const supabase = await createClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) {
    return respond(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    )
  }

  // 2. Body — parse + validate up front so we don't burn the rate-limit
  // budget on malformed payloads.
  const rawBody = await request.json().catch(() => null)
  const parsed = BodySchema.safeParse(rawBody ?? {})
  if (!parsed.success) {
    return respond(
      NextResponse.json(
        { error: 'validation_failed', detail: parsed.error.flatten() },
        { status: 400 }
      )
    )
  }
  const { lead_id, current_draft, instruction } = parsed.data
  // Coerce to the 1-3 range; the Zod schema already enforces this, but
  // an explicit default here keeps the rest of the handler readable.
  const variantCount = parsed.data.variant_count ?? 1
  // Phase 8BV — selected reply method from the composer's dropdown.
  // Advisory only: drives prompt shape (SMS = short + plain, email
  // = normal) but never gates send authorization. Defaults to
  // 'email' shape when unset — matches the pre-8BV behavior.
  const replyMethodHint = parsed.data.reply_method ?? 'email'

  // 3. Ownership: lead must belong to a venue the caller has
  // SALES_ROLES on. Cross-tenant access → 404 (matches /api/ai/chat
  // posture; doesn't leak existence across tenants).
  let venueId: string
  try {
    const own = await assertOwnsLead(supabase, user.id, lead_id, SALES_ROLES)
    venueId = own.venue_id
  } catch (err) {
    if (err instanceof OwnershipError) {
      return respond(
        NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
      )
    }
    throw err
  }

  // 4. Billing gate.
  try {
    await requireActiveSubscription(venueId, {
      requestId,
      route: '/api/ai/draft',
    })
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) {
      return respond(
        NextResponse.json(
          {
            error: 'subscription_required',
            subscription_status: err.subscriptionStatus.kind,
          },
          { status: err.status }
        )
      )
    }
    throw err
  }

  // 5. Rate limit: per user + lead so a regenerate-loop on one lead
  // doesn't deny the operator's drafts on every other lead.
  const rl = await rateLimitAi(
    request,
    `ai-draft-regenerate:${user.id}:${lead_id}`
  )
  if (!rl.allowed) {
    reqLog.warn(
      { userId: user.id, leadId: lead_id, retryMs: rl.retryAfterMs },
      'rate_limit.blocked'
    )
    // Surface humanized error vocab in the JSON body while preserving
    // the standard rate-limit headers from rateLimitedResponse.
    const base = rateLimitedResponse(rl)
    const body = await base
      .clone()
      .json()
      .catch(() => ({}))
    const merged = NextResponse.json(
      { ...(body as Record<string, unknown>), error: 'rate_limited' },
      { status: base.status, headers: base.headers }
    )
    return respond(merged)
  }

  // 6. Pull lead + venue context for the prompt. Service client because
  // we want a single fast read regardless of which RLS chain the user
  // might be subject to (we've already authorized via assertOwnsLead).
  const svc = createServiceClient()
  const [leadRes, venueRes] = await Promise.all([
    svc
      .from('leads')
      .select(
        'id, name, email, event_date, guest_count, budget, notes, source, lead_score, stage'
      )
      .eq('id', lead_id)
      .maybeSingle(),
    svc
      .from('venues')
      .select('id, name, ai_persona_name, ai_tone, base_price')
      .eq('id', venueId)
      .maybeSingle(),
  ])

  const lead = leadRes.data as {
    name: string
    email: string
    event_date: string | null
    guest_count: number | null
    budget: number | null
    notes: string | null
    source: string | null
    lead_score: number
    stage: string
  } | null

  const venue = venueRes.data as {
    name: string
    ai_persona_name: string | null
    ai_tone: string | null
    base_price: number | null
  } | null

  if (!lead || !venue) {
    // Should be unreachable post-assertOwnsLead, but treat as not_found
    // (don't reveal which side missed). The audit row stays unwritten
    // — there's no successful or attempted Anthropic call to record.
    reqLog.warn(
      { leadId: lead_id, venueId, leadMissing: !lead, venueMissing: !venue },
      'ai.draft.context_missing'
    )
    return respond(
      NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
    )
  }

  // 7. Build a NARROW prompt. Deliberately doesn't reuse the
  // generateConversationReply system prompt — that one is built for the
  // first/next inbound-reply path and ends with "ONE clear question".
  // For regenerate the spec is "produce a variant of the existing draft
  // with the same intent, optionally biased by `instruction`."
  const firstName = lead.name.split(/\s+/)[0] ?? lead.name
  const persona = venue.ai_persona_name?.trim() || 'the event coordinator'
  const tone = venue.ai_tone?.trim() || 'warm and professional'

  const variantsLine =
    variantCount === 1
      ? `Produce ONE new variant of the draft that keeps the same intent and concrete commitments, varies the phrasing, and respects every rule below.`
      : `Produce ${variantCount} CLEARLY DISTINCT new variants of the draft. Each variant must keep the same intent and concrete commitments, vary the phrasing meaningfully (different opening, different angle), and respect every rule below.`

  const variantOutputRule =
    variantCount === 1
      ? `• Output the rewritten reply text — no preamble, no labels, no quoting of the original.`
      : `• Output EXACTLY ${variantCount} variants, separated by a line containing only "---" (three hyphens). No "Variant 1:" labels, no preamble, no markdown headings, no quoting of the original. Just the reply text, then "---", then the next reply text.`

  // Phase 8AV — Brand Voice self-rating. The model emits a single
  // CONFIDENCE: <int 0-100> line at the end of each variant (after a
  // blank line) representing how confident it is that the reply
  // matches the venue's tone + has enough lead context to send
  // safely. Lower = more uncertain; the dashboard's escalation gate
  // reads this back via `parseVariantsWithConfidence`.
  //
  // The parser is defensive — if the model forgets the line, we
  // fall back to a text-heuristic score so the gate never silently
  // accepts an unrated variant.
  const confidenceOutputRule = `• After each variant's text, on its own line, output: CONFIDENCE: <integer 0-100>
  - 100 = on-brand and grounded in the venue context.
  - 70  = solid but could use operator review.
  - 50 or lower = uncertain, missing context, or hedging.
  Pick the number that honestly reflects your confidence; do not always pick 100. Do not add any other text on the CONFIDENCE line.`

  // Phase 8BV — channel-shaped length/format rules. SMS replies
  // must be short, plain, and conversational (carrier truncation
  // + reader phone screen). Email keeps the 2–4 sentence default.
  // Manual native channels (Instagram / Facebook / Knot) inherit
  // the SMS-ish short rule because those threads are also
  // short-form. Anything else falls back to email shape.
  const isShortFormChannel =
    replyMethodHint === 'sms' ||
    replyMethodHint === 'instagram' ||
    replyMethodHint === 'facebook' ||
    replyMethodHint === 'the_knot' ||
    replyMethodHint === 'weddingwire'
  const channelLengthRule = isShortFormChannel
    ? replyMethodHint === 'sms'
      ? `• Keep each variant 1–2 short sentences. Aim for under 280 characters. Plain text only — no markdown, no email signoff, no long paragraphs. End with ONE clear next step.`
      : `• Keep each variant 1–3 short sentences suited to a ${replyMethodHint} thread. Plain text only — no markdown, no formal email signoff. End with ONE clear next step.`
    : `• Keep each variant 2–4 sentences. End with ONE clear next step.`

  const systemPrompt = [
    `You are ${persona} at ${venue.name}. Tone: ${tone}.`,
    `You are rewriting an existing draft reply to a wedding-venue lead`,
    `(the operator clicked "Regenerate"). ${variantsLine}`,
    ``,
    `RULES:`,
    `• Never mention you are AI, a bot, or automated.`,
    `• Never quote hard prices — say "starting from" or invite a chat.`,
    `• Address the lead by first name (${firstName}).`,
    channelLengthRule,
    variantOutputRule,
    confidenceOutputRule,
  ].join('\n')

  const instructionLine = instruction && instruction.trim().length > 0
    ? `\n\nADJUSTMENT INSTRUCTION (apply faithfully):\n${instruction.trim()}`
    : ''

  const userPrompt = [
    `LEAD CONTEXT:`,
    `• Name: ${lead.name}`,
    `• Event date: ${lead.event_date ?? 'not specified'}`,
    `• Guests: ${lead.guest_count ?? 'not specified'}`,
    `• Budget: ${lead.budget ? `$${lead.budget}` : 'not specified'}`,
    `• Stage: ${lead.stage}`,
    `• Fit score: ${lead.lead_score}/100`,
    ``,
    `CURRENT DRAFT (rewrite this):`,
    current_draft.trim(),
    instructionLine,
  ]
    .join('\n')
    .trim()

  // 8. Anthropic call. max_tokens scales with variant count so a 3-
  // variant request has room to breathe without truncation, but we
  // never push past ~1200 to keep per-call cost bounded.
  const start = Date.now()
  let rawText = ''
  let tokensUsed = 0
  const maxTokens = Math.min(400 * variantCount, 1200)
  try {
    const response = await withAnthropicRetry(
      (signal) =>
        anthropic.messages.create(
          {
            model: MODEL,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          },
          { signal }
        ),
      { agent: 'draft_regenerate', requestId, model: MODEL }
    )
    rawText =
      response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''
    tokensUsed =
      (response.usage?.input_tokens ?? 0) +
      (response.usage?.output_tokens ?? 0)
  } catch (err) {
    const latencyMs = Date.now() - start
    if (err instanceof AnthropicNotConfiguredError) {
      reqLog.info({ leadId: lead_id }, 'ai.draft.anthropic_not_configured')
      // Best-effort audit row so operators see the attempt — non-fatal
      // if the insert itself fails.
      await svc
        .from('ai_actions')
        .insert({
          venue_id: venueId,
          lead_id,
          agent: 'venuerise',
          action: 'draft_regenerate',
          input_summary: summarizeInput(current_draft, instruction ?? null),
          latency_ms: latencyMs,
          success: false,
          error_message: 'anthropic_not_configured',
        })
        .then(() => undefined, () => undefined)
      return respond(
        NextResponse.json(
          { error: 'generation_failed', detail: 'anthropic_not_configured' },
          { status: 503 }
        )
      )
    }
    reqLog.error({ err, leadId: lead_id }, 'ai.draft.generation_failed')
    captureApiError(err, {
      requestId,
      route: '/api/ai/draft',
      userId: user.id,
      venueId,
    })
    await svc
      .from('ai_actions')
      .insert({
        venue_id: venueId,
        lead_id,
        agent: 'venuerise',
        action: 'draft_regenerate',
        input_summary: summarizeInput(current_draft, instruction ?? null),
        latency_ms: latencyMs,
        success: false,
        error_message:
          err instanceof Error ? err.message.slice(0, 240) : 'generation_failed',
      })
      .then(() => undefined, () => undefined)
    return respond(
      NextResponse.json({ error: 'generation_failed' }, { status: 500 })
    )
  }

  const latencyMs = Date.now() - start

  // 9. Parse variants. The model is instructed to separate them with a
  // bare "---" line. We split, normalize, strip any incidental
  // "Variant N:" labels the model still emitted, and drop empties.
  // If parsing yields zero or one usable variant for a multi-variant
  // request, we silently degrade to whatever we got (better one draft
  // than an error after the operator already paid token cost).
  const {
    drafts,
    modelConfidences,
    heuristicConfidences,
    finalConfidences,
  } = parseVariantsWithConfidence(rawText, variantCount)
  // Phase 8AW — the response keeps the legacy `confidences[]` field
  // name (Phase 8AV contract); it now carries the FINAL adjusted
  // score per variant. The drawer's gate already reads from this.
  const confidences = finalConfidences

  if (drafts.length === 0) {
    // Model returned an empty content block (or pure whitespace).
    reqLog.warn(
      { leadId: lead_id, latencyMs },
      'ai.draft.empty_response'
    )
    await svc
      .from('ai_actions')
      .insert({
        venue_id: venueId,
        lead_id,
        agent: 'venuerise',
        action: 'draft_regenerate',
        input_summary: summarizeInput(current_draft, instruction ?? null),
        latency_ms: latencyMs,
        tokens_used: tokensUsed,
        success: false,
        error_message: 'empty_response',
      })
      .then(() => undefined, () => undefined)
    return respond(
      NextResponse.json({ error: 'generation_failed' }, { status: 502 })
    )
  }

  // 10. Audit row (success). One row per regenerate call regardless of
  // variant count; `output_summary` carries a compact summary spanning
  // every variant so the audit log stays scannable. The returned id
  // flows back to the drawer so any subsequent Reject targets this row.
  // Failure to insert the audit row shouldn't deny the operator their
  // regenerated text — we surface ai_action_id=null and continue.
  //
  // Phase 8AM — persist the full variant set into `ai_actions.metadata`
  // (jsonb, migration 021). Forensic replay can answer "operator was
  // offered 3 variants, chose option 2" by joining the chosen
  // variant index from the messages row's metadata against this row's
  // `variants_offered` array. We deliberately DO NOT store any lead
  // PII or the raw `current_draft`; only the operator's adjustment
  // instruction (capped) and the model's output variants (each capped
  // at 2000 chars) land here.
  const outputSummary = summarizeVariants(drafts)

  // Phase 8AX — per-variant risk flags + autopilot decisions. Pure
  // helpers; deterministic; no extra network calls. We compute both
  // arrays here (parallel to drafts/confidences) so the audit
  // metadata can persist them and the drawer can render the pill
  // for whichever variant the operator selects.
  //
  // Why compute at draft time instead of inside buildAuditMetadata:
  // the decision depends on the lead (stage/score) which is only
  // available here. We pass the resulting arrays into the metadata
  // builder so storage stays in one place.
  const variantRiskFlags: DraftRiskFlags[] = drafts.map((d) =>
    detectDraftRiskFlags(d)
  )
  const autopilotDecisions: AutopilotDecision[] = drafts.map((_d, i) => {
    const risk = variantRiskFlags[i]
    return computeAutopilotDecision({
      finalConfidence: finalConfidences[i] ?? null,
      modelConfidence: modelConfidences[i] ?? null,
      heuristicConfidence: heuristicConfidences[i] ?? null,
      hasPricingQuestion: risk.hasPricingQuestion,
      hasPolicyQuestion: risk.hasPolicyQuestion,
      hasAvailabilityClaim: risk.hasAvailabilityClaim,
      leadScore: lead.lead_score,
      leadStage: lead.stage,
      // Operator history + venue context signal aren't known per-
      // variant at draft time. The calibration panel composes them
      // ACROSS rows; passing undefined here lets the helper
      // degrade gracefully (it won't fire `edits_before_send` or
      // `context_needs_more` without evidence).
    })
  })

  const auditMetadata = buildAuditMetadata(
    drafts,
    instruction ?? null,
    finalConfidences,
    modelConfidences,
    heuristicConfidences,
    variantRiskFlags,
    autopilotDecisions
  )

  // Phase 8AW — mark the PREVIOUS draft for this lead as
  // `operator_outcome='regenerated'`. The signal is: "the operator
  // saw this draft, didn't send it, didn't reject it, and asked for
  // another." Idempotent: we skip if the prior row already has any
  // outcome set (terminal once written). Best-effort — a failure
  // here doesn't deny the new draft.
  try {
    const { data: priorRows } = await svc
      .from('ai_actions')
      .select('id, metadata')
      .eq('venue_id', venueId)
      .eq('lead_id', lead_id)
      .eq('agent', 'venuerise')
      .eq('action', 'draft_regenerate')
      .eq('success', true)
      .is('rejected_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
    const prior = (priorRows as Array<{
      id: string
      metadata: Record<string, unknown> | null
    }> | null)?.[0]
    if (
      prior &&
      !(prior.metadata && (prior.metadata as { operator_outcome?: string }).operator_outcome)
    ) {
      const mergedMetadata = {
        ...(prior.metadata ?? {}),
        operator_outcome: 'regenerated',
        operator_outcome_at: new Date().toISOString(),
      }
      await svc
        .from('ai_actions')
        .update({ metadata: mergedMetadata })
        .eq('id', prior.id)
    }
  } catch (err) {
    reqLog.warn(
      { err, leadId: lead_id },
      'ai.draft.prior_outcome_mark_failed'
    )
  }
  const { data: actionRow, error: insertErr } = await svc
    .from('ai_actions')
    .insert({
      venue_id: venueId,
      lead_id,
      agent: 'venuerise',
      action: 'draft_regenerate',
      input_summary: summarizeInput(current_draft, instruction ?? null),
      output_summary: outputSummary,
      latency_ms: latencyMs,
      tokens_used: tokensUsed,
      success: true,
      metadata: auditMetadata,
    })
    .select('id')
    .single()

  if (insertErr) {
    reqLog.warn(
      { err: insertErr, leadId: lead_id },
      'ai.draft.audit_insert_failed'
    )
  }

  reqLog.info(
    {
      leadId: lead_id,
      venueId,
      latencyMs,
      tokensUsed,
      variantCountRequested: variantCount,
      variantCountReturned: drafts.length,
      hasInstruction: Boolean(instruction && instruction.trim().length > 0),
      // Phase 8BV — visibility into how often operators are picking
      // SMS vs email at draft time. No PII; just the hint key.
      replyMethodHint,
      isShortFormChannel,
      aiActionId: (actionRow as { id?: string } | null)?.id ?? null,
      // Phase 8AV — log per-call confidence range so operators can
      // diff how often the model is rating itself low vs the
      // heuristic kicking in.
      minConfidence:
        confidences.length > 0 ? Math.min(...confidences) : null,
      maxConfidence:
        confidences.length > 0 ? Math.max(...confidences) : null,
    },
    'ai.draft.regenerated'
  )

  return respond(
    NextResponse.json({
      success: true,
      // Phase 8AL — `draft` stays for backward compat with any 8AK
      // caller; `drafts` carries the full list (always length >= 1).
      // The primary draft is `drafts[0]`, which is what the drawer
      // selects by default before the operator picks an alternative.
      // Phase 8AV — `confidences` is a parallel array (0..100) the
      // drawer's brand-voice escalation gate reads to decide whether
      // to show the "Low-confidence draft" chip + soft/hard-block
      // Approve & send.
      confidences,
      draft: drafts[0],
      drafts,
      // Phase 8AX — parallel to `drafts`; the LeadDetailDrawer
      // renders the pill + helper for whichever variant the
      // operator currently has selected. snake_case wire format
      // matches the persisted metadata so the drawer doesn't have
      // to translate between two shapes.
      autopilot_decisions: autopilotDecisions.map((d) => ({
        mode: d.mode,
        label: d.label,
        helper: d.helper,
        reasons: d.reasons,
        confidence: d.confidence,
      })),
      ai_action_id: (actionRow as { id?: string } | null)?.id ?? null,
    })
  )
}

/**
 * Parse the model's multi-variant output into draft strings + per-
 * variant confidence scores.
 *
 * Phase 8AV — every variant the model emits is followed by a
 * `CONFIDENCE: <int 0-100>` line on its own (after a blank line, per
 * the system prompt). `parseVariantsWithConfidence` extracts the
 * score, strips the line from the displayed text, and falls back to a
 * text heuristic when the model forgot/garbled the line.
 *
 * Defensive behavior (carried over from Phase 8AL):
 *   - For variant_count = 1, we still return one entry (with leading
 *     "Variant 1:" labels stripped just in case).
 *   - For variant_count > 1, we split on `---` then strip any
 *     "Variant N:" / "**Variant N**" prefixes the model snuck in.
 *   - If the split yields just one chunk for a multi-variant request,
 *     we return what we got — better than erroring after token spend.
 *   - Empty chunks are dropped.
 *   - Final list capped at the requested variant_count so a chatty
 *     model can't push 5 variants when 3 were asked for.
 */
function parseVariantsWithConfidence(
  raw: string,
  requested: number
): {
  drafts: string[]
  // Phase 8AW — three parallel arrays so the audit metadata can
  // distinguish model self-rating from final adjusted score:
  //   - `modelConfidences[i]`     — raw value from CONFIDENCE: line,
  //                                  or null when the model omitted it
  //   - `heuristicConfidences[i]` — deterministic text score
  //   - `finalConfidences[i]`     — conservative blend the gate uses
  //                                  + the response surfaces as
  //                                  `confidences[]` for backward compat
  modelConfidences: Array<number | null>
  heuristicConfidences: number[]
  finalConfidences: number[]
} {
  if (!raw || !raw.trim()) {
    return {
      drafts: [],
      modelConfidences: [],
      heuristicConfidences: [],
      finalConfidences: [],
    }
  }
  const cleanLabel = (s: string): string =>
    s
      .replace(/^\s*(?:\*\*)?\s*variant\s*\d+\s*[:.\)]\s*(?:\*\*)?\s*/i, '')
      .trim()
  const rawChunks =
    requested === 1
      ? [raw]
      : raw.split(/^\s*-{3,}\s*$/m).filter((p) => p.trim().length > 0)
  const drafts: string[] = []
  const modelConfidences: Array<number | null> = []
  const heuristicConfidences: number[] = []
  const finalConfidences: number[] = []
  for (const chunk of rawChunks) {
    const { body, confidence } = extractConfidence(chunk)
    const cleaned = cleanLabel(body)
    if (!cleaned) continue
    drafts.push(cleaned)
    const heuristic = heuristicConfidence(cleaned)
    modelConfidences.push(confidence)
    heuristicConfidences.push(heuristic)
    finalConfidences.push(computeFinalConfidence(confidence, heuristic))
  }
  return {
    drafts: drafts.slice(0, requested),
    modelConfidences: modelConfidences.slice(0, requested),
    heuristicConfidences: heuristicConfidences.slice(0, requested),
    finalConfidences: finalConfidences.slice(0, requested),
  }
}

/**
 * Strip the `CONFIDENCE: <int>` line out of a variant chunk and
 * return the cleaned body + parsed score. Tolerates:
 *   - Capitalization: `CONFIDENCE`, `Confidence`, `confidence`
 *   - Trailing punctuation
 *   - Leading bullets or markdown
 *   - Whitespace surrounding the integer
 * Returns `confidence: null` when no parseable line is found.
 */
function extractConfidence(chunk: string): {
  body: string
  confidence: number | null
} {
  const match = chunk.match(
    /^\s*(?:[-*•]\s*)?\**\s*confidence\s*[:=-]\s*(\d{1,3})\s*\**\s*$/im
  )
  if (!match) return { body: chunk, confidence: null }
  const raw = Number(match[1])
  if (!Number.isFinite(raw)) return { body: chunk, confidence: null }
  const clamped = Math.max(0, Math.min(100, Math.round(raw)))
  const body = chunk.replace(match[0], '').trim()
  return { body, confidence: clamped }
}

/**
 * Phase 8AV — text-only confidence heuristic used when the model
 * didn't emit a parseable CONFIDENCE line. The score lives in the
 * same 0–100 scale as the model self-rating so the dashboard's
 * escalation gate doesn't have to discriminate between the two
 * sources at read time.
 *
 * The heuristic is intentionally conservative — it tilts toward
 * "needs review" when the text has the textural signs of an
 * uncertain reply. Designed to err on the safe side rather than
 * cross-validate every literary preference.
 *
 * Bands:
 *   - Base                                              75
 *   - +5 if 100..300 chars (good concise reply length)
 *   - -10 if < 50 chars (too short to be a real reply)
 *   - -10 if > 600 chars (rambling)
 *   - -15 per hedging phrase up to -30 total
 *           ("I think", "maybe", "perhaps", "I'm not sure",
 *            "I believe", "might be")
 *   - -5  if no first-name token in the first 80 chars
 *   - -5  if no clear closing CTA (no `?` and no
 *           "let me know" / "would you like" / "let's" / "can we")
 *   - clamp 0..100
 */
const HEDGE_PHRASES = [
  /\bi\s+think\b/i,
  /\bmaybe\b/i,
  /\bperhaps\b/i,
  /\bi['’]?m\s+not\s+sure\b/i,
  /\bi\s+believe\b/i,
  /\bmight\s+be\b/i,
]
const CTA_PHRASES = [
  /\?\s*$/,
  /let\s+me\s+know/i,
  /would\s+you\s+like/i,
  /let['’]?s\b/i,
  /can\s+we\b/i,
  /shall\s+we\b/i,
]
function heuristicConfidence(text: string): number {
  if (!text || text.trim().length === 0) return 0
  const t = text.trim()
  let score = 75
  if (t.length >= 100 && t.length <= 300) score += 5
  if (t.length < 50) score -= 10
  if (t.length > 600) score -= 10
  let hedgeHits = 0
  for (const rx of HEDGE_PHRASES) {
    if (rx.test(t)) hedgeHits += 1
    if (hedgeHits >= 2) break
  }
  score -= hedgeHits * 15
  const opener = t.slice(0, 80)
  const hasName = /\b[A-Z][a-z]{2,}\b/.test(opener)
  if (!hasName) score -= 5
  const hasCta = CTA_PHRASES.some((rx) => rx.test(t))
  if (!hasCta) score -= 5
  return Math.max(0, Math.min(100, score))
}

/**
 * Phase 8AM — build the `ai_actions.metadata` payload that captures
 * the variants the operator was offered, the instruction (if any),
 * and which variant index was selected by default. Used by the audit
 * trail to replay "operator was shown N options" forensics.
 *
 * Caps:
 *   - each stored variant truncated to 2000 chars + ellipsis
 *   - instruction truncated to 240 chars (already capped by the Zod
 *     schema on input, but we re-cap defensively here too)
 *   - selected_by_default is always 0 — the API doesn't know which
 *     variant the operator picked; that surfaces later on the
 *     messages.metadata.selected_variant_index field when they
 *     Approve & send (Phase 8AM step 4).
 */
const VARIANT_STORAGE_CAP = 2000
function buildAuditMetadata(
  drafts: string[],
  instruction: string | null,
  finalConfidences: number[] = [],
  modelConfidences: Array<number | null> = [],
  heuristicConfidences: number[] = [],
  // Phase 8AX — risk flags + autopilot decisions, parallel to
  // `drafts`. Optional (older call sites may not pass them); we
  // emit empty arrays in that case so consumers can rely on the
  // field being array-shaped.
  variantRiskFlags: DraftRiskFlags[] = [],
  autopilotDecisions: AutopilotDecision[] = []
): Record<string, unknown> {
  const variants_offered = drafts.map((d) =>
    d.length > VARIANT_STORAGE_CAP
      ? `${d.slice(0, VARIANT_STORAGE_CAP)}…`
      : d
  )
  // Phase 8AV — persist the parallel FINAL confidence array. Same
  // length as variants_offered; values 0..100. `min_confidence` is
  // denormed so the admin draft-audit route can filter low-
  // confidence rows without re-parsing the array.
  const clampedFinal = drafts.map((_, i) =>
    Math.max(0, Math.min(100, Math.round(finalConfidences[i] ?? 0)))
  )
  // Phase 8AW — also persist the raw model self-rating + the
  // deterministic heuristic score so the calibration layer can
  // compare "what did the model think" vs "what did the text
  // actually look like" vs "what did we finally show."
  const clampedHeuristic = drafts.map((_, i) =>
    Math.max(0, Math.min(100, Math.round(heuristicConfidences[i] ?? 0)))
  )
  const clampedModel = drafts.map((_, i) => {
    const v = modelConfidences[i]
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    return Math.max(0, Math.min(100, Math.round(v)))
  })
  // Adjustment delta = final - model when the model rated.
  // Null when the model didn't emit a CONFIDENCE: line (we don't
  // synthesize a fake delta).
  const adjustmentDeltas = drafts.map((_, i) => {
    const m = clampedModel[i]
    if (m === null) return null
    return clampedFinal[i] - m
  })
  // `confidence_source` distinguishes "model rated at least one
  // variant" vs "every variant fell back to heuristic". The
  // calibration panel uses this to label the overconfidence signal
  // as a model-vs-heuristic gap or as a heuristic-only outlier.
  const anyModel = clampedModel.some((v) => v !== null)
  const confidence_source: 'model_and_heuristic' | 'heuristic_fallback' =
    anyModel ? 'model_and_heuristic' : 'heuristic_fallback'
  const min_confidence =
    clampedFinal.length === 0 ? null : Math.min(...clampedFinal)
  // Phase 8AX — project the per-variant risk flags + autopilot
  // decisions into the snake_case shape we persist. Keep the
  // arrays parallel to `variants_offered`; if upstream passed
  // empty arrays (older internal call site), pad with safe nulls
  // so the audit row stays array-shaped + indexable by variant.
  const variant_risk_flags = drafts.map((_, i) => {
    const r = variantRiskFlags[i]
    return {
      has_pricing_question: r?.hasPricingQuestion ?? false,
      has_policy_question: r?.hasPolicyQuestion ?? false,
      has_availability_claim: r?.hasAvailabilityClaim ?? false,
    }
  })
  const autopilot_decisions = drafts.map((_, i) => {
    const d = autopilotDecisions[i]
    if (!d) {
      return {
        mode: 'review_required',
        label: 'Review required',
        helper:
          'Review before sending. The system detected medium confidence or context gaps.',
        reasons: [],
        confidence: null,
      }
    }
    return {
      mode: d.mode,
      label: d.label,
      helper: d.helper,
      reasons: d.reasons,
      confidence: d.confidence,
    }
  })
  return {
    variant_count: drafts.length,
    variants_offered,
    selected_by_default: 0,
    instruction:
      instruction && instruction.trim().length > 0
        ? instruction.trim().slice(0, 240)
        : null,
    variant_confidences: clampedFinal,
    min_confidence,
    // Phase 8AW additions — non-breaking; old readers ignore.
    model_variant_confidences: clampedModel,
    heuristic_variant_confidences: clampedHeuristic,
    confidence_adjustment_deltas: adjustmentDeltas,
    confidence_source,
    // Phase 8AX additions — non-breaking; old readers ignore.
    variant_risk_flags,
    autopilot_decisions,
  }
}

/**
 * Compact, single-line audit summary that spans every variant. Each
 * variant contributes up to ~80 chars; total caps at ~400 so the
 * ai_actions.output_summary column stays scannable in the audit feed.
 */
function summarizeVariants(drafts: string[]): string {
  if (drafts.length === 1) return drafts[0]
  const parts = drafts.map((d, i) => {
    const snippet = d.replace(/\s+/g, ' ').slice(0, 80)
    return `[${i + 1}] ${snippet}${d.length > 80 ? '…' : ''}`
  })
  return parts.join(' | ').slice(0, 400)
}

/**
 * Capped, single-line summary of the regenerate inputs for the
 * ai_actions.input_summary column. Avoids leaking arbitrarily-long
 * draft bodies into the audit log while still preserving enough
 * context for forensic review.
 */
function summarizeInput(
  currentDraft: string,
  instruction: string | null
): string {
  const draftPart = currentDraft.trim().replace(/\s+/g, ' ').slice(0, 160)
  const instrPart =
    instruction && instruction.trim().length > 0
      ? ` | instruction: ${instruction.trim().slice(0, 80)}`
      : ''
  return `regenerate from: "${draftPart}${draftPart.length === 160 ? '…' : ''}"${instrPart}`
}
