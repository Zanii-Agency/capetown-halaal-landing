import { NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState, parsePortalState } from '@/lib/portal-state'
import { getEftMode, vendorInEftLane, eftReference } from '@/lib/eft'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { notifyOwners } from '@/lib/bot/notify'

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
export async function POST() {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const applicationId = ctx.application.id as string

  const db = createAdminClient()
  const { data: app } = await db
    .from('vendor_applications')
    .select('business_name, admin_notes, preferred_booth_tier, special_requirements, paid_at')
    .eq('id', applicationId)
    .single()
  if (!app) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Same gate as the panel + proof route: only a vendor who actually sees the EFT
  // panel may signal here (global mode on, or individually marked ⟦EFT⟧, unpaid).
  if (!vendorInEftLane(app.admin_notes as string, await getEftMode(), app.paid_at as string | null)) {
    return NextResponse.json({ error: 'EFT is not enabled for your account' }, { status: 403 })
  }

  // Throttle the notification only. The seal (eft_revealed_at being SET) persists
  // regardless; we just do not re-buzz the operator on a re-click within 12h.
  const prior = parsePortalState(app.admin_notes as string).payment?.eft_revealed_at
  const withinWindow = prior && Date.now() - new Date(prior).getTime() < THROTTLE_MS

  const now = new Date().toISOString()
  await updatePortalState(applicationId, (s) => ({
    ...s,
    payment: { ...s.payment, eft_revealed_at: prior && withinWindow ? prior : now },
  }))

  if (withinWindow) return NextResponse.json({ ok: true, notified: false })

  const pricing = computeVendorPricing({
    preferred_booth_tier: app.preferred_booth_tier as string,
    special_requirements: app.special_requirements,
  })
  const ref = eftReference({ id: applicationId, admin_notes: app.admin_notes as string })
  const name = (app.business_name as string) || 'A vendor'
  const amount = pricing.total ? `R${pricing.total.toFixed(2)} due` : 'amount pending'

  // Best-effort: a notify failure must never break the vendor's reveal.
  await notifyOwners({
    event: 'system_alert',
    audience: 'master',
    body: `${name} just opened the EFT bank details on their portal, likely about to pay. Ref ${ref}, ${amount}. Watch for their proof on the Master lane.`,
  }).catch(() => {})

  return NextResponse.json({ ok: true, notified: true })
}
