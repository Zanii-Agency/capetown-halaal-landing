// Fetch audit-log events for a single vendor application.
// Wired into the right-rail detail view on /admin/applications so Samreen
// can see who approved / rejected / tagged / superseded a row and when.
//
// Query params:
//   ?application_id=<uuid>   required, the row whose log we want
//   ?limit=<int>             optional, default 50, max 200

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { laneScopeFor } from '@/lib/inbox-lane'
import { hiddenFromOwner } from '@/lib/audit-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const admin = createAdminClient()
    const { data: adminUser } = await admin
      .from('admin_users')
      .select('id')
      .eq('id', user.id)
      .single()
    if (!adminUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const applicationId = searchParams.get('application_id')
    if (!applicationId) {
      return NextResponse.json({ error: 'application_id required' }, { status: 400 })
    }
    const rawLimit = Number(searchParams.get('limit') ?? '50')
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 200)

    const scope = await laneScopeFor(user.email)
    if (scope.blocksApplicationId(applicationId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data, error } = await admin
      .from('vendor_application_events')
      .select('id, application_id, event_type, before_value, after_value, actor_email, actor_role, note, created_at')
      .eq('application_id', applicationId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('[events] query error:', error)
      return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 })
    }

    const events = ((data ?? []) as Array<{
      id: string
      application_id: string
      event_type: string
      before_value: unknown
      after_value: unknown
      actor_email: string | null
      actor_role: string | null
      note: string | null
      created_at: string
    }>).filter((e) =>
      !hiddenFromOwner(
        { event_type: e.event_type, note: e.note, before_value: e.before_value, after_value: e.after_value },
        true,
      ),
    )

    return NextResponse.json({ events })
  } catch (err) {
    console.error('[events] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
