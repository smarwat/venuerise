import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getJobsRuntime } from '@/lib/jobs/queue'
import { emailConfigured } from '@/lib/integrations/email'
import { getRateLimitStatus, type RateLimitStatus } from '@/lib/rate-limit'
import { log } from '@/lib/log'

/**
 * Health endpoint for uptime monitors.
 *
 * - Unauthenticated (so external pingers can hit it).
 * - Never leaks secrets — only coarse status strings.
 * - Never spends Anthropic tokens or Resend credits — provider checks are
 *   strictly configuration-presence, not live pings.
 * - Returns 200 unless Supabase is unreachable (then 503).
 */

type Status = 'ok' | 'configured' | 'missing' | 'down' | 'console-fallback'

interface HealthBody {
  ok: boolean
  supabase: Status
  anthropic: Status
  email: Status
  resend_webhook: 'configured' | 'missing'
  jobs: 'inngest' | 'local-fallback'
  upstash: RateLimitStatus
  uptime_ms: number
  ts: string
}

const startedAt = Date.now()

async function checkSupabase(): Promise<Status> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('venues')
      .select('id', { count: 'exact', head: true })
      .limit(1)
    if (error) {
      log.error({ errorMessage: error.message }, 'health.supabase.down')
      return 'down'
    }
    return 'ok'
  } catch (err) {
    log.error({ err }, 'health.supabase.threw')
    return 'down'
  }
}

function checkAnthropic(): Status {
  return process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing'
}

function checkEmail(): Status {
  // emailConfigured() is true only when BOTH api key AND from-email exist.
  if (emailConfigured()) return 'configured'
  // If the API key is present but no from-email, that's a misconfigured prod
  // and a half-broken dev — surface as 'missing' so the operator notices.
  if (process.env.RESEND_API_KEY && !process.env.RESEND_FROM_EMAIL) return 'missing'
  if (process.env.NODE_ENV === 'development') return 'console-fallback'
  return 'missing'
}

export async function GET() {
  const supabase = await checkSupabase()
  const anthropic = checkAnthropic()
  const email = checkEmail()
  const jobs = getJobsRuntime()
  const upstash = getRateLimitStatus()
  // Webhook health: env-presence only. We never call Resend's verifier here.
  const resend_webhook: 'configured' | 'missing' = process.env.RESEND_WEBHOOK_SECRET
    ? 'configured'
    : 'missing'

  const body: HealthBody = {
    ok: supabase !== 'down',
    supabase,
    anthropic,
    email,
    resend_webhook,
    jobs,
    upstash,
    uptime_ms: Date.now() - startedAt,
    ts: new Date().toISOString(),
  }

  return NextResponse.json(body, {
    status: body.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}
