import { NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { updatePortalState, parsePortalState } from '@/lib/portal-state'
import { activeProvider, paymentsEnabled, paymentReference } from '@/lib/payments'

const SITE = 'https://cthalaal.co.za'

// GET: this vendor's payment status.
export async function GET() {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const state = parsePortalState(ctx.application.admin_notes as string)
  return NextResponse.json({
    enabled: paymentsEnabled(),
    payment: state.payment || { status: 'none' },
    amount: state.payment?.amount ?? null,
  })
}

// POST: start a card payment (returns Yoco redirect URL).
// EFT-by-bank-transfer was retired 2026-06-09; vendors who can't use the card
// flow are routed to the Support inbox and the organisers mark them paid by
// hand from /admin/vendor-ops Payments tab.
export async function POST() {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const app = ctx.application
  const applicationId = app.id as string

  if (!paymentsEnabled()) {
    return NextResponse.json({ error: 'Online card payment is not enabled yet' }, { status: 503 })
  }
  // Bill the LIVE computed total (stall + electricals incl. admin-added custom
  // charges + furniture), recomputed at pay-time. This is what the vendor
  // currently owes, so an operator amendment (e.g. adding an electrical charge)
  // automatically re-bills on the next Pay with no manual step. A stored
  // state.payment.amount is the locked RECORD of what was actually paid (written
  // at payment time), not a pre-payment quote, so it never overrides here.
  const { computeVendorPricing } = await import('@/lib/payments/pricing')
  const pricing = computeVendorPricing({
    preferred_booth_tier: app.preferred_booth_tier as string,
    special_requirements: app.special_requirements,
  })
  // Bill the OUTSTANDING balance: the live total minus what the vendor has
  // already paid. For a first payment that is the full total. For a top-up
  // (operator added charges after the vendor paid) it is just the difference,
  // so the vendor is never charged twice for the same amount.
  const state = parsePortalState(app.admin_notes as string)
  const alreadyPaid = Number(state.payment?.amount) || 0
  const owed = pricing.total
  const amount = Math.max(0, owed - alreadyPaid)
  if (!owed || owed <= 0) {
    return NextResponse.json({ error: 'Your stall fee could not be computed. Please contact the team.' }, { status: 400 })
  }
  if (amount <= 0) {
    return NextResponse.json({ error: 'Your account is settled. There is nothing to pay right now.', settled: true }, { status: 400 })
  }
  const reference = paymentReference(applicationId)
  try {
    const { url, providerRef } = await activeProvider().createPayment({
      applicationId,
      amount,
      currency: 'ZAR',
      reference,
      email: ctx.email,
      businessName: (app.business_name as string) || 'Exhibitor',
      description: `Stall fee, ${app.business_name}, Young at Heart Festival 2026`,
      // Return URLs deliberately point OUTSIDE the auth-gated /exhibitor/portal
      // tree. Yoco's cross-domain hop can drop the Supabase session on Safari
      // ITP, WhatsApp in-app browsers, or after a long-running checkout — and
      // a gated path would bounce the vendor to /exhibitor/login mid-flow.
      // The public return page shows status and links them back to the portal
      // (where session refresh / re-login happens naturally if needed).
      returnUrl: `${SITE}/exhibitor/payment-return?status=success`,
      cancelUrl: `${SITE}/exhibitor/payment-return?status=cancelled`,
      failureUrl: `${SITE}/exhibitor/payment-return?status=failed`,
    })
    await updatePortalState(applicationId, (s) => {
      // Already-paid vendor doing a top-up: keep them 'paid' (do not downgrade
      // to 'pending', which would re-lock the portal). Never overwrite the
      // cumulative-paid `amount`; confirmPayment accumulates that on success.
      const settled = s.payment?.status === 'paid' || !!s.payment?.paid_at
      return {
        ...s,
        payment: {
          ...(s.payment || {}),
          status: settled ? 'paid' : 'pending',
          reference,
          provider_ref: providerRef,
          attempted_at: new Date().toISOString(),
          attempts: ((s.payment?.attempts as number) || 0) + 1,
        },
      }
    })
    return NextResponse.json({ url })
  } catch (e) {
    console.error('[payments] initiate failed:', (e as Error).message)
    return NextResponse.json({ error: 'Could not start the payment. Please try again or contact support.' }, { status: 502 })
  }
}
