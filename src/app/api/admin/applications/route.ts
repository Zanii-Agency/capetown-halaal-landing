// Triage workbench queue feed.
// Returns a windowed slice of vendor_applications plus a total count, so the
// left-pane list can render "X to go" and Samreen can page through 450+ rows
// without loading them all at once.
//
// Query params:
//   ?status=pending,info_requested   comma-separated list, default 'pending'
//   ?include_superseded=1            include rows where is_duplicate=true
//   ?sector=food                     filter by sector column
//   ?tier=marquee-table-2x2          filter by preferred_booth_tier column
//   ?search=<q>                      ilike on business_name / contact_name / email / phone
//   ?limit=<int>                     default 100, max 500
//   ?offset=<int>                    default 0
//   ?order=oldest|newest|completeness  default 'oldest' (clear oldest backlog first)
//
// Response: { applications: VendorApplication[], total: number, pending_total: number }

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Escape user input before embedding in a Postgres ILIKE pattern.
// Mirror of /api/admin/search/route.ts:75 — must stay in sync.
function ilikeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m)
}

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
    const statusRaw = (searchParams.get('status') ?? 'pending').trim()
    const statuses = statusRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => ['pending', 'approved', 'rejected', 'info_requested'].includes(s))
    const includeSuperseded = searchParams.get('include_superseded') === '1'
    const sector = (searchParams.get('sector') ?? '').trim()
    const tier = (searchParams.get('tier') ?? '').trim()
    const search = (searchParams.get('search') ?? '').trim()
    const limitRaw = Number(searchParams.get('limit') ?? '100')
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500)
    const offsetRaw = Number(searchParams.get('offset') ?? '0')
    const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0)
    const order = (searchParams.get('order') ?? 'oldest') as 'oldest' | 'newest' | 'completeness'

    // Build the row query.
    let q = admin.from('vendor_applications').select('*', { count: 'exact' })
    if (statuses.length > 0) {
      q = q.in('status', statuses)
    }
    if (!includeSuperseded) {
      // is_duplicate column may be false OR null on legacy rows; treat null as "not duplicate"
      q = q.or('is_duplicate.is.null,is_duplicate.eq.false')
    }
    if (sector) {
      q = q.eq('sector', sector)
    }
    if (tier) {
      q = q.eq('preferred_booth_tier', tier)
    }
    if (search) {
      // Strip PostgREST filter delimiters (comma, parens) before escaping the
      // ILIKE wildcards; cap to 100 chars so an attacker cannot flood the OR clause.
      const safeSearch = ilikeEscape(search.slice(0, 100).replace(/[,()]/g, ' '))
      const pattern = `%${safeSearch}%`
      q = q.or(
        `business_name.ilike.${pattern},contact_name.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern}`
      )
    }
    if (order === 'newest') {
      q = q.order('created_at', { ascending: false })
    } else if (order === 'completeness') {
      q = q.order('completeness_score', { ascending: false, nullsFirst: false })
    } else {
      q = q.order('created_at', { ascending: true })
    }

    q = q.range(offset, offset + limit - 1)

    const { data, error, count } = await q
    if (error) {
      console.error('[admin/applications] query error:', error)
      return NextResponse.json({ error: 'Failed to fetch applications' }, { status: 500 })
    }

    // Separate canonical "pending counter" so the top-bar can show
    // "X to go" without re-querying when filters change.
    const { count: pendingTotal } = await admin
      .from('vendor_applications')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .or('is_duplicate.is.null,is_duplicate.eq.false')

    // Approved counter: drives the capacity view (approved of 308 total spaces,
    // remaining = 308 - approved). The festival has a fixed 308 spaces (243
    // marquee + 20 bedouin + 30 food/drink trucks + 10 dessert + 5 snack), so
    // "remaining" is the real number that matters, not a row-fetch cap.
    const { count: approvedTotal } = await admin
      .from('vendor_applications')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'approved')
      .or('is_duplicate.is.null,is_duplicate.eq.false')

    return NextResponse.json({
      applications: data ?? [],
      total: count ?? 0,
      pending_total: pendingTotal ?? 0,
      approved_total: approvedTotal ?? 0,
      limit,
      offset,
    })
  } catch (err) {
    console.error('[admin/applications] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
