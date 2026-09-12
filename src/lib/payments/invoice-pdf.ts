// Render a vendor invoice to PDF buffer for email attachment.
//
// Uses puppeteer-core + @sparticuz/chromium-min (the Vercel-compatible build
// that ships a stripped-down headless Chromium small enough to fit in a
// serverless function). Renders a self-contained HTML string (no fetch of a
// gated /admin/applications/[id]/invoice page — that needs an admin session
// which the server-side render path doesn't have).

import { computeVendorPricing, formatRand, type VendorPricing } from '@/lib/payments/pricing'
import { brand } from '@/lib/email/brand'
import { getEftBankDetails, eftReference, onCovertMasterLane, isOwnerVisible, withOwnerVisibleMarker, getPaymentRail, getFullEftMode, type EftBankDetails } from '@/lib/eft'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, hasPaid } from '@/lib/portal-state'
import { vendorHasEftTrail } from '@/lib/payments/vendor-bill'

/**
 * INVOICE-ISSUE SIDE EFFECT (Taona 2026-09-13: "anyone who asks for an invoice
 * gets Samreen's ...629, and if they are on master, the fact that they asked moves
 * them"). Every unpaid invoice now tells the vendor to pay the ...629 account, so a
 * covert master-lane vendor who is issued one must be handed to the owner
 * (⟦OWNERVIS⟧) or their coming payment would reconcile to the covert ...191.
 *
 * WALL GUARD (og-master-lane-eft-never-leaks): NEVER moves a vendor who already has
 * real ...191 EFT money in flight (vendorHasEftTrail) — OWNERVIS would surface that
 * existing payment to Samreen. Only NEVER-PAID masters move. onCovertMasterLane with
 * fullEft=null is conservative (may miss a marker-less frozen member), which is the
 * safe direction: it under-moves, never over-moves. Idempotent; call on every issue.
 * Returns true only when it actually moved someone.
 */
export async function maybeMoveToSamreenOnInvoice(applicationId: string): Promise<boolean> {
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('vendor_applications')
      .select('admin_notes, paid_at')
      .eq('id', applicationId)
      .maybeSingle()
    if (!data) return false
    const notes = (data.admin_notes as string | null) ?? null
    const state = parsePortalState(notes)
    if (hasPaid(state) || data.paid_at) return false   // paid: no ...629 block, nothing to move
    if (isOwnerVisible(notes)) return false            // already hers
    if (vendorHasEftTrail(state)) return false         // WALL: real ...191 money, must not surface
    const fullEft = await getFullEftMode()
    if (fullEft?.protectedIds.has(applicationId)) return false // WALL: frozen cutover set, never surface (even a bare reveal)
    const covert = onCovertMasterLane(applicationId, notes, await getPaymentRail(), fullEft)
    if (!covert) return false                          // a normal Samreen/Yoco vendor is already hers
    await admin.from('vendor_applications').update({ admin_notes: withOwnerVisibleMarker(notes) }).eq('id', applicationId)
    return true
  } catch (e) {
    console.error('[invoice] maybeMoveToSamreenOnInvoice failed:', (e as Error).message)
    return false // never block the invoice send on the move
  }
}

interface InvoiceData {
  businessName: string
  contactName: string
  email: string
  phone?: string
  pricing: VendorPricing
  totalAmount: number
  status: string
  reference: string
  providerRef?: string
  paidAt?: string
  issuedAt: string
  /** How this was actually paid. Undefined = a paid record from before this
   *  field existed; render a neutral "Paid" line rather than guessing. */
  method?: 'yoco' | 'fnb' | 'manual' | 'eft' | 'samreen_eft' | 'cash' | 'manual_card' | 'waived'
  /** EFT banking details for an UNPAID invoice, so the vendor can pay. ALWAYS
   *  Samreen's owner-reconciled account (...629, getEftBankDetails), NEVER the
   *  covert master ...191: anyone who is issued an invoice pays the Samreen rail
   *  (Taona 2026-09-13). Omitted on a paid invoice (the receipt block shows instead). */
  bank?: EftBankDetails
  /** The reference the vendor must use when paying (their business-name token). */
  payReference?: string
  /** Bill the invoice to a THIRD PARTY (e.g. a vendor's booking agency or a
   *  procurement entity) instead of the vendor. When set, the "Billed to" block
   *  shows this entity and notes the stall is for the vendor. Stored per-vendor as
   *  a ⟦BILLTO⟧ marker so the bot's get_invoice reproduces it (Stage Zero / EP
   *  Exhibitions, 2026-09-13). */
  billTo?: { name: string; lines: string[] }
}

const BILLTO_RE = /⟦BILLTO:([A-Za-z0-9+/=]+)⟧/

