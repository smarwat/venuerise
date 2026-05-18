/**
 * Venue role constants (Phase 6A).
 *
 * Single source of truth for role names. The same five strings live in:
 *   - `venue_members.role` CHECK constraint (migration 004)
 *   - `venue_invitations.role` CHECK constraint (migration 004)
 *   - `has_venue_role()` SECURITY DEFINER function (migration 004)
 *
 * If you change the role list, change the migration first and regenerate
 * `types/database.ts` so TypeScript stays in lockstep.
 *
 * This module is intentionally tiny and dependency-free so it's safe to
 * import from anywhere (server OR client).
 */

export const VENUE_ROLES = [
  'owner',
  'admin',
  'sales_manager',
  'coordinator',
  'viewer',
] as const

export type VenueRole = (typeof VENUE_ROLES)[number]

// ---- Permission groups -----------------------------------------------------
//
// Use these instead of hardcoding `['owner', 'admin']` inline so future
// additions (e.g. `'finance'`) update one place.

/** Can manage members, billing, venue settings. */
export const ADMIN_ROLES = ['owner', 'admin'] as const

/** Can CRUD leads/conversations/tours and trigger AI actions. */
export const SALES_ROLES = ['owner', 'admin', 'sales_manager', 'coordinator'] as const

/** Read-only or higher — every role currently in the system. */
export const READONLY_ROLES = [
  'owner',
  'admin',
  'sales_manager',
  'coordinator',
  'viewer',
] as const

// ---- Predicates ------------------------------------------------------------

export function isVenueRole(value: unknown): value is VenueRole {
  return typeof value === 'string' && (VENUE_ROLES as readonly string[]).includes(value)
}

export function isAdminRole(role: VenueRole): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role)
}
