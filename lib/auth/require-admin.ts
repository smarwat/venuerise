import 'server-only'
import { createClient } from '@/lib/supabase/server'

/**
 * Admin auth gate (Phase 5E).
 *
 * "Admin" today = "venue owner". We don't have a `venue_members` table or
 * a roles system yet, so the founder/operator authenticates as the venue
 * owner and gets access to the `/api/admin/*` surface.
 *
 * Returns a discriminated union so call sites stay clean:
 *
 *   const admin = await requireAdmin()
 *   if (!admin.ok) {
 *     return respond(NextResponse.json({ error: admin.code }, { status: admin.status }))
 *   }
 *   const { user, venueId } = admin
 *
 * Uses the user-scoped Supabase client — RLS doubles as defense in depth.
 * Never reaches for the service-role client.
 *
 * Marked `server-only` so a leaked import in a client component fails the
 * build instead of running silently.
 */

export type AdminCheckResult =
  | {
      ok: true
      user: { id: string; email: string | null }
      venueId: string
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

  // 2. Owns at least one venue? Use the user-scoped client so RLS catches a
  //    misconfigured setup; first-row-wins matches the rest of the app
  //    (see Phase 0 duplicate-venue fix).
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id')
    .eq('owner_user_id', user.id)
    .order('created_at')
    .limit(1)
    .maybeSingle()

  const venueId = (venueRow as { id?: string } | null)?.id
  if (!venueId) {
    return { ok: false, status: 403, code: 'no_venue' }
  }

  return {
    ok: true,
    user: { id: user.id, email: user.email ?? null },
    venueId,
  }
}
