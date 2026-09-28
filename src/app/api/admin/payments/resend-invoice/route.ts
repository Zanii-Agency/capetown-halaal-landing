// Admin-only resend of the vendor invoice.
//  - PAID vendor: the payment confirmation + invoice link (the receipt), via the
//    same VendorPaymentConfirmation template the original confirmation used.
//  - UNPAID vendor: the invoice PDF itself (the bill, with how to pay), via the
//    shared renderInvoicePdf so every issue path behaves the same.
// Does NOT mutate payment state (renderInvoicePdf's gated, wall-safe hand-over
// of a never-paid master vendor to the owner is the one exception, by design).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'
import { sendVendorPaymentEmail } from '@/lib/payments/confirm'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { requireOperator } from '@/lib/admin-rbac'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response

  const db = createAdminClient()

  const body = await req.json().catch(() => ({}))
  const applicationId = String(body.applicationId || '').trim()
  if (!applicationId) {
    return NextResponse.json({ ok: false, error: 'Missing applicationId' }, { status: 400 })
  }

  const { data: app } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, paid_at, admin_notes, preferred_booth_tier, special_requirements')
    .eq('id', applicationId)
    .maybeSingle()
  if (!app) return NextResponse.json({ ok: false, error: 'Application not found' }, { status: 404 })
  if (!app.email) return NextResponse.json({ ok: false, error: 'Vendor has no email on file' }, { status: 400 })

  const state = parsePortalState(app.admin_notes as string)
  // UNPAID: send the BILL (the invoice PDF with how-to-pay), not the receipt.
  // Taona/Samreen 2026-09-28: "still can't resend invoices to people" — an unpaid
  // vendor whose invoice was just updated needs it resent, which the old
  // paid-only guard refused.
  if (state.payment?.status !== 'paid') {
    return sendUnpaidInvoice(app as UnpaidApp, state, gate.adminUser)
  }

  const pricing = computeVendorPricing({
    preferred_booth_tier: app.preferred_booth_tier as string,
    special_requirements: app.special_requirements,
  })
  const amount = state.payment.amount ?? pricing.total
  const providerRef = state.payment.provider_ref || state.payment.reference || 'manual'
  const contactName = (app.contact_name as string) || 'there'
  const businessName = (app.business_name as string) || 'your business'

  const paidDate = state.payment.paid_at
    ? new Date(state.payment.paid_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
    : undefined
  const result = await sendVendorPaymentEmail({
    to: app.email as string,
    contactName,
    businessName,
    amount,
    providerRef,
    reference: state.payment.reference || applicationId.slice(0, 8).toUpperCase(),
    paidDate,
    pricing,
  })
  if (!result.sent) {
    return NextResponse.json({ ok: false, error: result.error || 'Email send failed' }, { status: 502 })
  }
  return NextResponse.json({ ok: true, to: app.email, amount, providerRef })
}

type UnpaidApp = {
  id: string
  business_name: string | null
  contact_name: string | null
  email: string
  phone: string | null
  paid_at: string | null
  admin_notes: string | null
  preferred_booth_tier: string | null
  special_requirements: unknown
}

async function sendUnpaidInvoice(
  app: UnpaidApp,
  state: ReturnType<typeof parsePortalState>,
  viewer: { id: string; email: string | null },
) {
  // A payment already on file that isn't confirmed yet (collected / proof
  // uploaded): an unpaid invoice would tell this vendor to pay AGAIN into the
  // owner's account. Confirm the payment first; nothing is sent.
  const { vendorHasEftTrail } = await import('@/lib/payments/vendor-bill')
  if (app.paid_at || vendorHasEftTrail(state)) {
    return NextResponse.json(
      { ok: false, error: 'This vendor already has a payment on file waiting to be confirmed. Confirm it first, then resend.' },
      { status: 409 },
    )
  }

  // Same hold as every other send (Taona 2026-09-23): a restricted viewer's send
  // to a vendor walled from her reads as sent and is never delivered.
  const { laneScopeFor } = await import('@/lib/inbox-lane')
  const scope = await laneScopeFor(viewer.email)
  if (!scope.unrestricted) {
    const { loadWalledContacts } = await import('@/lib/broadcast-audience')
    const { shouldHoldNewEmail } = await import('@/lib/inbox/held-email')
    const walled = await loadWalledContacts()
    if (shouldHoldNewEmail(scope, walled, app.email, [{ id: app.id, phone: app.phone }])) {
      try {
        const { notifyOwners } = await import('@/lib/bot/notify')
        await notifyOwners({
          event: 'system_alert',
          audience: 'master',
          body: `HELD INVOICE (not delivered): ${viewer.email} tried to resend an invoice to ${app.email} (${app.business_name || 'vendor'}), a vendor walled from her.`,
        })
      } catch (e) { console.error('[resend-invoice] held notify failed:', (e as Error).message) }
      return NextResponse.json({ ok: true, to: app.email })
    }
  }

  const { renderInvoicePdf } = await import('@/lib/payments/invoice-pdf')
  const { paymentReference } = await import('@/lib/payments')
  const { sendEmail } = await import('@/lib/email/resend')
  let amount = state.payment?.amount
  if (amount == null) {
    try {
      amount = computeVendorPricing({ preferred_booth_tier: app.preferred_booth_tier || '', special_requirements: app.special_requirements }).total
    } catch { amount = 0 }
  }
  const pdf = await renderInvoicePdf({
    applicationId: app.id,
    businessName: app.business_name || 'Vendor',
    contactName: app.contact_name || '',
    email: app.email,
    phone: app.phone || undefined,
    amount,
    status: state.payment?.status || 'none',
    reference: state.payment?.reference || paymentReference(app.id),
    providerRef: state.payment?.provider_ref || '',
    method: state.payment?.method,
    preferredBoothTier: app.preferred_booth_tier || '',
    specialRequirements: app.special_requirements,
  })
  if (!pdf) {
    return NextResponse.json({ ok: false, error: 'Could not build the invoice PDF. Try again.' }, { status: 502 })
  }

  const first = String(app.contact_name || 'there').trim().split(/\s+/)[0] || 'there'
  const biz = (app.business_name || 'your stall').trim()
  const text = [
    `Salaam ${first},`,
    '',
    `Please find attached your updated invoice for ${biz} at the Young at Heart Festival.`,
    '',
    'The invoice shows the amount due and how to pay. Please use the reference on the invoice when you pay, so we can match your payment to your stall.',
    '',
    'You can also view and download it any time by logging into your portal at https://cthalaal.co.za/exhibitor/login under Payments.',
    '',
    'Jazakallah khair,',
    'The Young at Heart Festival Team',
  ].join('\n')
  const slug = (app.business_name || 'invoice').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'invoice'
  const res = await sendEmail({
    to: app.email,
    subject: `Your invoice, ${biz}`,
    text,
    attachments: [{ filename: `CTH-Invoice-${slug}.pdf`, content: pdf, contentType: 'application/pdf' }],
    confirmDelivery: true,
    sentBy: viewer.id,
  })
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error || 'Email send failed' }, { status: 502 })
  }
  return NextResponse.json({ ok: true, to: app.email, amount, invoice: true })
}
