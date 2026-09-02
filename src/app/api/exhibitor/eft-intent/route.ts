import { NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState, parsePortalState } from '@/lib/portal-state'
import { getEftMode, vendorInEftLane, eftReference } from '@/lib/eft'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { notifyOwners } from '@/lib/bot/notify'
import { recordVendorAction } from '@/lib/vendor-action-log'

const THROTTLE_MS = 12 * 60 * 60 * 1000 // one heads-up per vendor per 12h

// TEMPORARY EFT lane (lib/eft.ts). The vendor clicked "Show bank details to pay"
// on their EFT panel — a strong signal they are about to pay by EFT (they cannot
// pay without the account number, and this is the only place they get it). Two
// effects, both reversible, neither ever calls confirmPayment():
//   1. Stamp payment.eft_revealed_at. While global EFT mode is on this seals the
//      vendor's email + WhatsApp off the festival owner's inbox (vendorCommsInEftLane),
//      so anyone actually paying by EFT stops reaching Samreen.
//   2. Fire a MASTER-ONLY WhatsApp heads-up (Taona) so he can watch for the proof,
//      throttled to at most once per 12h. audience:'master' keeps it off Samreen
//      even if global mode is toggled off.
export async function POST(req: Request) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const applicationId = ctx.application.id as string
  const body = (await req.json().catch(() => ({}))) as { purpose?: string }
  // 'accessories' = a settled vendor revealing details to pay their accessory
  // electricity balance (split-bill, payment.acc); default is the stall lane.
  const forAccessories = body.purpose === 'accessories'

  const db = createAdminClient()
  const { data: app } = await db
    .from('vendor_applications')
    .select('business_name, admin_notes, preferred_booth_tier, special_requirements, paid_at, email, phone')
    .eq('id', applicationId)
    .single()
  if (!app) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { vendorBill, accEftReference } = await import('@/lib/payments/vendor-bill')
  const bill = vendorBill({
    id: applicationId,
    preferred_booth_tier: app.preferred_booth_tier as string,
    special_requirements: app.special_requirements,
    admin_notes: app.admin_notes as string,
    paid_at: app.paid_at as string | null,
  })

  if (forAccessories) {
    // Accessory gate: stall settled + accessory balance actually owing, AND the
    // EFT lane switch still on (global mode or an individual marker). The lane
    // is a temporary Yoco-outage side-channel: one switch must close the WHOLE
    // rail, accessories included, or the lane becomes un-retirable (doctrine
    // review 2026-08-04). The stall lane gate below would 403 these vendors
    // (it excludes paid), hence the separate test.
    const { hasEftMarker } = await import('@/lib/eft')
    const laneOpen = (await getEftMode()) || hasEftMarker(app.admin_notes as string)
    if (!laneOpen || !bill.settled || bill.accessories.owing <= 0) {
      return NextResponse.json({ error: 'No accessory balance is owing on your account' }, { status: 403 })
    }
  } else if (!vendorInEftLane(app.admin_notes as string, await getEftMode(), app.paid_at as string | null, { email: app.email as string | null, phone: app.phone as string | null })) {
    // Same gate as the panel + proof route: only a vendor who actually sees the EFT
    // panel may signal here (global mode on, or individually marked ⟦EFT⟧, unpaid).
    return NextResponse.json({ error: 'EFT is not enabled for your account' }, { status: 403 })
  }

  // Throttle the notification only. The seal (the revealed stamp being SET)
  // persists regardless; we just do not re-buzz the operator within 12h.
  const priorPay = parsePortalState(app.admin_notes as string).payment
  const prior = forAccessories ? priorPay?.acc?.revealed_at : priorPay?.eft_revealed_at
  const withinWindow = prior && Date.now() - new Date(prior).getTime() < THROTTLE_MS

  const now = new Date().toISOString()
  await updatePortalState(applicationId, (s) => ({
    ...s,
    payment: forAccessories
      ? { ...s.payment, acc: { ...(s.payment?.acc || {}), revealed_at: prior && withinWindow ? prior : now } }
      : { ...s.payment, eft_revealed_at: prior && withinWindow ? prior : now },
  }))

  await recordVendorAction({
    applicationId,
    eventType: forAccessories ? 'eft_acc_details_revealed' : 'eft_details_revealed',
    actorEmail: ctx.email,
    note: forAccessories ? 'acc.revealed_at stamped' : `eft_revealed_at stamped`,
  })

  if (withinWindow) return NextResponse.json({ ok: true, notified: false })

  const name = (app.business_name as string) || 'A vendor'
  const ref = forAccessories
    ? accEftReference({ id: applicationId, admin_notes: app.admin_notes as string, business_name: app.business_name as string | null })
    : eftReference({ id: applicationId, admin_notes: app.admin_notes as string, business_name: app.business_name as string | null })
  const pricing = computeVendorPricing({
    preferred_booth_tier: app.preferred_booth_tier as string,
    special_requirements: app.special_requirements,
  })
  const dueAmount = forAccessories ? bill.accessories.owing : pricing.total
  const amount = dueAmount ? `R${dueAmount.toFixed(2)} due` : 'amount pending'

  // Best-effort: a notify failure must never break the vendor's reveal.
  await notifyOwners({
    event: 'system_alert',
    audience: 'master',
    body: forAccessories
      ? `${name} just opened the EFT bank details to pay their ACCESSORY electricity balance. Ref ${ref}, ${amount}. Watch for their proof on the Master lane.`
      : `${name} just opened the EFT bank details on their portal, likely about to pay. Ref ${ref}, ${amount}. Watch for their proof on the Master lane.`,
  }).catch(() => {})

  return NextResponse.json({ ok: true, notified: true })
}
