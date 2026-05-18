import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import { VENUE_ROLES, type VenueRole } from './roles'

/**
 * Tenant access primitives (Phase 6A).
 *
 * These helpers are the canonical way for server-side code to ask:
 *   - Who is the caller?
 *   - Which venue are they working in?
 *   - Do they have permission to do X?
 *
 * Storage model (after migration 004):
 *   - `venue_members(venue_id, user_id, role)` is the source of truth.
 *   - `venues.owner_user_id` is kept as legacy for one-membership-row-per-owner
 *     fallback so anything pre-migration still works.
 *
 * Errors thrown by `require*` helpers:
 *
 *   try {
 *     const { userId } = await requireUser()
 *     await requireVenueRole(userId, venueId, ADMIN_ROLES)
 *   } catch (err) {
 *     if (err instanceof TenantAccessError) {
 *       return NextResponse.json({ error: err.code }, { status: err.status })
 *     }
 *     throw err
 *   }
 *
 * `server-only` because these helpers reach for service-role access on the
 * fallback path; they must never load in a client bundle.
 */

// ============================================================================
// Errors
// ============================================================================

export type TenantAccessCode =
  | 'unauthorized'   // 401 — no session
  | 'forbidden'      // 403 — authenticated but not a member / wrong role
  | 'no_venue'      // 404 — user has no venue at all (no membership, no legacy)

export class TenantAccessError extends Error {
  constructor(
    public readonly status: 401 | 403 | 404,
    public readonly code: TenantAccessCode
  ) {
    super(code)
    this.name = 'TenantAccessError'
  }
}

// ============================================================================
// requireUser
// ============================================================================

export interface CurrentUser {
  userId: string
  email: string | null
}

export async function requireUser(): Promise<CurrentUser> {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) {
    throw new TenantAccessError(401, 'unauthorized')
  }
  return { userId: user.id, email: user.email ?? null }
}

// ============================================================================
// getCurrentVenueForUser
// ============================================================================

export interface UserVenue {
  venueId: string
  role: VenueRole
  /** True iff the row was derived from the legacy owner_user_id column. */
  legacy: boolean
}

/**
 * Returns the first venue the user can access. Prefers `venue_members`;
 * falls back to `venues.owner_user_id` for backward compatibility with
 * any venue created before migration 004 ran (and not yet seeded).
 *
 * Returns `null` if the user has no access to any venue.
 */
export async function getCurrentVenueForUser(userId: string): Promise<UserVenue | null> {
  const supabase = await createClient()

  // Path A — preferred: venue_members
  const { data: memberRow } = await supabase
    .from('venue_members')
    .select('venue_id, role')
    .eq('user_id', userId)
    .order('created_at')
    .limit(1)
    .maybeSingle()

  if (memberRow) {
    const row = memberRow as { venue_id: string; role: VenueRole }
    return { venueId: row.venue_id, role: row.role, legacy: false }
  }

  // Path B — legacy fallback: venues.owner_user_id
  // Uses service role because the user-scoped query above already failed for
  // this user under the venues RLS policy. The legacy fallback is a narrow
  // existence check; we don't return any other venue data.
  const svc = createServiceClient()
  const { data: legacyVenue } = await svc
    .from('venues')
    .select('id')
    .eq('owner_user_id', userId)
    .order('created_at')
    .limit(1)
    .maybeSingle()

  if (legacyVenue) {
    log.warn(
      { userId },
      'tenant_access.legacy_owner_fallback'
    )
    return { venueId: (legacyVenue as { id: string }).id, role: 'owner', legacy: true }
  }

  return null
}

// ============================================================================
// requireVenueAccess
// ============================================================================

/**
 * Throws unless `userId` is a member of `venueId` (or legacy owner of it).
 * Returns the user's role on success.
 *
 * Important: this does NOT reveal whether the venue exists when access is
 * denied — both "venue doesn't exist" and "venue exists but user isn't a
 * member" raise the same `forbidden` error.
 */
export async function requireVenueAccess(
  userId: string,
  venueId: string
): Promise<{ role: VenueRole; legacy: boolean }> {
  const role = await getUserVenueRole(userId, venueId)
  if (!role) {
    throw new TenantAccessError(403, 'forbidden')
  }
  return role
}

// ============================================================================
// requireVenueRole
// ============================================================================

export async function requireVenueRole(
  userId: string,
  venueId: string,
  allowedRoles: readonly VenueRole[]
): Promise<{ role: VenueRole; legacy: boolean }> {
  const access = await requireVenueAccess(userId, venueId)
  if (!allowedRoles.includes(access.role)) {
    throw new TenantAccessError(403, 'forbidden')
  }
  return access
}

// ============================================================================
// getUserVenueRole
// ============================================================================

/**
 * Returns the user's role for the given venue, or `null` if they have no
 * access. Membership takes precedence over the legacy owner_user_id column;
 * if neither matches, returns null.
 */
export async function getUserVenueRole(
  userId: string,
  venueId: string
): Promise<{ role: VenueRole; legacy: boolean } | null> {
  const supabase = await createClient()

  // Membership path — uses the user-scoped client, RLS allows users to
  // read their own membership rows (see "venue_members: select for venue
  // members" policy in migration 004).
  const { data: memberRow } = await supabase
    .from('venue_members')
    .select('role')
    .eq('venue_id', venueId)
    .eq('user_id', userId)
    .maybeSingle()

  if (memberRow) {
    const role = (memberRow as { role: string }).role
    if (isVenueRoleString(role)) {
      return { role, legacy: false }
    }
  }

  // Legacy fallback — service role for one tightly-scoped existence check.
  const svc = createServiceClient()
  const { data: ownerRow } = await svc
    .from('venues')
    .select('id')
    .eq('id', venueId)
    .eq('owner_user_id', userId)
    .maybeSingle()

  if (ownerRow) {
    return { role: 'owner', legacy: true }
  }

  return null
}

function isVenueRoleString(s: string): s is VenueRole {
  return (VENUE_ROLES as readonly string[]).includes(s)
}
