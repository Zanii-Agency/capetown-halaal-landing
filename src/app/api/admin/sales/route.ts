import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { getTicketStats } from '@/lib/woocommerce'

export const dynamic = 'force-dynamic'

// Consolidated sales endpoint. Booth revenue is derived from the live
// vendor_applications table. Payment status / amount / due do NOT exist as
// columns in this Supabase (DDL blocked, Law 8); they live in the ⟦PORTAL:..⟧
// marker on admin_notes (parsePortalState) with the real paid_at column as a
// fallback signal, and the amount falls back to computeVendorPricing(row).total.
// Ticket revenue comes from the same WooCommerce source /api/admin/tickets uses.
// (Previously this read phantom booth_bookings / ticket_sales tables that exist
// in no migration, so it always returned zeros — fixed 2026-06-04.)

// Derive payment facts for a vendor row from REAL sources only.
function deriveVendorPayment(a: { admin_notes?: string | null; paid_at?: string | null; preferred_booth_tier?: string | null; special_requirements?: unknown }) {
  const p = parsePortalState(a.admin_notes || '').payment || {}
  const paid = !!a.paid_at || p.status === 'paid'
  const status = p.status ?? (a.paid_at ? 'paid' : 'none')
  const amount = p.amount ?? computeVendorPricing(a).total
  return { paid, status, amount }
}
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: adminUser } = await supabase.from('admin_users').select().eq('id', user.id).single()
    if (!adminUser) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const admin = createAdminClient()

    // Vendor applications are the source of truth for booth/vendor pipeline + fees.
    const { data: applications } = await admin
      .from('vendor_applications')
      .select('*')
      .order('created_at', { ascending: false })

    const apps = applications || []
    // Derive payment facts per row from the portal marker + real paid_at column.
    const derived = apps.map(a => ({ app: a, pay: deriveVendorPayment(a) }))
    const paidBooths = derived.filter(d => d.pay.paid)
    const boothRevenue = paidBooths.reduce((sum, d) => sum + Number(d.pay.amount || 0), 0)
    const deferredBooths = derived.filter(d => !d.pay.paid && d.pay.status === 'deferred')

    // Tickets come from WooCommerce (best-effort; never fail the whole report on it).
    let ticketRevenue = 0
    let totalTicketsSold = 0
    let ticketError: string | undefined
    try {
      const wc = await getTicketStats()
      ticketRevenue = wc.totalRevenue || 0
      totalTicketsSold = wc.totalTickets || 0
    } catch (e) {
      ticketError = String(e)
      console.error('[admin/sales] WooCommerce fetch failed:', ticketError)
    }

    return NextResponse.json({
      stats: {
        totalApplications: apps.length,
        pendingApplications: apps.filter(a => a.status === 'pending').length,
        approvedApplications: apps.filter(a => a.status === 'approved').length,
        rejectedApplications: apps.filter(a => a.status === 'rejected').length,
        paidBooths: paidBooths.length,
        deferredBooths: deferredBooths.length,
        boothRevenue,
        totalTicketsSold,
        ticketRevenue,
        totalRevenue: boothRevenue + ticketRevenue,
      },
      applications: apps,
      ticketError,
    })
  } catch (error) {
    console.error('Admin sales error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
