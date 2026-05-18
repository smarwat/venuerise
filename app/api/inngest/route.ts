import { serve } from 'inngest/next'
import { inngest } from '@/lib/jobs/client'
import { allJobFunctions } from '@/lib/jobs/functions'

/**
 * Inngest serve endpoint.
 *
 * - In `next dev`: the Inngest Dev Server (run separately with
 *   `npx inngest-cli@latest dev`) auto-discovers this endpoint and runs
 *   event/cron functions locally — no INNGEST_EVENT_KEY needed in dev.
 *
 * - In production: requires `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY`
 *   set in the deployment environment. Inngest cloud invokes this URL.
 *
 * The handler is safe to leave wired even if Inngest isn't configured —
 * it simply won't receive any events.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: allJobFunctions,
})
