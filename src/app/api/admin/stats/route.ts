import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function GET() {
  try {
    const supabase = await createClient()

    // Check auth
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check admin
    const admin = createAdminClient()
    const { data: adminUser } = await admin
      .from('admin_users')
      .select()
      .eq('id', user.id)
      .single()

    if (!adminUser) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Booth tier price map for revenue estimation
    const TIER_PRICES: Record<string, number> = {
      'marquee-table-2x2': 3700,
      'marquee-full-3x3': 6500,
      'marquee-table-double-4x2': 6500,
      'marquee-full-double-6x3': 12000,
      'outdoor-bedouin-2x3': 3750,
      'food-gazebo-3x3': 4800,
      'mini-dessert-truck-3.5m': 5000,
      'food-truck-4.5m': 6500,
      'food-truck-6m': 7500,
      'food-truck-8m': 8500,
    }

    // 1. Status counts via 5 parallel head:count queries (no row payload).
    //    Used to pull the full table on every 60s timer.
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)

    const [total, approved_r, pending_r, infoReq_r, rejected_r, recent_r] = await Promise.all([
      admin.from('vendor_applications').select('*', { count: 'exact', head: true }),
      admin.from('vendor_applications').select('*', { count: 'exact', head: true }).eq('status', 'approved'),
      admin.from('vendor_applications').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      admin.from('vendor_applications').select('*', { count: 'exact', head: true }).eq('status', 'info_requested'),
      admin.from('vendor_applications').select('*', { count: 'exact', head: true }).eq('status', 'rejected'),
      admin.from('vendor_applications').select('*', { count: 'exact', head: true }).gte('created_at', weekAgo.toISOString()),
    ])

    const total_apps = total.count ?? 0
    const approved = approved_r.count ?? 0
    const pending = pending_r.count ?? 0
    const rejected = rejected_r.count ?? 0
    const info_requested = infoReq_r.count ?? 0
    const recentCount = recent_r.count ?? 0

    // Existing shape kept for dashboard back-compat; `total` is total application count (not approved vendors).
    const stats = {
      total: total_apps,
      pending,
      approved,
      rejected,
      info_requested,
    }

    // 2. Revenue + categories need row payloads, but only for non-rejected
    //    applications. admin_notes + paid_at are needed to scope the rows to
    //    the viewer; master-lane vendors must not inflate the owner's dashboard.
    const { data: nonRejectedApps } = await admin
      .from('vendor_applications')
      .select('preferred_booth_tier, special_requirements, product_categories, admin_notes, paid_at')
      .neq('status', 'rejected')

    let estimatedRevenue = 0
    const categoryBreakdown: Record<string, number> = {}
    for (const app of (nonRejectedApps || [])) {
      const tier = app.preferred_booth_tier || ''
      estimatedRevenue += TIER_PRICES[tier] || 0

      // Try to get stall_price from special_requirements JSON
      if (!TIER_PRICES[tier] && app.special_requirements) {
        try {
          const sr = JSON.parse(app.special_requirements)
          if (sr.stall_price) estimatedRevenue += Number(sr.stall_price) || 0
        } catch {}
      }

      // Category breakdown
      const cats = app.product_categories || []
      for (const cat of cats) {
        categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1
      }
    }

    // Clean application-pipeline counts, exposed alongside the legacy `stats` block.
    const applicationStats = {
      total_apps,
      approved,
      pending,
      rejected,
      info_requested,
    }

    return NextResponse.json({
      stats,
      applicationStats,
      recentCount,
      estimatedRevenue,
      categoryBreakdown,
    })
  } catch (error) {
    console.error('Stats error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
