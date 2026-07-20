// =============================================================================
// /api/admin/broadcast/revenue
//
// Returns "Money In" KPIs for the broadcast console header:
//   - tickets_total, tickets_30d   (WooCommerce, completed orders, after=2026)
//   - vendors_total, vendors_30d   (derived vendor stall fees for paid vendors
//                                   in the 2026 cycle)
//   - total_in, total_30d          (sum of both)
//
// Auth: mirrors /api/admin/sales (Law 2). 401 unauth, 403 non-admin.
// WC: getOrders() carries `after=` via lib/woocommerce.ts (Law 6).
//
// Payment state has NO columns in this Supabase (DDL blocked, Law 8). It lives
// in the ⟦PORTAL:..⟧ marker on admin_notes (parsePortalState), with the real
// paid_at column as a fallback paid signal and computeVendorPricing(row).total
// as the amount fallback. Selecting payment_status / payment_amount used to
// error the whole query, silently zeroing vendors_total — fixed here.
// =============================================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { getOrders } from '@/lib/woocommerce'

export const dynamic = 'force-dynamic'

const CYCLE_START = '2026-01-01T00:00:00Z'

interface VendorAppRow {
  admin_notes: string | null
  paid_at: string | null
  preferred_booth_tier: string | null
  special_requirements: unknown
  updated_at: string | null
  created_at: string | null
}

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: adminUser } = await supabase
      .from('admin_users').select().eq('id', user.id).single()
    if (!adminUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const admin = createAdminClient()
    const now = Date.now()
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000

    // Tickets (WooCommerce completed orders, 2026 cycle via Law 6 default).
    let tickets_total = 0
    let tickets_30d = 0
    let ticketError: string | undefined
    try {
      const orders = await getOrders({ status: 'completed' })
      for (const o of orders) {
        const amt = parseFloat(o.total) || 0
        tickets_total += amt
        const ts = Date.parse(o.date_created)
        if (!isNaN(ts) && ts >= thirtyDaysAgo) tickets_30d += amt
      }
    } catch (e) {
      ticketError = String(e)
      console.error('[admin/broadcast/revenue] WC fetch failed:', ticketError)
    }

    // Vendor revenue from vendor_applications (mirrors /api/admin/sales).
    const { data: appsRaw } = await admin
      .from('vendor_applications')
      .select('admin_notes, paid_at, preferred_booth_tier, special_requirements, updated_at, created_at')
    const apps: VendorAppRow[] = appsRaw || []

    let vendors_total = 0
    let vendors_30d = 0
    for (const a of apps) {
      // Derive paid + amount from REAL sources: marker status or paid_at column,
      // marker amount or the computed stall+electrical+hire total.
      const p = parsePortalState(a.admin_notes || '').payment || {}
      const paid = !!a.paid_at || p.status === 'paid'
      if (!paid) continue
      const amt = Number(p.amount ?? computeVendorPricing(a).total)
      if (!amt) continue
      // Restrict to the 2026 cycle so legacy paid rows do not double-count.
      const refTs = Date.parse(a.paid_at || a.updated_at || a.created_at || '')
      const cycleStartTs = Date.parse(CYCLE_START)
      if (isNaN(refTs) || refTs < cycleStartTs) continue
      vendors_total += amt
      if (refTs >= thirtyDaysAgo) vendors_30d += amt
    }

    return NextResponse.json({
      tickets_total: Math.round(tickets_total),
      tickets_30d: Math.round(tickets_30d),
      vendors_total: Math.round(vendors_total),
      vendors_30d: Math.round(vendors_30d),
      total_in: Math.round(tickets_total + vendors_total),
      total_30d: Math.round(tickets_30d + vendors_30d),
      ticket_error: ticketError,
    })
  } catch (error) {
    console.error('[admin/broadcast/revenue] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
