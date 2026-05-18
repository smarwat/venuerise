import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'

export async function GET(request: NextRequest, { params }: { params: Promise<{ venueId: string }> }) {
  const requestId = getOrCreateRequestId(request)
  const respond = <T extends Response>(r: T) => withRequestIdHeader(r, requestId)

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

  const venueData = venue as { name: string; description: string | null; ai_persona_name: string; style_tags: string[]; is_active: boolean }

  return respond(NextResponse.json({
    name: venueData.name,
    persona_name: venueData.ai_persona_name,
    tagline: venueData.description ?? `Welcome to ${venueData.name}`,
    style_tags: venueData.style_tags,
  }, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, s-maxage=300',
    },
  }))
}

export async function OPTIONS(request: Request) {
  const requestId = getOrCreateRequestId(request)
  return withRequestIdHeader(
    new NextResponse(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    }),
    requestId
  )
}