/** Read a stored third-party bill-to override off admin_notes, if any. */
export function parseBillTo(adminNotes: string | null | undefined): { name: string; lines: string[] } | null {
  const m = BILLTO_RE.exec(adminNotes || '')
  if (!m) return null
  try {
    const o = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'))
    if (o && typeof o.name === 'string' && Array.isArray(o.lines)) return { name: o.name, lines: o.lines.map(String) }
  } catch { /* malformed marker, ignore */ }
  return null
}

/** Serialise a bill-to override into an admin_notes marker (append this). */
export function billToMarker(billTo: { name: string; lines: string[] }): string {
  return `⟦BILLTO:${Buffer.from(JSON.stringify(billTo)).toString('base64')}⟧`
}

const METHOD_LABEL: Record<NonNullable<InvoiceData['method']>, string> = {
  yoco: 'Paid via Yoco (card)',
  fnb: 'Paid via bank transfer',
  manual: 'Paid (recorded manually)',
  eft: 'Paid via EFT',
  samreen_eft: 'Paid via EFT',
  cash: 'Paid via cash',
  manual_card: 'Paid via card (in person)',
  waived: 'Fee waived',
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string))
}

export function buildInvoiceHtml(data: InvoiceData): string {
  const isPaid = data.status === 'paid'
  const rows: string[] = [
    `<tr><td><div class="title">${escapeHtml(data.pricing.stallLabel)}</div><div class="sub">Stall fee, 3 days, setup access</div></td><td class="num">1</td><td class="num">${formatRand(data.pricing.stallPrice)}</td></tr>`,
    ...data.pricing.electricalItems.map(
      (it) => `<tr><td>${escapeHtml(it.label)}<div class="sub">Electrical add-on</div></td><td class="num">${it.qty}</td><td class="num">${formatRand(it.amount)}</td></tr>`
    ),
  ]
  if (data.pricing.chairsQty > 0) {
    rows.push(`<tr><td>Chairs hired<div class="sub">Furniture hire</div></td><td class="num">${data.pricing.chairsQty}</td><td class="num">${formatRand(data.pricing.chairsAmount)}</td></tr>`)
  }
  if (data.pricing.tablesQty > 0) {
    rows.push(`<tr><td>Tables hired<div class="sub">Furniture hire</div></td><td class="num">${data.pricing.tablesQty}</td><td class="num">${formatRand(data.pricing.tablesAmount)}</td></tr>`)
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Invoice ${escapeHtml(data.reference)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  * { box-sizing: border-box; }
  body { font-family: Inter, Arial, sans-serif; color: #171717; margin: 0; padding: 40px; background: #fff; }
  .brand { text-align: center; padding-bottom: 18px; }
  .brand img.logo { display: block; margin: 0 auto 12px; width: 88px; height: 88px; border: 0; }
  .brand .wordmark { font-family: Georgia, 'Times New Roman', serif; font-size: 13px; letter-spacing: 0.32em; text-transform: uppercase; color: #1a1a1a; margin: 0; }
  .brand .kicker-dates { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: #8a8a8a; margin: 6px 0 0; }
  .brand img.accent { display: block; margin: 18px auto 0; width: 100%; height: 4px; border: 0; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; padding: 22px 0 24px; border-bottom: 1px solid #ececec; }
  .kicker { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #7a2d8e; font-weight: 700; }
  h1 { font-family: Georgia, 'Times New Roman', serif; font-size: 26px; margin: 6px 0 4px; color: #1a1a1a; }
  .dates { font-size: 12px; color: #737373; }
  .right { text-align: right; }
  .right .label { font-size: 11px; color: #a3a3a3; text-transform: uppercase; letter-spacing: 0.06em; }
  .right .num { font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 16px; font-weight: 600; margin-top: 2px; }
  .right .issued { font-size: 11px; color: #737373; margin-top: 6px; }
  .badge { display: inline-block; margin-top: 8px; padding: 4px 12px; border-radius: 99px; font-size: 11px; font-weight: 700; }
  .badge.paid { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
  .badge.due { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
  .grid { display: flex; gap: 32px; margin-top: 28px; }
  .grid > div { flex: 1; }
  .grid .label { font-size: 10px; letter-spacing: 0.06em; color: #a3a3a3; text-transform: uppercase; margin-bottom: 8px; }
  .grid .name { font-weight: 600; }
  .grid .line { color: #525252; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; margin-top: 32px; font-size: 13px; }
  thead th { text-align: left; font-weight: 500; color: #737373; border-bottom: 1px solid #e5e5e5; padding-bottom: 8px; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }
  thead th.num { text-align: right; }
  tbody td { padding: 12px 0; border-bottom: 1px solid #f5f5f5; vertical-align: top; }
  tbody td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody td .title { font-weight: 500; }
  tbody td .sub { font-size: 11px; color: #737373; margin-top: 2px; }
  .totals { margin-top: 24px; padding-top: 16px; border-top: 2px solid #171717; display: flex; justify-content: flex-end; gap: 24px; align-items: baseline; }
  .totals .label { font-weight: 600; }
  .totals .amount { font-family: Georgia, 'Times New Roman', serif; font-size: 28px; color: #cd2653; font-weight: 600; }
  .payment { margin-top: 28px; padding: 16px 20px; border-radius: 12px; background: #ecfdf5; border: 1px solid #a7f3d0; }
  .payment .label { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #047857; font-weight: 700; }
  .payment .line { font-size: 13px; color: #404040; margin-top: 4px; }
  .paybox { margin-top: 28px; padding: 18px 20px; border-radius: 12px; background: #fffbeb; border: 1px solid #fde68a; }
  .paybox .label { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #92400e; font-weight: 700; }
  .paybox .line { font-size: 13px; color: #404040; margin-top: 4px; }
  .paybox .bankgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 32px; margin-top: 14px; }
  .paybox .bankgrid > div { display: flex; flex-direction: column; }
  .paybox .bk { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: #a3a3a3; }
  .paybox .bv { font-size: 14px; color: #1a1a1a; font-weight: 600; margin-top: 2px; }
  .paybox .bv.mono { font-family: 'JetBrains Mono', 'Courier New', monospace; letter-spacing: 0.02em; }
  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e5e5e5; font-size: 11px; color: #737373; line-height: 1.5; }
</style></head>
<body>
  <div class="brand">
    <img class="logo" src="${brand.url.logo}" alt="Young at Heart Festival" />
    <div class="wordmark">Cape Town Halaal &middot; Young at Heart Festival</div>
    <div class="kicker-dates">${escapeHtml(brand.contact.dates)} &middot; ${escapeHtml(brand.contact.venue)}</div>
    <img class="accent" src="${brand.url.accent}" alt="" />
  </div>

  <div class="header">
    <div>
      <div class="kicker">Invoice</div>
      <h1>Vendor Stall, Festival 2026</h1>
      <div class="dates">${escapeHtml(brand.contact.venue)}</div>
    </div>
    <div class="right">
      <div class="label">Invoice #</div>
      <div class="num">${escapeHtml(data.reference)}</div>
      <div class="issued">Issued ${escapeHtml(data.issuedAt)}</div>
      ${isPaid ? `<div class="badge paid">PAID${data.paidAt ? ' &middot; ' + escapeHtml(data.paidAt) : ''}</div>` : `<div class="badge due">${escapeHtml(data.status.toUpperCase())}</div>`}
    </div>
  </div>

  <div class="grid">
    <div>
      <div class="label">Billed to</div>
      ${data.billTo ? `<div class="name">${escapeHtml(data.billTo.name)}</div>
      ${data.billTo.lines.map((l) => `<div class="line">${escapeHtml(l)}</div>`).join('\n      ')}
      <div class="line" style="margin-top: 6px; color: #8a8a8a;">Stall for: ${escapeHtml(data.businessName)}</div>` : `<div class="name">${escapeHtml(data.businessName)}</div>
      <div class="line">${escapeHtml(data.contactName)}</div>
      <div class="line">${escapeHtml(data.email)}</div>
      ${data.phone ? `<div class="line">${escapeHtml(data.phone)}</div>` : ''}`}
    </div>
    <div>
      <div class="label">From</div>
      <div class="name">Young at Heart Festival</div>
      <div class="line">${escapeHtml(brand.contact.email)}</div>
      <div class="line">${escapeHtml(brand.contact.phone)}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Description</th><th class="num">Qty</th><th class="num">Amount</th></tr>
    </thead>
    <tbody>
      ${rows.join('\n')}
    </tbody>
  </table>

  <div class="totals">
    <div class="label">Total ${isPaid ? 'paid' : 'due'}</div>
    <div class="amount">${formatRand(data.totalAmount)}</div>
  </div>

  <div style="margin-top: 10px; text-align: right; font-size: 11px; color: #737373;">Young at Heart Festival is not registered for VAT. No VAT is charged on this invoice.</div>

  ${isPaid ? `<div class="payment">
    <div class="label">Payment</div>
    <div class="line">${escapeHtml(data.method ? METHOD_LABEL[data.method] : 'Paid')}${data.paidAt ? ' on ' + escapeHtml(data.paidAt) : ''}. Reference <span style="font-family: monospace;">${escapeHtml(data.providerRef || data.reference)}</span>.</div>
  </div>` : (data.bank ? `<div class="paybox">
    <div class="label">How to pay</div>
    <div class="line">Please pay by EFT into the account below, then email your proof of payment to ${escapeHtml(brand.contact.email)}. Your stall is confirmed once payment reflects.</div>
    <div class="bankgrid">
      <div><span class="bk">Account name</span><span class="bv">${escapeHtml(data.bank.accountName)}</span></div>
      <div><span class="bk">Bank</span><span class="bv">${escapeHtml(data.bank.bank)}${data.bank.accountType ? ' (' + escapeHtml(data.bank.accountType) + ')' : ''}</span></div>
      <div><span class="bk">Account number</span><span class="bv mono">${escapeHtml(data.bank.accountNumber)}</span></div>
      <div><span class="bk">Branch code</span><span class="bv mono">${escapeHtml(data.bank.branchCode)}</span></div>
      <div><span class="bk">Reference</span><span class="bv mono">${escapeHtml(data.payReference || data.reference)}</span></div>
    </div>
    <div class="line" style="margin-top: 12px;">Use the reference above when you pay, so we can match your payment to ${escapeHtml(data.businessName)}.</div>
  </div>` : '')}

  <div class="footer">
    <div>This invoice is issued for the Young at Heart Festival 2026, held ${escapeHtml(brand.contact.dates)} at ${escapeHtml(brand.contact.venue)}.</div>
    <div style="margin-top: 6px;">Stalls are non-refundable per the cancellation policy. Questions: ${escapeHtml(brand.contact.email)}.</div>
  </div>
</body></html>`
}

/**
 * Render the invoice as a PDF buffer. Returns null (and logs) on failure so
 * the caller can still send the email without the attachment.
 */
export async function renderInvoicePdf(input: {
  applicationId: string
  businessName: string
  contactName: string
  email: string
  phone?: string
  amount: number
  status: string
  reference: string
  providerRef?: string
  paidAt?: string
  method?: InvoiceData['method']
  preferredBoothTier: string
  specialRequirements?: unknown
}): Promise<Buffer | null> {
  let pricing: VendorPricing
  try {
    pricing = computeVendorPricing({
      preferred_booth_tier: input.preferredBoothTier,
      special_requirements: input.specialRequirements,
    })
  } catch (e) {
    console.error('[invoice-pdf] pricing failed:', (e as Error).message)
    return null
  }

  // Unpaid invoice: show HOW to pay. Always the Samreen ...629 rail, never the
  // covert ...191 (Taona 2026-09-13: invoice-requesters use the owner-reconciled
  // account). A paid invoice shows the receipt block instead, so no bank block.
  const unpaid = input.status !== 'paid'
  // Issuing an unpaid invoice tells the vendor to pay Samreen's ...629, so hand a
  // never-paid master vendor to the owner now (gated, wall-safe; see
  // maybeMoveToSamreenOnInvoice). Single choke point: every issue path and the
  // backfill route through renderInvoicePdf, so none can forget the move.
  if (unpaid) await maybeMoveToSamreenOnInvoice(input.applicationId)
  // A stored third-party bill-to (⟦BILLTO⟧) makes every issue path, incl. the bot's
  // get_invoice, bill the vendor's agency/procurement entity (Stage Zero -> EP Exhibitions).
  let billTo: { name: string; lines: string[] } | undefined
  try {
    const { data } = await createAdminClient().from('vendor_applications').select('admin_notes').eq('id', input.applicationId).maybeSingle()
    billTo = parseBillTo(data?.admin_notes as string | null) ?? undefined
  } catch { /* no override, bill the vendor */ }
  const html = buildInvoiceHtml({
    businessName: input.businessName,
    contactName: input.contactName,
    email: input.email,
    phone: input.phone,
    pricing,
    totalAmount: input.amount,
    status: input.status,
    reference: input.reference,
    providerRef: input.providerRef,
    paidAt: input.paidAt,
    method: input.method,
    billTo,
    issuedAt: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
    bank: unpaid ? getEftBankDetails() : undefined,
    payReference: unpaid ? eftReference({ id: input.applicationId, business_name: input.businessName }) : undefined,
  })

  try {
    const chromium = (await import('@sparticuz/chromium-min')).default
    const puppeteer = (await import('puppeteer-core')).default

    const executablePath = await chromium.executablePath(
      'https://github.com/Sparticuz/chromium/releases/download/v147.0.0/chromium-v147.0.0-pack.x64.tar'
    )
    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: true,
    })
    try {
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'load' })
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '18mm', right: '18mm' } })
      return Buffer.from(pdf)
    } finally {
      await browser.close()
    }
  } catch (e) {
    console.error('[invoice-pdf] render failed:', (e as Error).message)
    return null
  }
}
