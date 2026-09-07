// Auto-reply to invoice-request emails: attach the CTH-themed invoice PDF and
// note we are not VAT registered, or point the vendor to their portal.
//
// Taona 2026-09-07: "any vendor that requires an invoice, first tell them an
// invoice can be provided though we are not VAT registered, then generate one
// according to the theme of CTH, send it by email directly or tell them to log
// in their portal. Autonomous, only if the person is requesting their invoice."
//
// Runs in the email-concierge cron (every 2 min), AFTER the plan auto-reply so a
// plan request wins if an email asks for both. Idempotent per thread.

import type { createAdminClient } from '@/lib/supabase/admin'
import { rowToEmail, sendEmailReply } from '@/lib/email-concierge'
import { resolveVendorForEmail } from '@/lib/payments/email-proof-intake'
import { parsePortalState } from '@/lib/portal-state'
import { renderInvoicePdf } from '@/lib/payments/invoice-pdf'
import { paymentReference } from '@/lib/payments'
import { computeVendorPricing } from '@/lib/payments/pricing'

type Db = ReturnType<typeof createAdminClient>

const PORTAL = 'cthalaal.co.za/exhibitor'

// A genuine request to SEE / GET their invoice. Gated at the call site to a
// resolved vendor, so a stray "invoice" in a supplier quote can never trigger it.
const INVOICE_RE = new RegExp(
  [
    '\\binvoice\\b', '\\bbill\\b(?!board)', 'proof\\s*of\\s*(booking|registration)',
    'for\\s*my\\s*records', 'tax\\s*invoice', 'receipt\\s*for',
  ].join('|'),
  'i',
)

export function isInvoiceRequestEmail(subject: string | null | undefined, body: string | null | undefined): boolean {
  return INVOICE_RE.test(`${subject || ''}\n${body || ''}`)
}

export function invoiceReplyText(firstName: string, business: string, attached: boolean): string {
  const first = (firstName || 'there').trim() || 'there'
  const biz = (business || 'your stall').trim()
  const lines = [
    `Salaam ${first},`,
    '',
    `Thank you for your message. We can absolutely provide an invoice for ${biz}. Please note that the Young at Heart Festival is not registered for VAT, so no VAT is charged and the invoice does not show VAT.`,
    '',
    attached
      ? 'Your invoice is attached to this email. You can also view and download it any time by logging into your portal at ' + PORTAL + ' under Payments.'
      : 'You can view and download your invoice any time by logging into your portal at ' + PORTAL + ' under Payments.',
    '',
    'Jazakallah khair,',
    'The Young at Heart Festival Team',
  ]
  return lines.join('\n')
}

const AUTO = 'auto_replied_invoice'

interface FullVendor {
  id: string; business_name: string | null; contact_name: string | null; email: string | null
  phone: string | null; admin_notes: string | null; paid_at: string | null
  preferred_booth_tier: string | null; special_requirements: unknown
}

/** Scan NEW inbound for invoice-request emails from resolvable vendors, attach the
 *  themed invoice PDF and reply once per thread. Best-effort: never throws. */
export async function runInvoiceAutoReplies(db: Db): Promise<{ replied: number; skipped: number; errors: string[] }> {
  const out = { replied: 0, skipped: 0, errors: [] as string[] }
  try {
    const { data: rows } = await db
      .from('support_inbox_messages')
      .select('id, thread_id, from_address, from_name, to_address, subject, body_text, message_id, mailbox, direction, concierge_status, received_at')
      .is('concierge_status', null)
      .eq('direction', 'in')
      .order('received_at', { ascending: true })
      .limit(50)

    for (const m of rows || []) {
      const from = String(m.from_address || '').toLowerCase()
      if (!from) continue
      if (!isInvoiceRequestEmail(m.subject as string, m.body_text as string)) continue

      const resolved = await resolveVendorForEmail(db, from, null)
      if (!resolved) continue
      // Need the tier + requirements for pricing, which the resolver does not carry.
      const { data: v } = await db
        .from('vendor_applications')
        .select('id, business_name, contact_name, email, phone, admin_notes, paid_at, preferred_booth_tier, special_requirements')
        .eq('id', resolved.id)
        .maybeSingle()
      const vendor = v as FullVendor | null
      if (!vendor) continue

      // One auto-reply per thread.
      const { data: prior } = await db
        .from('support_inbox_messages')
        .select('id').eq('thread_id', m.thread_id as string).eq('concierge_status', AUTO).limit(1)
      if (prior && prior.length) {
        await db.from('support_inbox_messages').update({ concierge_status: 'skipped' }).eq('id', m.id as string)
        out.skipped += 1
        continue
      }

      const state = parsePortalState(vendor.admin_notes || '')
      const amount = state.payment?.amount ?? (() => {
        try { return computeVendorPricing({ preferred_booth_tier: vendor.preferred_booth_tier || '', special_requirements: vendor.special_requirements }).total } catch { return 0 }
      })()
      let pdf: Buffer | null = null
      try {
        pdf = await renderInvoicePdf({
          applicationId: vendor.id,
          businessName: vendor.business_name || 'Vendor',
          contactName: vendor.contact_name || '',
          email: vendor.email || from,
          phone: vendor.phone || undefined,
          amount,
          status: state.payment?.status || (vendor.paid_at ? 'paid' : 'none'),
          reference: state.payment?.reference || paymentReference(vendor.id),
          providerRef: state.payment?.provider_ref || '',
          method: state.payment?.method,
          preferredBoothTier: vendor.preferred_booth_tier || '',
          specialRequirements: vendor.special_requirements,
        })
      } catch (e) { out.errors.push(`invoice render ${from}: ${(e as Error).message}`) }

      const first = String(vendor.contact_name || m.from_name || 'there').trim().split(/\s+/)[0] || 'there'
      const text = invoiceReplyText(first, String(vendor.business_name || 'your stall'), !!pdf)
      const slug = (vendor.business_name || 'invoice').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'invoice'
      const res = await sendEmailReply(
        rowToEmail(m as Record<string, unknown>),
        text,
        pdf ? { attachment: { filename: `CTH-Invoice-${slug}.pdf`, content: pdf, contentType: 'application/pdf' } } : undefined,
      )
      if (res.ok) {
        await db.from('support_inbox_messages').update({ concierge_status: AUTO, concierge_draft: text }).eq('id', m.id as string)
        out.replied += 1
      } else {
        out.errors.push(`${from}: ${res.error}`)
      }
    }
  } catch (e) {
    out.errors.push((e as Error).message)
  }
  return out
}
