import TourStatusActivityFeedClient from './TourStatusActivityFeedClient'
import type { TourStatusEvent } from '@/components/dashboard/tours/tour-audit-types'

/**
 * Phase 8N → Phase 8O — thin server wrapper.
 *
 * The Phase 8N billing page fetches up to 25 `tour_status_events` rows
 * server-side and renders this component. Phase 8O introduces filter
 * controls, which need client state — but the data fetch is still
 * cleanest as a server-side service-role read. We keep the page →
 * server wrapper → client renderer split so:
 *
 *   - the page (Server Component) owns RLS-equivalent access control
 *     via `venue.role ∈ ADMIN_ROLES`,
 *   - the wrapper stays a typed seam if a future caller wants to
 *     inject pre-filtered events (tests, alternate pages),
 *   - the client component owns filter + presentation state only.
 *
 * No behavior is lost vs Phase 8N; the rendered table + empty state
 * shape match the previous component pixel-for-pixel for the
 * unfiltered case.
 */

interface TourStatusActivityFeedProps {
  events: TourStatusEvent[]
}

export default function TourStatusActivityFeed({
  events,
}: TourStatusActivityFeedProps) {
  return <TourStatusActivityFeedClient events={events} />
}
