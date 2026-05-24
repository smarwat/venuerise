import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import type { NormalizedInboundEmail } from './email'

/**
 * Phase 8BQ — Persistent dead-letter / review queue for
 * unmatched inbound email replies.
 *
 * 8BO captures inbound replies that match by header (HIGH) or
 * by recent recipient (MEDIUM) and inserts them as `role:'lead'`.
 * Anything weaker than that was silently dropped — invisible to
 * the operator. This module persists those orphans into
 * `inbound_email_orphans` so an operator can manually link them
 * to the correct conversation (or dismiss).
 *
 * ── HONESTY CONTRACT ──────────────────────────────────────────────────────
 *   - Orphans are NEVER inserted as messages. Linking is a
 *     deliberate operator action via /api/inbound-email-orphans/
 *     [id]/link.
 *   - AI never fires on an orphan — not when it lands, not after
 *     linking.
 *   - We expand the venue-detection net (vs the 8BO matcher) so
 *     orphans land tenant-scoped when possible. The expanded
 *     detection is INTENTIONALLY non-authoritative: it gives the
 *     row a venue so operators can see + act, but never
 *     auto-inserts the reply.
 *   - We do NOT store raw payloads, full headers, or attachments.
 *     Body preview is capped (500 chars raw + 8000 chars stripped).
 *   - Dedupe by `provider_inbound_id` is hard-enforced by the
 *     unique index in migration 040.
 */

export type OrphanCreateOutcome =
  | {
      ok: true
      orphanId: string
      venueId: string | null
      created: boolean
      suggestionCount: number
    }
  | {
      ok: false
      reason: 'no_venue_hint_and_skipped' | 'insert_failed'
    }

export interface OrphanCreateInput {
  normalized: NormalizedInboundEmail
  provider: string
  providerInboundId: string | null
  /**
   * Confidence the inbound matcher could compute even though it
   * decided NOT to insert. Used to seed `match_confidence` on
   * the orphan row.
   */
  matchConfidence: number
  matchReasons: string[]
  receivedAtIso: string | null
}

/**
 * Expand the venue-detection net.
 *
 * The 8BO matcher uses two precise strategies (header match +
 * 30-day recent-recipient match) and inserts as a real
 * `role:'lead'` message when either fires. By the time we're in
 * orphan territory, both already failed.
 *
 * For the queue we widen the net using DETERMINISTIC, low-cost
 * lookups. None of these produce auto-inserts — they just give
 * the orphan a tenant so it shows up in the right venue's queue.
 *
 *   1. `outbound_messages.to_address = fromEmail` with NO time
 *      cap — catches leads who reply months later.
 *   2. `leads.email = fromEmail` — catches a lead replying from
 *      a new conversation thread.
 *   3. Domain-only heuristic is deliberately NOT used (would
 *      misroute @gmail.com / @yahoo.com replies across tenants).
 *
 * Returns the inferred venue + suggested conversation/lead ids
 * for the operator to one-click link.
 */
