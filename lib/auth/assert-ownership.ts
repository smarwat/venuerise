import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getUserVenueRole } from '@/lib/auth/tenant-access'
import type { VenueRole } from '@/lib/auth/roles'

/**
 * Tenant ownership assertions (Phase 1; rewritten in Phase 6B).
 *
 * After migration 005 ("widen RLS to members"), the user-scoped Supabase
 * client can read any row whose `venue_id` the caller is a member of —
 * legacy owners included, because `venues: select for members or owner`
 * keeps the owner_user_id OR clause for backward compatibility.
 *
 * So a single user-scoped `select … where id = …` is now sufficient to
 * answer "can this user see this entity?". The pre-6B Path-B service-role
 * escape hatch is gone.
 *
 * NEW in 6B: optional `requiredRoles` parameter. When supplied, we look up
 * the caller's role on the entity's venue via `getUserVenueRole` and throw
 * `OwnershipError` if the role isn't allowed. That keeps the existence
 * boundary tight (callers see 404, not 403, so role denials don't leak
 * which leads/conversations belong to other tenants).
 *
 * On failure, throw `OwnershipError`; the route layer maps it to 404.
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

// ---------------------------------------------------------------------------
// Internal: gate the resolved entity on the caller's role for its venue.
// Throws OwnershipError if the caller's role isn't in `requiredRoles`.
// ---------------------------------------------------------------------------

async function assertRole(
  userId: string,
  venueId: string,
  requiredRoles: readonly VenueRole[] | undefined,
  entity: 'lead' | 'conversation' | 'follow_up'
): Promise<void> {
  if (!requiredRoles || requiredRoles.length === 0) return
  const access = await getUserVenueRole(userId, venueId)
  if (!access) throw new OwnershipError(entity)
  if (!(requiredRoles as readonly string[]).includes(access.role)) {
    throw new OwnershipError(entity)
  }
}

// ---------------------------------------------------------------------------
// assertOwnsLead
// ---------------------------------------------------------------------------

export async function assertOwnsLead(
  supabase: SupabaseClient,
  userId: string,
  leadId: string,
  requiredRoles?: readonly VenueRole[]
): Promise<LeadOwnership> {
  const { data } = await supabase
    .from('leads')
    .select('id, venue_id')
    .eq('id', leadId)
    .maybeSingle()

  if (!data) throw new OwnershipError('lead')
  const row = data as { id: string; venue_id: string }

  await assertRole(userId, row.venue_id, requiredRoles, 'lead')

  return { lead_id: row.id, venue_id: row.venue_id }
}

// ---------------------------------------------------------------------------
// assertOwnsConversation
// ---------------------------------------------------------------------------

export async function assertOwnsConversation(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string,
  requiredRoles?: readonly VenueRole[]
): Promise<ConversationOwnership> {
  const { data } = await supabase
    .from('conversations')
    .select('id, lead_id, venue_id')
    .eq('id', conversationId)
    .maybeSingle()

  if (!data) throw new OwnershipError('conversation')
  const row = data as { id: string; lead_id: string; venue_id: string }

  await assertRole(userId, row.venue_id, requiredRoles, 'conversation')

  return { conversation_id: row.id, lead_id: row.lead_id, venue_id: row.venue_id }
}

// ---------------------------------------------------------------------------
// assertOwnsFollowUp
// ---------------------------------------------------------------------------

export async function assertOwnsFollowUp(
  supabase: SupabaseClient,
  userId: string,
  followUpId: string,
  requiredRoles?: readonly VenueRole[]
): Promise<FollowUpOwnership> {
  const { data } = await supabase
    .from('follow_up_schedules')
    .select('id, lead_id, venue_id')
    .eq('id', followUpId)
    .maybeSingle()

  if (!data) throw new OwnershipError('follow_up')
  const row = data as { id: string; lead_id: string; venue_id: string }

  await assertRole(userId, row.venue_id, requiredRoles, 'follow_up')

  return { follow_up_id: row.id, lead_id: row.lead_id, venue_id: row.venue_id }
}
