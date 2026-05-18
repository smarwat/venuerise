import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getJobsRuntime } from '@/lib/jobs/queue'

/**
 * Health endpoint for uptime monitors and the next-up `/api/health` probes.
 *
 * - Unauthenticated by design (so external monitors can hit it).
 * - Never leaks secrets — only coarse status strings.
 * - Anthropic check is `configured | missing` — we never spend tokens here.
 * - Returns 200 unless Supabase is unreachable (then 503).
 */

type Status = 'ok' | 'configured' | 'missing' | 'down'

interface HealthBody {
  ok: boolean
  supabase: Status
  anthropic: Status
  jobs: 'inngest' | 'local-fallback'
  uptime_ms: number
  ts: string
}

const startedAt = Date.now()

async function checkSupabase(): Promise<Status> {
  try {
    const supabase = createServiceClient()
    // `head: true` + `count: 'exact'` issues a lightweight HEAD request —
    // no row payload returned. Targets `venues` since it always exists.
    const { error } = await supabase
      .from('venues')
      .select('id', { count: 'exact', head: true })
      .limit(1)
    if (error) {
      console.error('[health] supabase probe error:', error.message)
      return 'down'
    }
    return 'ok'
  } catch (err) {
    console.error('[health] supabase probe threw:', err)
    return 'down'
  }
}

function checkAnthropic(): Status {
  // Intentionally does NOT call the API — that costs tokens. A "ping" of
  // the Messages API would be billable. Configured-presence is the right
  // health signal until we add a real budget-aware probe.
  return process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing'
}

export async function GET() {
  const supabase = await checkSupabase()
  const anthropic = checkAnthropic()
  const jobs = getJobsRuntime()

  const body: HealthBody = {
    ok: supabase !== 'down',
    supabase,
    anthropic,
    jobs,
    uptime_ms: Date.now() - startedAt,
    ts: new Date().toISOString(),
  }

  return NextResponse.json(body, {
    status: body.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}
