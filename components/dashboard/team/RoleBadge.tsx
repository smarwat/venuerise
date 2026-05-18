import { Badge } from '@/components/dashboard/ui/Badge'
import { roleLabel, type TeamRole } from './team-types'

/**
 * Phase 6E — tiny badge that maps a venue role to a label + an existing
 * Badge variant so we don't have to introduce new color tokens.
 *
 *   owner          → navy (strongest contrast)
 *   admin          → blue
 *   sales_manager  → blue (soft)
 *   coordinator    → default slate
 *   viewer         → default slate
 */

type Variant = React.ComponentProps<typeof Badge>['variant']

const ROLE_VARIANT: Record<TeamRole, Variant> = {
  owner: 'navy',
  admin: 'blue',
  sales_manager: 'blue',
  coordinator: 'default',
  viewer: 'default',
}

export function RoleBadge({ role }: { role: TeamRole }) {
  return <Badge variant={ROLE_VARIANT[role]}>{roleLabel(role)}</Badge>
}
