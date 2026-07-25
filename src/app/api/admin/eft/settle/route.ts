import { NextRequest, NextResponse } from 'next/server'
import { requireOperator } from '@/lib/admin-rbac'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEftAdmin } from '@/lib/eft'
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
  if (state.payment?.status === 'paid' || app.paid_at) {
    return NextResponse.json({ error: 'already settled' }, { status: 400 })
  }
  if (state.payment?.status !== 'collected') {
    return NextResponse.json({ error: 'not collected: only EFT-collected vendors can be settled via Yoco' }, { status: 400 })
  }

  const pricing = computeVendorPricing({
    preferred_booth_tier: app.preferred_booth_tier as string,
    special_requirements: app.special_requirements,
  })
  // Settle the amount that was collected (falls back to the full computed total).
  const amount = Number(state.payment?.amount) || pricing.total
  if (!amount || amount <= 0) return NextResponse.json({ error: 'nothing to settle' }, { status: 400 })

  const reference = state.payment?.reference || paymentReference(id)
  try {
    const { url, providerRef } = await activeProvider().createPayment({
      applicationId: id,
      amount,
      currency: 'ZAR',
      reference,
      email: (app.email as string) || '',
      businessName: (app.business_name as string) || 'Exhibitor',
      description: `EFT settlement, ${app.business_name}, Young at Heart Festival 2026`,
      // The OPERATOR pays this checkout, so return to the master lane, not the
      // vendor portal.
      returnUrl: `${SITE}/admin/eft?settled=1`,
      cancelUrl: `${SITE}/admin/eft?settled=cancelled`,
      failureUrl: `${SITE}/admin/eft?settled=failed`,
    })
    // Record the settlement attempt WITHOUT changing status: it stays 'collected'
    // until the webhook confirms the real paid transition.
    await updatePortalState(id, (s) => ({
      ...s,
      payment: {
        ...(s.payment || {}),
        provider_ref: providerRef,
        reference,
        attempted_at: new Date().toISOString(),
      },
    }))
    return NextResponse.json({ ok: true, url, amount })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'checkout failed' }, { status: 500 })
  }
}
