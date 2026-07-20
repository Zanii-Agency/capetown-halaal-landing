/**
 * Mark a ticket / badge as checked-in at the gate.
 *
 * POST /api/admin/verifier/check-in
 *   Body: { order_id: number, ticket_id?: string }
 *
 * Auth: cookie session + admin_users role IN ('owner', 'operator'). Viewer is
 *   blocked here even though they can read /lookup, because check-in is a
 *   mutation that touches the public-facing FooEvents attendee state.
 *
 * Implementation strategy:
 *   1. For staff badges (product_id === STAFF_BADGE_PRODUCT_ID), we stamp
 *      `checked_in_at` on the matching portal_state.staff entry in
 *      vendor_applications.admin_notes. This is the authoritative gate-side
 *      record for staff because Samreen's flow runs through /admin/vendors.
 *   2. For buyer tickets, we POST a note + meta marker on the WC order so a
 *      manual look at /wp-admin/post.php?post=<id>&action=edit shows the
 *      check-in stamp. The actual FooEvents attendee `WooCommerceEventsStatus`
 *      meta key gets flipped via the same call (`Checked In`), which is what
 *      the Express Check-In UI also writes. This avoids forking FooEvents
 *      (Law 3): we use the same shape the plugin uses, server-side.
 *
 * TODO: build a tiny WP-side custom REST route that wraps the FooEvents
 *   internal `fooevents_check_in_attendee` action so we get the plugin's full
 *   side-effect chain (audit log + counter + email). For now the meta-data
 *   write surfaces in FooEvents reporting because the plugin reads the same
 *   meta. See docs/staff-badges-via-fooevents.md for the prior precedent.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState } from '@/lib/portal-state'
import { requireOperator } from '@/lib/admin-rbac'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STAFF_BADGE_PRODUCT_ID = Number(process.env.STAFF_BADGE_PRODUCT_ID || 9487)
const WC_BASE = 'https://tickets.youngatheart.co.za/wp-json/wc/v3'
const WC_KEY = process.env.WC_CONSUMER_KEY || ''
const WC_SECRET = process.env.WC_CONSUMER_SECRET || ''

async function wcGet<T>(endpoint: string): Promise<T> {
  if (!WC_KEY || !WC_SECRET) throw new Error('WC creds missing')
  const url = new URL(`${WC_BASE}${endpoint}`)
  url.searchParams.set('consumer_key', WC_KEY)
  url.searchParams.set('consumer_secret', WC_SECRET)
  const res = await fetch(url.toString(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`WC GET ${endpoint} failed: ${res.status}`)
  return res.json()
}

async function wcPut(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  if (!WC_KEY || !WC_SECRET) throw new Error('WC creds missing')
  const url = new URL(`${WC_BASE}${endpoint}`)
  url.searchParams.set('consumer_key', WC_KEY)
  url.searchParams.set('consumer_secret', WC_SECRET)
  const res = await fetch(url.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!res.ok) {
    const t = await res.text().catch(() => 'no body')
    throw new Error(`WC PUT ${endpoint} failed: ${res.status}: ${t}`)
  }
  return res.json()
}

interface WCOrderMeta { key: string; value: string }
interface WCOrderDetail {
  id: number
  status: string
  line_items: Array<{ product_id: number }>
  meta_data?: WCOrderMeta[]
}

export async function POST(request: NextRequest) {
  try {
    const gate = await requireOperator()
    if (!gate.ok) return gate.response
    const { user } = gate

    const admin = createAdminClient()

    const body = await request.json().catch(() => null) as { order_id?: number; ticket_id?: string } | null
    if (!body || !body.order_id) {
      return NextResponse.json({ ok: false, error: 'order_id required' }, { status: 400 })
    }
    const orderId = Number(body.order_id)
    if (!Number.isFinite(orderId) || orderId <= 0) {
      return NextResponse.json({ ok: false, error: 'order_id invalid' }, { status: 400 })
    }

    // Fetch the order so we can decide whether this is a staff badge or a buyer ticket.
    let order: WCOrderDetail
    try {
      order = await wcGet<WCOrderDetail>(`/orders/${orderId}`)
    } catch (e) {
      console.error('[verifier/check-in] WC fetch failed', e)
      return NextResponse.json({ ok: false, error: 'Ticket store unreachable' }, { status: 502 })
    }

    const productId = order.line_items?.[0]?.product_id || 0
    const isStaff = productId === STAFF_BADGE_PRODUCT_ID
    const now = new Date().toISOString()

    if (isStaff) {
      // Find the vendor application that owns this staff badge order
      // (meta_data.vendor_application_id is set on creation by createStaffBadgeOrder).
      const vendorAppId = (order.meta_data || []).find((m) => m.key === 'vendor_application_id')?.value
      const portalStaffId = (order.meta_data || []).find((m) => m.key === 'vendor_portal_staff_id')?.value
      if (vendorAppId && portalStaffId) {
        await updatePortalState(vendorAppId, (s) => {
          const staff = (s.staff || []).map((m) => {
            if (m.id === portalStaffId) {
              return { ...m, checked_in_at: m.checked_in_at || now }
            }
            return m
          })
          return { ...s, staff }
        })
      }
    }

    // For both staff and buyer tickets, also stamp meta on the WC order so the
    // FooEvents Express Check-In UI displays the same state next time it
    // opens this order.
    try {
      const existing = order.meta_data || []
      const merged: WCOrderMeta[] = existing.filter((m) => !['WooCommerceEventsStatus', 'cth_checked_in_at', 'cth_checked_in_by'].includes(m.key))
      merged.push({ key: 'WooCommerceEventsStatus', value: 'Checked In' })
      merged.push({ key: 'cth_checked_in_at', value: now })
      merged.push({ key: 'cth_checked_in_by', value: user.email || user.id })
      await wcPut(`/orders/${orderId}`, { meta_data: merged })
    } catch (e) {
      console.error('[verifier/check-in] WC meta update failed', e)
      // Non-fatal for staff (we already stamped portal_state). For buyers,
      // surface the failure so the operator can re-try.
      if (!isStaff) {
        return NextResponse.json({ ok: false, error: 'Check-in stamp failed on order' }, { status: 502 })
      }
    }

    return NextResponse.json({ ok: true, checked_in_at: now, mode: isStaff ? 'staff' : 'buyer' })
  } catch (err) {
    console.error('[verifier/check-in] error', err)
    return NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 })
  }
}
