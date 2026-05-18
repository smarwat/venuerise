import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'

const isDev = process.env.NODE_ENV === 'development'

/**
 * Phase 7A — origin allowlist applied to the widget config GET and the
 * matching CORS preflight. See app/api/widget/route.ts for the policy
 * rationale.
 *
 * CORS notes:
 *   - We echo the *exact* allowed origin back instead of `*` so credentials
 *     (if ever added) don't get downgraded silently.
 *   - Cache-Control is preserved (`s-maxage=300`) so CDNs still cache
 *     successful responses per-origin via the `Vary: Origin` header.
 */
function isOriginAllowed(request: Request): { allowed: boolean; origin: string | null } {
  const origin = request.headers.get('origin')
  if (!origin) return { allowed: true, origin: null }
  const trimmed = origin.trim().toLowerCase()
  if (trimmed === 'null') return { allowed: true, origin: null }
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim().toLowerCase()
  if (appUrl) {
    try {
      const appOrigin = new URL(appUrl).origin.toLowerCase()
      if (trimmed === appOrigin) return { allowed: true, origin: trimmed }
    } catch {
      // fall through
    }
  }
  if (isDev) {
    try {
      const u = new URL(trimmed)
      if (
        u.hostname === 'localhost' ||
        u.hostname === '127.0.0.1' ||
        u.hostname === '0.0.0.0'
      ) {
        return { allowed: true, origin: trimmed }
      }
    } catch {
      // fall through
    }
  }
  return { allowed: false, origin: trimmed }
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) {
    // No-origin request (curl/server-to-server) — no CORS headers needed.
    return {}
  }
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ venueId: string }> }) {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

  const originCheck = isOriginAllowed(request)
  if (!originCheck.allowed) {
    return respond(
      NextResponse.json({ error: 'origin_not_allowed' }, { status: 403 })
    )
  }

  const { venueId } = await params
  const supabase = createServiceClient()

  const { data: venue, error } = await supabase
    .from('venues')
    .select('name, description, ai_persona_name, style_tags, is_active')
    .eq('id', venueId)
    .eq('is_active', true)
    .single()

  if (error || !venue) {
    return respond(NextResponse.json({ error: 'Venue not found' }, { status: 404 }))
  }

  const venueData = venue as {
    name: string
    description: string | null
    ai_persona_name: string
    style_tags: string[]
    is_active: boolean
  }

  return respond(
    NextResponse.json(
      {
        name: venueData.name,
        persona_name: venueData.ai_persona_name,
        tagline: venueData.description ?? `Welcome to ${venueData.name}`,
        style_tags: venueData.style_tags,
      },
      {
        headers: {
          ...corsHeaders(originCheck.origin),
          'Cache-Control': 'public, s-maxage=300',
        },
      }
    )
  )
}

export async function OPTIONS(request: Request) {
  const requestId = getOrCreateRequestId(request)
  const originCheck = isOriginAllowed(request)
  if (!originCheck.allowed) {
    return withRequestIdHeader(
      new NextResponse(null, { status: 403 }),
      requestId
    )
  }
  return withRequestIdHeader(
    new NextResponse(null, {
      headers: {
        ...corsHeaders(originCheck.origin),
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Max-Age': '86400',
      },
    }),
    requestId
  )
}
