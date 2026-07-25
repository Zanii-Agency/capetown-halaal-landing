// One-off: send Saba's EXACT methodless "payment received" invoice to the operator
// (taonac96@gmail.com) as a preview of what a vendor sees after "Mark Collected".
//
// MIRROR-FREE: calls Resend RAW (not lib/email/resend sendEmail), so
// mirrorOutboundToSupportInbox is NEVER called -> no support_inbox_messages /
// mail_messages row -> nothing in the unified inbox -> no leak to Samreen.
//
// Pure preview: does NOT change Saba's payment state.
//   node --import tsx scripts/_send-saba-invoice.tsx           # DRY (render only)
//   SEND=1 node --import tsx scripts/_send-saba-invoice.tsx    # actually send
// Run with Node 22.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { render } from '@react-email/components'
import { Resend } from 'resend'
import { VendorPaymentConfirmation } from '../src/lib/email/templates/VendorPaymentConfirmation'
import { computeVendorPricing } from '../src/lib/payments/pricing'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
for (const line of fs.readFileSync(path.join(repo, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/i)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const SEND = process.env.SEND === '1'
const TO = 'taonac96@gmail.com'
const FROM = 'Young at Heart Festival <support@youngatheart.co.za>'
const SITE = 'https://cthalaal.co.za'

async function main() {
  // Saba (3e95b22c) — real data, methodless render as it would appear once collected.
  const pricing = computeVendorPricing({ preferred_booth_tier: 'marquee-full-3x3', special_requirements: null })
  const amount = pricing.total
  const paidDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  const subject = 'Payment confirmed, Saba, Young at Heart Festival 2026'

  const html = await render(
    VendorPaymentConfirmation({
      contactName: 'Nazley',
      businessName: 'Saba',
      amount,
      providerRef: '',
      reference: 'YAH-3E95B22C',
      paidDate,
      pricing,
      invoiceUrl: `${SITE}/exhibitor/portal/invoice`,
      portalUrl: `${SITE}/exhibitor/login`,
    }),
  )

  // Method-leak check on VISIBLE text (strip tags), word-boundary so "left" etc.
  // never false-positives. Print context for any real match.
  const visible = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ')
  const realMention = /\b(eft|yoco)\b/i.test(visible)
  console.log(`to=${TO} | subject="${subject}" | amount=R${amount} | reference=YAH-3E95B22C`)
  console.log(`html: ${html.length} chars | method named in visible text? ${realMention ? 'YES (BUG)' : 'no'}`)
  if (realMention) for (const m of visible.matchAll(/.{0,30}\b(eft|yoco)\b.{0,30}/gi)) console.log('  ctx:', JSON.stringify(m[0]))

  if (!SEND) { console.log('DRY RUN — nothing sent. Re-run with SEND=1.'); return }

  const key = process.env.RESEND_API_KEY
  if (!key) { console.error('RESEND_API_KEY missing at runtime'); process.exit(1) }
  const resend = new Resend(key)
  const res = await resend.emails.send({ from: FROM, to: TO, subject, html })
  if (res.error) { console.error('Resend error:', JSON.stringify(res.error)); process.exit(1) }
  console.log('SENT — resend message id:', res.data?.id)
}

main().catch((e) => { console.error(e); process.exit(1) })
