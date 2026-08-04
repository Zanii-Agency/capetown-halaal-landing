// Vendor-facing invoice PDF download.
//
// Auth: session-gated on the signed-in vendor. The vendor's application_id is
// resolved server-side from getExhibitorContext (CTH-DOCTRINE Law 2) and is
// NEVER taken from a query/path param, so this route can only ever return the
// caller's own invoice.
//
// Source of truth: vendor_applications row + portal-state payment marker.
// Pricing comes from computeVendorPricing (same path the invoice page uses).
//
// Render: re-uses the established renderInvoicePdf helper (puppeteer-core +
// @sparticuz/chromium-min). No new dependency.

import { NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState } from '@/lib/portal-state'
import { paymentReference } from '@/lib/payments'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { renderInvoicePdf } from '@/lib/payments/invoice-pdf'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

export async function GET() {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const app = ctx.application as Record<string, unknown>
  const state = parsePortalState((app.admin_notes as string) || null)

  let pricing
  try {
    pricing = computeVendorPricing({
      preferred_booth_tier: app.preferred_booth_tier as string,
      special_requirements: app.special_requirements,
    })
  } catch {
    return NextResponse.json({ error: 'Could not compute pricing' }, { status: 500 })
  }

  const rawStatus = state.payment?.status || 'none'
  // Vendor sees 'collected' (EFT interim) as PAID on their printable invoice.
  const status = rawStatus === 'collected' ? 'paid' : rawStatus
  const amount = state.payment?.amount ?? pricing.total
  const reference = state.payment?.reference || paymentReference(app.id as string)
  const providerRef = state.payment?.provider_ref || ''
  const paidStamp = state.payment?.paid_at || state.payment?.eft_collected_at
  const paidAt = paidStamp
    ? new Date(paidStamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
    : undefined

  const pdf = await renderInvoicePdf({
    applicationId: app.id as string,
    businessName: (app.business_name as string) || ctx.email,
    contactName: (app.contact_name as string) || '',
    email: (app.email as string) || ctx.email,
    phone: (app.whatsapp_number as string) || (app.phone as string) || undefined,
    amount,
    status,
    reference,
    providerRef,
    paidAt,
    // Vendor-facing invoice is methodless: acknowledge payment, never name the
    // method (Yoco/EFT is internal reconciliation detail). Admin PDF callers still
    // pass method. (Taona 2026-07-25.)
    method: undefined,
    preferredBoothTier: (app.preferred_booth_tier as string) || '',
    specialRequirements: app.special_requirements,
  })
  if (!pdf) {
    return NextResponse.json({ error: 'Could not render invoice' }, { status: 500 })
  }

  const slug = String(app.business_name || 'invoice').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'invoice'
  const filename = `Invoice-${reference}-${slug}.pdf`

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    },
  })
}