async function inferVenueAndSuggestions(fromEmail: string): Promise<{
  venueId: string | null
  suggestedConversationIds: string[]
  suggestedLeadIds: string[]
  reasons: string[]
}> {
  const supabase = createServiceClient()
  const reasons: string[] = []
  const conversationIds = new Set<string>()
  const leadIds = new Set<string>()
  const venueCounts = new Map<string, number>()

  // 1. Any outbound email to this address (no time cap).
  try {
    const { data: outbound } = await supabase
      .from('outbound_messages')
      .select('venue_id, lead_id, related_table, related_id, created_at')
      .eq('to_address', fromEmail)
      .eq('channel', 'email')
      .order('created_at', { ascending: false })
      .limit(10)
    if (outbound && (outbound as Array<{ venue_id: string }>).length > 0) {
      const rows = outbound as Array<{
        venue_id: string
        lead_id: string | null
        related_table: string | null
        related_id: string | null
      }>
      for (const r of rows) {
        if (r.venue_id) {
          venueCounts.set(r.venue_id, (venueCounts.get(r.venue_id) ?? 0) + 1)
        }
        if (r.lead_id) leadIds.add(r.lead_id)
      }
      reasons.push('venue_from_outbound_history')
      // Resolve conversation ids via the message-linked rows.
      const msgIds = rows
        .filter((r) => r.related_table === 'messages' && r.related_id)
        .map((r) => r.related_id as string)
      if (msgIds.length > 0) {
        const { data: msgs } = await supabase
          .from('messages')
          .select('conversation_id')
          .in('id', msgIds)
        for (const m of (msgs ?? []) as Array<{ conversation_id: string | null }>) {
          if (m.conversation_id) conversationIds.add(m.conversation_id)
        }
      }
    }
  } catch (err) {
    log.warn({ err }, 'inbound.orphan.outbound_lookup_failed')
  }

  // 2. Any lead with this email.
  try {
    const { data: leads } = await supabase
      .from('leads')
      .select('id, venue_id')
      .eq('email', fromEmail)
      .limit(10)
    if (leads && (leads as Array<{ id: string }>).length > 0) {
      const rows = leads as Array<{ id: string; venue_id: string }>
      for (const r of rows) {
        if (r.venue_id) {
          venueCounts.set(r.venue_id, (venueCounts.get(r.venue_id) ?? 0) + 1)
        }
        leadIds.add(r.id)
      }
      reasons.push('venue_from_lead_email')

      // Also pull the lead's most recent conversation as a
      // suggested link target.
      const leadIdList = rows.map((r) => r.id)
      const { data: convs } = await supabase
        .from('conversations')
        .select('id, lead_id')
        .in('lead_id', leadIdList)
        .order('last_message_at', { ascending: false })
        .limit(5)
      for (const c of (convs ?? []) as Array<{ id: string }>) {
        conversationIds.add(c.id)
      }
    }
  } catch (err) {
    log.warn({ err }, 'inbound.orphan.lead_lookup_failed')
  }

  // Pick the venue with the most signals. Ties go to insertion
  // order (Map keeps it). If we found nothing, venueId stays null.
  let bestVenue: string | null = null
  let bestCount = 0
  for (const [vid, count] of venueCounts.entries()) {
    if (count > bestCount) {
      bestVenue = vid
      bestCount = count
    }
  }

  return {
    venueId: bestVenue,
    suggestedConversationIds: Array.from(conversationIds).slice(0, 5),
    suggestedLeadIds: Array.from(leadIds).slice(0, 5),
    reasons,
  }
}

/**
 * Persist an unmatched inbound email reply. Safe to call on the
 * webhook hot path — never throws.
 *
 * Returns `{ ok: true, created: false }` when a row already
 * existed for this provider_inbound_id (idempotent retry).
 */
