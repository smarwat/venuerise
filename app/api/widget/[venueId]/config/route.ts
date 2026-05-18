import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = await params
  const supabase = createServiceClient()

  const { data: venue, error } = await supabase
    .from('venues')
    .select('name, description, ai_persona_name, style_tags, is_active')
    .eq('id', venueId)
    .eq('is_active', true)
    .single()

  if (error || !venue) {
    return NextResponse.json({ error: 'Venue not found' }, { status: 404 })
  }

  const venueData = venue as { name: string; description: string | null; ai_persona_name: string; style_tags: string[]; is_active: boolean }

  return NextResponse.json({
    name: venueData.name,
    persona_name: venueData.ai_persona_name,
    tagline: venueData.description ?? `Welcome to ${venueData.name}`,
    style_tags: venueData.style_tags,
  }, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, s-maxage=300',
    },
  })
}

export async function OPTIONS() {
  return new NextResponse(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
  })
}
