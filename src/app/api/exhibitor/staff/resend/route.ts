import { NextRequest, NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'

export const runtime = 'nodejs'
// Renders the badge PDF (puppeteer/chromium) then delivers it — needs headroom.
export const maxDuration = 60

/**
 * Vendor-triggered "Resend badge" for a previously generated staff badge.
 *
 * We render the badge OURSELVES (QR = wc_order_id, scannable at the gate) and
 * deliver it over WhatsApp + email — replacing the old path that sent a
 * `ticket_delivery` template pointing at an admin-only WP order URL the vendor
 * could not open. FooEvents' PDF is not on the critical path (KT #206655).
 */
export async function POST(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const staffId = String(body.staffId || '')
  if (!staffId) return NextResponse.json({ error: 'staffId required' }, { status: 400 })

  const state = parsePortalState(ctx.application.admin_notes as string)
  const member = (state.staff || []).find((m) => m.id === staffId)
  if (!member) return NextResponse.json({ error: 'Staff member not found' }, { status: 404 })
  if (!member.wc_order_id) {
    return NextResponse.json({ error: 'Badge not yet generated' }, { status: 409 })
  }

  const { deliverBadge } = await import('@/lib/badges/deliver-badge')
  const r = await deliverBadge({
    name: member.name,
    role: member.role || 'staff',
    businessName: String(ctx.application.business_name || 'Vendor'),
    stall: parseAllocation(ctx.application.admin_notes as string).stall,
    phone: member.phone,
    vehicleReg: member.vehicle_reg,
    wcOrderId: member.wc_order_id,
    vendorPhone: String(ctx.application.phone || ''),
    vendorEmail: String(ctx.application.email || ''),
  })

  if (!r.pdf) return NextResponse.json({ error: 'Could not render badge' }, { status: 502 })
  return NextResponse.json({ ok: true, email: r.email, whatsapp: r.whatsapp })
}
