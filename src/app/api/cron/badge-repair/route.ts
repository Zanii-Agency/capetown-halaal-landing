/**
 * GET /api/cron/badge-repair
 *
 * Repair path for staff badges registered BEFORE the FooEvents blueprint fix
 * (2026-07-10): those portal_state.staff entries have NO wc_order_id, so no
 * badge was ever generated or delivered. For each approved vendor's active
 * staff member missing an order, this route creates the WC order through the
 * FIXED createStaffBadgeOrder (blueprint + pending->completed), persists the
 * order id back onto portal_state, and delivers our self-rendered badge with a
 * "this has been resolved" note (email confirmDelivery + WhatsApp best-effort).
 *
 * Idempotent: staff that already have wc_order_id are skipped. Default is a
 * DRY RUN that only reports the plan; pass ?execute=1 to act.
 * Auth: Authorization: Bearer ${CRON_SECRET} (manual operator trigger; this is
 * not scheduled in vercel.json).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyCronAuth } from '@/lib/security/cron-auth'
import { parsePortalState, updatePortalState } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import { createStaffBadgeOrder } from '@/lib/woocommerce'
import { deliverBadge } from '@/lib/badges/deliver-badge'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// chromium render per badge — needs the same headroom as the staff routes
export const maxDuration = 120

const RESOLVED_INTRO =
  'Good news: the staff badge issue on the exhibitor portal has been resolved. ' +
  'Your staff gate passes have now been issued, no action needed from you.'

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const execute = new URL(req.url).searchParams.get('execute') === '1'

  const admin = createAdminClient()
  const { data: vendors, error } = await admin
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, status, admin_notes')
    .eq('status', 'approved')
    .like('admin_notes', '%⟦PORTAL:%')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<Record<string, unknown>> = []
  for (const v of vendors || []) {
    const state = parsePortalState(v.admin_notes as string)
    const pending = (state.staff || []).filter((m) => !m.revoked_at && !m.wc_order_id)
    if (!pending.length) continue

    const stall = parseAllocation(v.admin_notes as string).stall
    const businessName = String(v.business_name || 'Vendor')
    const contact = String(v.contact_name || businessName)
    const [first, ...rest] = contact.split(/\s+/).filter(Boolean)

    for (const m of pending) {
      const entry: Record<string, unknown> = {
        vendor: businessName, email: v.email, staff: m.name, role: m.role || 'staff',
      }
      if (!execute) {
        entry.plan = 'create order + deliver badge'
        results.push(entry)
        continue
      }
      try {
        const wc = await createStaffBadgeOrder({
          vendorApplicationId: v.id as string,
          vendorFirstName: first || 'Vendor',
          vendorLastName: rest.join(' ') || businessName,
          vendorEmail: String(v.email || ''),
          vendorPhone: String(v.phone || ''),
          vendorBusinessName: businessName,
          stallCode: stall,
          staff: {
            name: m.name,
            id_number: m.id_number || '',
            vehicle_reg: m.vehicle_reg || '',
            role: m.role || 'staff',
            portalStaffId: m.id,
          },
        })
        await updatePortalState(v.id as string, (s) => ({
          ...s,
          staff: (s.staff || []).map((x) =>
            x.id === m.id
              ? {
                  ...x,
                  wc_order_id: wc.id,
                  wc_order_number: wc.number || String(wc.id),
                  fooevents_ticket_id: wc.fooevents_ticket_id,
                  ticket_pdf_url: wc.ticket_pdf_url,
                }
              : x,
          ),
        }))
        const delivery = await deliverBadge({
          name: m.name,
          role: m.role || 'staff',
          businessName,
          stall,
          phone: m.phone,
          vehicleReg: m.vehicle_reg,
          wcOrderId: wc.id,
          vendorPhone: String(v.phone || ''),
          vendorEmail: String(v.email || ''),
          intro: RESOLVED_INTRO,
        })
        entry.wc_order_id = wc.id
        entry.delivery = delivery
      } catch (e) {
        entry.error = (e as Error).message
      }
      results.push(entry)
    }
  }

  return NextResponse.json({ execute, repaired: results.length, results })
}
