import { NextRequest, NextResponse } from 'next/server'
import { requireOperator } from '@/lib/admin-rbac'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEftAdmin } from '@/lib/eft'
import { recordAdminAction } from '@/lib/zanii-ledger'
import { parsePortalState, updatePortalState } from '@/lib/portal-state'
import { activeProvider, paymentsEnabled, paymentReference } from '@/lib/payments'
import { computeVendorPricing } from '@/lib/payments/pricing'

export const runtime = 'nodejs'

const SITE = 'https://cthalaal.co.za'

// TEMPORARY EFT lane: create a Yoco checkout to SETTLE a 'collected' vendor's EFT
// payment through Yoco. The operator (Taona) opens the returned URL and pays with
// his card (funded by the EFT cash already in FNB). On webhook success the vendor
// flips collected -> real `paid`: it is the FIRST paid_at transition (collected
// never set paid_at, so revenue counts exactly once), the OWNER is notified as a
// normal Yoco payment, and the VENDOR is NOT re-pinged (already acknowledged at
// collect — see the yoco webhook's isEftSettlement gate). EFT admin only.
export async function POST(req: NextRequest) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  if (!isEftAdmin(gate.adminUser.email)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if (!paymentsEnabled()) return NextResponse.json({ error: 'payments not enabled' }, { status: 400 })

  const body = (await req.json().catch(() => ({}))) as { applicationId?: string }
  const id = String(body.applicationId || '')
  if (!id) return NextResponse.json({ error: 'applicationId required' }, { status: 400 })

  const admin = createAdminClient()
  const { data: app } = await admin
    .from('vendor_applications')
    .select('id, business_name, email, admin_notes, preferred_booth_tier, special_requirements, paid_at')
    .eq('id', id)
    .maybeSingle()
  if (!app) return NextResponse.json({ error: 'application not found' }, { status: 404 })

  const state = parsePortalState(app.admin_notes as string)
  const acc = state.payment?.acc
  const accPending = !!acc?.collected_at && !acc?.settled_at
  const isPaid = state.payment?.status === 'paid' || !!app.paid_at

  // ACCESSORY settlement (split-bill, 2026-08-04): a vendor whose stall is
  // already settled has an accessory EFT marked collected. Settle exactly that
  // amount through Yoco; the webhook folds it into payment.amount via the
  // top-up path (notifyVendor:false, see accPending detection there).
  let amount: number
  let description: string
  if (isPaid) {
    if (!accPending) return NextResponse.json({ error: 'already settled' }, { status: 400 })
    amount = Number(acc?.amount) || 0
    description = `Accessory settlement, ${app.business_name}, Young at Heart Festival 2026`
  } else {
    if (state.payment?.status !== 'collected') {
      return NextResponse.json({ error: 'not collected: only EFT-collected vendors can be settled via Yoco' }, { status: 400 })
    }
    const pricing = computeVendorPricing({
      preferred_booth_tier: app.preferred_booth_tier as string,
      special_requirements: app.special_requirements,
    })
    // Settle the amount that was collected (falls back to the full computed total).
    amount = Number(state.payment?.amount) || pricing.total
    description = `EFT settlement, ${app.business_name}, Young at Heart Festival 2026`
  }
  if (!amount || amount <= 0) return NextResponse.json({ error: 'nothing to settle' }, { status: 400 })

  // Accessory settle carries the vendor's -ACC reference so the Yoco checkout,
  // the bank statement, and the admin lane all name the same deposit.
  const reference = isPaid
    ? (await import('@/lib/payments/vendor-bill')).accEftReference({ id, admin_notes: app.admin_notes as string, business_name: app.business_name as string | null })
    : state.payment?.reference || paymentReference(id)
  try {
    const { url, providerRef } = await activeProvider().createPayment({
      applicationId: id,
      amount,
      currency: 'ZAR',
      reference,
      email: (app.email as string) || '',
      businessName: (app.business_name as string) || 'Exhibitor',
      description,
      // The OPERATOR pays this checkout, so return to the master lane, not the
      // vendor portal.
      returnUrl: `${SITE}/admin/eft?settled=1`,
      cancelUrl: `${SITE}/admin/eft?settled=cancelled`,
      failureUrl: `${SITE}/admin/eft?settled=failed`,
    })
    // Record the settlement attempt WITHOUT changing status. For an ACCESSORY
    // settle the attempt lives on the acc sub-ledger: the vendor's real stall
    // provider_ref/reference must not be clobbered by the operator's checkout.
    await updatePortalState(id, (s) => ({
      ...s,
      payment: isPaid
        ? {
            ...(s.payment || {}),
            acc: { ...(s.payment?.acc || {}), attempted_at: new Date().toISOString() },
          }
        : {
            ...(s.payment || {}),
            provider_ref: providerRef,
            reference,
            attempted_at: new Date().toISOString(),
          },
    }))
    // Zanii Proof: the admin INITIATED a settle checkout. The real settlement
    // (paid_at) is recorded later by the Yoco webhook as cth.pay.confirmed; this
    // receipt attributes the initiation to the human who clicked settle.
    await recordAdminAction({
      actor: { email: gate.adminUser.email, role: gate.role },
      action: 'eft_settle_initiated',
      vendorId: id,
      payload: { kind: isPaid ? 'accessory' : 'stall', amount },
    })
    return NextResponse.json({ ok: true, url, amount })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'checkout failed' }, { status: 500 })
  }
}
