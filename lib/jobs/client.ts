import 'server-only'
import { Inngest } from 'inngest'

/**
 * Inngest client — single instance for the entire app.
 *
 * Note on typing: Inngest 4.x reorganised its event-schema API. Rather than
 * thread the (still-evolving) types through every binding, we keep this
 * client untyped at the SDK boundary and enforce type safety one layer up
 * in `lib/jobs/queue.ts`, where every `.send()` is wrapped in a function
 * that takes a typed payload. The boundary is tiny and easy to audit.
 *
 * `server-only` because nothing here belongs in a browser bundle.
 */

export const inngest = new Inngest({
  id: 'venuerise',
  name: 'VenueRise',
  // eventKey/signingKey are picked up from env automatically.
})

/**
 * True if production-grade Inngest delivery is wired up.
 *
 * - In `next dev` the Inngest Dev Server doesn't need keys — but a developer
 *   only opts into that path by setting `INNGEST_DEV=1`. Without that flag,
 *   we prefer the in-process local fallback so a fresh `npm run dev` works
 *   with zero setup.
 * - In production we require both keys before trusting Inngest with traffic.
 */
export function inngestConfigured(): boolean {
  if (process.env.NODE_ENV === 'development') {
    return process.env.INNGEST_DEV === '1' || !!process.env.INNGEST_EVENT_KEY
  }
  return !!process.env.INNGEST_EVENT_KEY && !!process.env.INNGEST_SIGNING_KEY
}
