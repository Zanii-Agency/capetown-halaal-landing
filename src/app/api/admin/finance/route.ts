import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { getOrders, type WCOrder } from '@/lib/woocommerce'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PaymentRow {
  id: string
  business_name: string | null
  contact_name: string | null
  email: string | null
  phone: string | null
  status: string | null
  admin_notes: string | null
  paid_at: string | null
  preferred_booth_tier: string | null
  special_requirements: unknown
  created_at: string
}

export async function GET(req: NextRequest) {
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

    const { searchParams } = new URL(req.url)
    const paymentFilter = (searchParams.get('payment') || '').trim()

    // IMPORTANT: payment_status / payment_amount / payment_due_date / paid_at do
    // NOT exist as columns in this Supabase (DDL is blocked, different account,
    // Law 8). Payment state lives in the ⟦PORTAL:..⟧ marker on admin_notes
    // (parsePortalState). Selecting the phantom columns 500'd the whole route —
    // which is why /admin/finance rendered empty. We select only real columns,
    // read payment from portal_state below, and apply the payment filter in-code.
    const { data: vendors, error } = await admin
      .from('vendor_applications')
      .select('id, business_name, contact_name, email, phone, status, admin_notes, paid_at, preferred_booth_tier, special_requirements, created_at')
      .in('status', ['approved', 'pending', 'info_requested'])
      .order('business_name', { ascending: true })
    if (error) {
      console.error('[admin/finance] query error:', error)
      return NextResponse.json({ error: 'Failed to fetch vendors' }, { status: 500 })
    }

    const rows = (vendors ?? []) as PaymentRow[]

    // Payment state comes ONLY from portal_state (the phantom columns don't
    // exist — see the query note above).
    const payments = rows.map((v) => {
      const portal = parsePortalState(v.admin_notes || '')
      const p = portal.payment || {}

      // Derived from REAL sources only (no phantom columns). isPaid mirrors the
      // exhibitor-paygate rule: the real paid_at column OR a marker status of
      // 'paid'. amount prefers the marker, else the computed stall+electrical+
      // hire total. due/paid_at come from the marker, paid_at falls back to the
      // real column.
      const isPaid = !!v.paid_at || p.status === 'paid'
      const paidAt = p.paid_at || v.paid_at || null
      const amount = p.amount ?? computeVendorPricing(v).total
      const dueDate = p.due || null
      const paymentStatus = p.status ?? (v.paid_at ? 'paid' : 'none')

      let overdue = false
      if (paymentStatus === 'pending' && dueDate) {
        overdue = new Date(dueDate) < new Date()
      }

      return {
        id: v.id,
        business_name: v.business_name || 'Unnamed',
        contact_name: v.contact_name,
        email: v.email,
        phone: v.phone,
        status: v.status,
        payment_status: isPaid ? 'paid' : paymentStatus,
        payment_amount: amount,
        payment_due_date: dueDate,
        paid_at: paidAt,
        is_paid: isPaid,
        preferred_booth_tier: v.preferred_booth_tier,
        created_at: v.created_at,
        overdue,
      }
    })

    // Stats
    const totalPaid = payments.filter(p => p.is_paid).length
    const totalPending = payments.filter(p => !p.is_paid && (p.payment_status === 'pending' || p.payment_status === 'deferred')).length
    const totalNone = payments.filter(p => !p.is_paid && p.payment_status === 'none').length
    const totalOverdue = payments.filter(p => p.overdue).length
    const totalRevenue = payments
      .filter(p => p.is_paid)
      .reduce((sum, p) => sum + (p.payment_amount || 0), 0)

    // WooCommerce reconciliation: fetch completed orders for comparison
    let wcOrders: WCOrder[] = []
    try {
      wcOrders = await getOrders({ status: 'completed' })
    } catch (err) {
      console.warn('[admin/finance] WC fetch failed:', err)
    }

    // Ticket revenue (WC = source of truth, Law 4) + combined money-in so the
    // page tracks vendor stall fees AND ticket sales together.
    const ticketRevenue = wcOrders.reduce((s, o) => s + parseFloat(o.total || '0'), 0)
    const ticketOrders = wcOrders.length
    const totalMoneyIn = totalRevenue + ticketRevenue

    // Match WC orders to vendors by email
    const wcMatched = payments
      .filter(p => p.email)
      .map(p => {
        const matches = wcOrders.filter(o =>
          o.billing?.email?.toLowerCase() === p.email?.toLowerCase()
        )
        const totalWc = matches.reduce((s, o) => s + parseFloat(o.total || '0'), 0)
        return {
          vendor_id: p.id,
          business_name: p.business_name,
          email: p.email,
          payment_status: p.payment_status,
          vendor_amount: p.payment_amount,
          wc_order_count: matches.length,
          wc_total: totalWc,
          reconciled: p.is_paid && totalWc > 0,
        }
      })

    const unmatchedWc = wcOrders
      .filter(o => {
        const email = o.billing?.email?.toLowerCase()
        return !email || !payments.some(p => p.email?.toLowerCase() === email)
      })
      .map(o => ({
        order_id: o.id,
        name: `${o.billing?.first_name || ''} ${o.billing?.last_name || ''}`.trim(),
        email: o.billing?.email,
        total: o.total,
        date: o.date_created,
      }))

    // Apply the payment filter in-code (the DB can't filter a marker).
    const list = !paymentFilter ? payments : payments.filter((p) => {
      if (paymentFilter === 'paid') return p.is_paid
      if (paymentFilter === 'pending') return !p.is_paid && (p.payment_status === 'pending' || p.payment_status === 'deferred')
      if (paymentFilter === 'overdue') return p.overdue
      if (paymentFilter === 'none') return !p.is_paid && p.payment_status === 'none'
      return true
    })

    return NextResponse.json({
      payments: list,
      reconciliation: {
        matched: wcMatched.filter(r => r.reconciled).length,
        unmatched: wcMatched.filter(r => !r.reconciled).length,
        matched_rows: wcMatched,
        unmatched_orders: unmatchedWc,
      },
      stats: {
        total_vendors: payments.length,
        total_paid: totalPaid,
        total_pending: totalPending,
        total_none: totalNone,
        total_overdue: totalOverdue,
        total_revenue: totalRevenue,   // vendor stall fees
        ticket_revenue: ticketRevenue, // WC ticket sales
        ticket_orders: ticketOrders,
        total_money_in: totalMoneyIn,  // vendors + tickets combined
      },
    })
  } catch (err) {
    console.error('[admin/finance] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