export async function createInboundEmailOrphan(
  input: OrphanCreateInput
): Promise<OrphanCreateOutcome> {
  const supabase = createServiceClient()
  const reasonsBase = [...input.matchReasons]

  // 1. Dedupe by provider id first (hard unique index also
  //    enforces this; we read first so we can return the
  //    existing id without a noisy insert collision).
  if (input.providerInboundId) {
    try {
      const { data: existing } = await supabase
        .from('inbound_email_orphans')
        .select('id, venue_id')
        .eq('provider', input.provider)
        .eq('provider_inbound_id', input.providerInboundId)
        .maybeSingle()
      if (existing && (existing as { id?: string }).id) {
        const row = existing as { id: string; venue_id: string | null }
        return {
          ok: true,
          orphanId: row.id,
          venueId: row.venue_id,
          created: false,
          suggestionCount: 0,
        }
      }
    } catch (err) {
      log.warn({ err }, 'inbound.orphan.dedupe_read_failed')
    }
  }

  // 2. Try to infer a venue + surface suggestions.
  const inferred = await inferVenueAndSuggestions(input.normalized.fromEmail)
  const venueId = inferred.venueId
  const reasons = [...reasonsBase, ...inferred.reasons]

  // 3. Insert. Even if venueId is null we still record (platform
  //    orphan) — visible only via service role.
  try {
    const { data, error } = await supabase
      .from('inbound_email_orphans')
      .insert({
        venue_id: venueId,
        status: 'unresolved',
        provider: input.provider,
        provider_inbound_id: input.providerInboundId,
        provider_message_id: null,
        from_email: input.normalized.fromEmail,
        from_name: input.normalized.fromName,
        to_email: input.normalized.toEmail,
        subject: input.normalized.subject,
        stripped_body: input.normalized.cleanBody,
        raw_body_preview: input.normalized.rawPreview,
        received_at: input.receivedAtIso,
        match_confidence: input.matchConfidence,
        match_reasons: reasons,
        suggested_conversation_ids: inferred.suggestedConversationIds,
        suggested_lead_ids: inferred.suggestedLeadIds,
        metadata: {
          referenced_message_ids: input.normalized.referencedMessageIds,
        },
      })
      .select('id')
      .single()
    if (error) {
      // The unique-index race (very rare): another webhook call
      // for the same provider_inbound_id won the insert. Treat
      // as success.
      if (
        input.providerInboundId &&
        (error.message ?? '').toLowerCase().includes('duplicate')
      ) {
        const { data: existing } = await supabase
          .from('inbound_email_orphans')
          .select('id, venue_id')
          .eq('provider', input.provider)
          .eq('provider_inbound_id', input.providerInboundId)
          .maybeSingle()
        if (existing && (existing as { id?: string }).id) {
          const row = existing as { id: string; venue_id: string | null }
          return {
            ok: true,
            orphanId: row.id,
            venueId: row.venue_id,
            created: false,
            suggestionCount: inferred.suggestedConversationIds.length,
          }
        }
      }
      log.error(
        { errorMessage: error.message },
        'inbound.orphan.insert_failed'
      )
      return { ok: false, reason: 'insert_failed' }
    }
    const orphanId = (data as { id: string }).id
    return {
      ok: true,
      orphanId,
      venueId,
      created: true,
      suggestionCount: inferred.suggestedConversationIds.length,
    }
  } catch (err) {
    log.error({ err }, 'inbound.orphan.insert_threw')
    return { ok: false, reason: 'insert_failed' }
  }
}

// ─── Safe row shape exposed to UI/API ───────────────────────────────────

export interface InboundEmailOrphanRow {
  id: string
  status: 'unresolved' | 'linked' | 'dismissed' | 'ignored'
  from_email: string | null
  from_name: string | null
  subject: string | null
  body_preview: string
  received_at: string | null
  parsed_at: string
  match_confidence: number
  suggested_conversation_ids: string[]
  suggested_lead_ids: string[]
  linked_conversation_id: string | null
  linked_lead_id: string | null
  linked_message_id: string | null
  dismissed_at: string | null
  dismiss_reason: string | null
}

/**
 * Map a raw row to the UI-safe shape. Truncates stripped_body to
 * a UI-appropriate length and drops the raw provider preview.
 */
export function toSafeOrphanRow(raw: Record<string, unknown>): InboundEmailOrphanRow {
  const stripped =
    typeof raw.stripped_body === 'string' ? raw.stripped_body : ''
  const rawPreview =
    typeof raw.raw_body_preview === 'string' ? raw.raw_body_preview : ''
  const body = (stripped || rawPreview).slice(0, 280)
  return {
    id: raw.id as string,
    status: raw.status as InboundEmailOrphanRow['status'],
    from_email: (raw.from_email as string | null) ?? null,
    from_name: (raw.from_name as string | null) ?? null,
    subject: (raw.subject as string | null) ?? null,
    body_preview: body,
    received_at: (raw.received_at as string | null) ?? null,
    parsed_at: raw.parsed_at as string,
    match_confidence: (raw.match_confidence as number | null) ?? 0,
    suggested_conversation_ids:
      ((raw.suggested_conversation_ids as string[] | null) ?? []).slice(0, 5),
    suggested_lead_ids:
      ((raw.suggested_lead_ids as string[] | null) ?? []).slice(0, 5),
    linked_conversation_id: (raw.linked_conversation_id as string | null) ?? null,
    linked_lead_id: (raw.linked_lead_id as string | null) ?? null,
    linked_message_id: (raw.linked_message_id as string | null) ?? null,
    dismissed_at: (raw.dismissed_at as string | null) ?? null,
    dismiss_reason: (raw.dismiss_reason as string | null) ?? null,
  }
}
