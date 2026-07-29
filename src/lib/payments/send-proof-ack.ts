// Delivers the proof-of-payment acknowledgement. One sender, two callers: the
// eft-proof upload route (automatic) and a catch-up script for vendors who
// uploaded before this existed.
//
// Best-effort by contract. An acknowledgement must never be able to fail the
// upload itself: the vendor's proof is already saved by the time this runs, and
// losing the upload to a mail error would be far worse than a missing thank-you.

import { sendEmail } from '@/lib/email/resend'
import { sendTemplate, sendText, toE164 } from '@/lib/whatsapp'
import { windowOpenFor } from '@/lib/wa-window'
import { proofAckSubject, proofAckText, proofAckWhatsApp, hasLongDash } from '@/lib/payments/proof-ack'

export interface ProofAckResult { email: boolean; whatsapp: boolean; errors: string[] }

export async function sendProofAck(v: {
  businessName: string
  contactName?: string | null
  email?: string | null
  phone?: string | null
}): Promise<ProofAckResult> {
  const biz = (v.businessName || 'your business').trim()
  const first = (v.contactName || 'there').trim().split(/\s+/)[0] || 'there'
  const out: ProofAckResult = { email: false, whatsapp: false, errors: [] }

  const text = proofAckText(first, biz)
  const wa = proofAckWhatsApp(biz)
  const subject = proofAckSubject(biz)

  // Law 7, asserted rather than assumed. Refuse to send rather than ship a dash
  // into vendor-facing copy.
  if (hasLongDash(text) || hasLongDash(wa) || hasLongDash(subject)) {
    out.errors.push('refused: long dash in vendor-facing copy (law 7)')
    return out
  }

  if (v.email) {
    try {
      const r = await sendEmail({ to: v.email, subject, text })
      if (r.ok) out.email = true
      else out.errors.push(`email: ${r.error}`)
    } catch (e) { out.errors.push(`email: ${(e as Error).message}`) }
  } else out.errors.push('email: none on file')

  // Free text inside the 24h window keeps the line breaks that make the channel
  // list readable. Outside it, the approved template is the only way through,
  // and it flattens to one paragraph, which is acceptable for an ack.
  if (v.phone) {
    const e164 = toE164(v.phone)
    try {
      if (await windowOpenFor(e164)) {
        const r = await sendText(e164, wa)
        if (!r.skipped) out.whatsapp = true
        else out.errors.push(`whatsapp: ${r.skipped}`)
      } else {
        const flat = wa.replace(/\s*\n\s*/g, ' ')
        const r = await sendTemplate(e164, 'festival_announcement', [first, flat], { category: 'utility' })
        if (!r.skipped) out.whatsapp = true
        else out.errors.push(`whatsapp: ${r.skipped}`)
      }
    } catch (e) { out.errors.push(`whatsapp: ${(e as Error).message}`) }
  } else out.errors.push('whatsapp: no phone on file')

  return out
}
