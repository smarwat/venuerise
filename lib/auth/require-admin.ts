import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { log } from '@/lib/log'
import type { VenueRole } from './roles'

/**
 * Admin auth gate.
 *
 * After Phase 6A, "admin" = user has role 'owner' OR 'admin' in
 * `venue_members` for some venue. We pick the first such venue (by
 * created_at) so the same caller always lands on the same admin context
 * in a single-venue setup.
 *
 * Backward compatibility: if a user has NO membership row but DOES own a
 * venue via the legacy `venues.owner_user_id` column, we still grant access
 * with role='owner' and log a warning so the operator can backfill the
 * missing seed.
 *
 * Returns a discriminated union — call sites stay clean:
 *
 *   const admin = await requireAdmin()
 *   if (!admin.ok) {
 *     return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
 *   }
 *   const { user, venueId, role } = admin
 *
 * `server-only` so an accidental client import fails the build.
 */

export type AdminCheckResult =
  | {
      ok: true
      user: { id: string; email: string | null }
      venueId: string
      role: VenueRole
    }
  | {
      ok: false
      status: 401 | 403
      code: 'unauthorized' | 'no_venue'
    }

export async function requireAdmin(): Promise<AdminCheckResult> {
  const supabase = await createClient()

  // 1. Authenticated?
  const { data: { user }, error: userErr } = await supabase.auth.getUser()
  if (userErr || !user) {
    return { ok: false, status: 401, code: 'unauthorized' }
  }

  // 2. Membership path — preferred. Uses the user-scoped client so RLS
  //    doubles as defense in depth.
  const { data: memberRow } = await supabase
    .from('venue_members')
    .select('venue_id, role')
    .eq('user_id', user.id)
    .in('role', ['owner', 'admin'])
    .order('created_at')
    .limit(1)
    .maybeSingle()

  if (memberRow) {
    const row = memberRow as { venue_id: string; role: VenueRole }
    return {
      ok: true,
      user: { id: user.id, email: user.email ?? null },
      venueId: row.venue_id,
      role: row.role,
    }
  }

  // 3. Legacy fallback — venues.owner_user_id. Pre-migration-004 venues
  //    might exist if anything bypassed the seed; treat them as 'owner'.
  //    Uses service role because the RLS chain for venues now expects
  //    membership; the legacy owner_user_id path can't see through it.
  const svc = createServiceClient()
  const { data: legacyVenue } = await svc
    .from('venues')
    .select('id')
    .eq('owner_user_id', user.id)
    .order('created_at')
    .limit(1)
    .maybeSingle()

  if (legacyVenue) {
    log.warn(
      { userId: user.id },
      'require_admin.legacy_owner_fallback'
    )
    return {
      ok: true,
      user: { id: user.id, email: user.email ?? null },
      venueId: (legacyVenue as { id: string }).id,
      role: 'owner',
    }
  }

  return { ok: false, status: 403, code: 'no_venue' }
}
