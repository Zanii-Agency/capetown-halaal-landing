// Email Stage Zero + The Plug their invoices (Taona 2026-09-13). Stage Zero is
// billed to EP Exhibitions (their agency, stored as ⟦BILLTO⟧); The Plug's tier is
// already the Double Table 4x2m they changed to. Renders via the LOCAL system
// Chrome (the serverless @sparticuz chromium is a Linux binary, inert on macOS).
//   node --env-file=.env.local --import tsx scripts/_send-two-invoices-2026-09-13.tsx        # DRY: render PDFs, no send
//   SEND=1 node --env-file=.env.local --import tsx scripts/_send-two-invoices-2026-09-13.tsx # send
import { config } from 'dotenv'; config({ path: '.env.local' })
import fs from 'node:fs'
import { createAdminClient } from '../src/lib/supabase/admin'
import { buildInvoiceHtml, maybeMoveToSamreenOnInvoice, parseBillTo } from '../src/lib/payments/invoice-pdf'
import { getEftBankDetails, eftReference } from '../src/lib/eft'
import { computeVendorPricing } from '../src/lib/payments/pricing'
import { invoiceReplyText } from '../src/lib/payments/invoice-email-autoreply'
import { sendEmail } from '../src/lib/email/resend'

const DRY = process.env.SEND !== '1'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

async function renderLocal(html: string): Promise<Buffer> {
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    await new Promise((r) => setTimeout(r, 800)) // let the remote logo/accent images paint
    return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '18mm', right: '18mm' } }))
  } finally { await browser.close() }
}

async function main() {
  const db = createAdminClient()
  const targets = [
    { q: '%stage zero%', invNo: 'YAH-2026-0148' },
    { q: '%plug fragrance%', invNo: 'YAH-2026-0149' },
  ]
  for (const t of targets) {
    const { data } = await db.from('vendor_applications').select('id, business_name, contact_name, email, phone, admin_notes, preferred_booth_tier, special_requirements').ilike('business_name', t.q).limit(1)
    const v = (data || [])[0]; if (!v) { console.log('NOT FOUND', t.q); continue }
    const pricing = computeVendorPricing({ preferred_booth_tier: v.preferred_booth_tier as string, special_requirements: v.special_requirements })
    const bank = getEftBankDetails()
    const billTo = parseBillTo(v.admin_notes as string) ?? undefined
    const first = (v.contact_name as string || '').trim().split(/\s+/)[0] || (v.business_name as string)
    const html = buildInvoiceHtml({
      businessName: v.business_name as string, contactName: (v.contact_name as string) || '', email: (v.email as string) || '',
      phone: (v.phone as string) || undefined, pricing, totalAmount: pricing.total, status: 'due',
      reference: t.invNo, payReference: eftReference({ id: v.id as string, business_name: v.business_name as string }),
      bank, billTo, issuedAt: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
    })
    const pdf = await renderLocal(html)
    const path = `scratchpad/invoice-${(v.business_name as string).replace(/\W+/g, '-')}.pdf`
    fs.writeFileSync(path, pdf)
    console.log(`${v.business_name}: ${pricing.stallLabel} R${pricing.total} | billTo=${billTo?.name || '(vendor)'} | pdf ${pdf.length}b -> ${path} | to ${v.email}`)
    if (DRY) continue
    await maybeMoveToSamreenOnInvoice(v.id as string)
    const r = await sendEmail({
      to: v.email as string, subject: 'Your invoice, Young at Heart Festival 2026',
      text: invoiceReplyText(first, v.business_name as string, true),
      attachments: [{ filename: `Invoice-${(v.business_name as string).replace(/\W+/g, '')}.pdf`, content: pdf, contentType: 'application/pdf' }],
    })
    console.log(r.ok ? (r.suppressed ? '  SUPPRESSED (not delivered)' : '  EMAIL SENT') : `  FAILED: ${r.error}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
