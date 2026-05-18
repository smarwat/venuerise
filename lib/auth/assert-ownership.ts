import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Tenant ownership assertions.
 *
 * Every /api/ai/* route accepts an ID from the request body. RLS protects
 * `select`/`update` from RLS-aware clients, but our orchestrator runs under
 * the service-role client (bypasses RLS) — so application-level ownership
 * checks are mandatory before handing an ID to the orchestrator.
 *
 * These helpers run under the user-scoped client (`createClient` from
 * lib/supabase/server.ts), which means RLS itself doubles as defense in
 * depth — a user without access will simply see zero rows.
 *
 * On failure, throw `OwnershipError` which the route layer maps to 404 to
 * avoid disclosing existence.
 */

export class OwnershipError extends Error {
  constructor(public readonly entity: 'lead' | 'conversation' | 'follow_up') {
    super(`Not found or not owned: ${entity}`)
    this.name = 'OwnershipError'
  }
}

interface LeadOwnership {
  lead_id: string
  venue_id: string
}

interface ConversationOwnership {
  conversation_id: string
  lead_id: string
  venue_id: string
}

interface FollowUpOwnership {
  follow_up_id: string
  lead_id: string
  venue_id: string
}

/**
 * Verify the user (via venue ownership) owns the given lead.
 * Returns the lead+venue identifiers on success.
 */
export async function assertOwnsLead(
  supabase: SupabaseClient,
  userId: string,
  leadId: string
): Promise<LeadOwnership> {
  // Join through venues.owner_user_id. With RLS active on both tables, a
  // non-owner sees zero rows.
  const { data, error } = await supabase
    .from('leads')
    .select('id, venue_id, venues!inner(owner_user_id)')
    .eq('id', leadId)
    .eq('venues.owner_user_id', userId)
    .maybeSingle()

  if (error || !data) throw new OwnershipError('lead')
  const row = data as { id: string; venue_id: string }
  return { lead_id: row.id, venue_id: row.venue_id }
}

export async function assertOwnsConversation(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string
): Promise<ConversationOwnership> {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, lead_id, venue_id, venues!inner(owner_user_id)')
    .eq('id', conversationId)
    .eq('venues.owner_user_id', userId)
    .maybeSingle()

  if (error || !data) throw new OwnershipError('conversation')
  const row = data as { id: string; lead_id: string; venue_id: string }
  return { conversation_id: row.id, lead_id: row.lead_id, venue_id: row.venue_id }
}

export async function assertOwnsFollowUp(
  supabase: SupabaseClient,
  userId: string,
  followUpId: string
): Promise<FollowUpOwnership> {
  const { data, error } = await supabase
    .from('follow_up_schedules')
    .select('id, lead_id, venue_id, venues!inner(owner_user_id)')
    .eq('id', followUpId)
    .eq('venues.owner_user_id', userId)
    .maybeSingle()

  if (error || !data) throw new OwnershipError('follow_up')
  const row = data as { id: string; lead_id: string; venue_id: string }
  return { follow_up_id: row.id, lead_id: row.lead_id, venue_id: row.venue_id }
}
