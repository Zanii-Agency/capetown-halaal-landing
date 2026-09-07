// GET owner-safe day digest. ?date=YYYY-MM-DD (default today, SAST). Viewer-walled.
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadDayDigest } from '@/lib/day-digest'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const date = new URL(req.url).searchParams.get('date') || undefined
  return NextResponse.json(await loadDayDigest(date))
}
