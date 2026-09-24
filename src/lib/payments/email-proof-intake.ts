// ONE emailed-proof intake for both mail crons (support@youngatheart.co.za and
// Samreen's capetownhalaal@gmail.com). Until 2026-09-05 only the support fetcher
// had this block, so a proof mailed to her gmail (Telkom R4,800, Island Way
// Sorbet's bank confirmation) sat as an ordinary thread and never reached
// /admin/eft-proofs. Same-node fix: the logic lives here, the fetchers call it.
//
// Vendor resolution is wider than exact sender email (the 2026-09-01 misses):
//   1. exact email match (already done by the caller, passed in)
//   2. gmail dot/plus-insensitive match (shameemakhan87@ vs shameemakhan.87@)
//   3. the thread's existing vendor_application_id (a human linked it)
//   4. still nothing but it LOOKS like a proof -> alert the master with the
//      sender + subject so a person files it, instead of silent loss.

import type { createAdminClient } from '@/lib/supabase/admin'
import { looksLikeProofEmail, pickProofAttachment, type ProofAttachment } from '@/lib/payments/email-proof-detect'
import { parsePortalState, hasPaid } from '@/lib/portal-state'

type Db = ReturnType<typeof createAdminClient>

export interface IntakeVendor {
  id: string
  business_name?: string | null
  contact_name?: string | null
  email?: string | null
  phone?: string | null
  admin_notes?: string | null
  paid_at?: string | null
  status?: string | null
}

const VENDOR_COLS = 'id, business_name, contact_name, email, phone, admin_notes, paid_at, status'

/** Only a vendor who is actually supposed to pay a stall fee can have an emailed
 *  proof auto-filed against them (Taona 2026-09-14, after a PENDING applicant's
 *  reply-with-the-event-poster was captured as an EFT proof and hid them from
 *  Samreen). A proof presupposes an approved vendor with an outstanding balance:
 *  a pending/rejected/waitlisted applicant has no fee due, so an image they mail
 *  is never a stall payment. Withdrawn vendors are out too. This gates the
 *  auto-file only; a genuine proof from a non-approved sender still surfaces to a
 *  human via the master alert below, it is just never silently laned covert. */
export function isEligiblePayer(v: IntakeVendor): boolean {
  if ((v.status || '').toLowerCase() !== 'approved') return false
  if (v.paid_at) return false
  // SETTLED BY EFT TOO, not just by card. An EFT vendor marked `collected` has no
  // paid_at column, so Zayaan Wellness (collected 23 Aug) still read as owing and
  // her 16 Sep email (both duplicate-payment proofs + her bank details FOR A REFUND)
  // was filed as a new master payment. A settled vendor mailing a proof is a
  // duplicate / refund / accessory matter for a human, never a stall payment.
  if (hasPaid(parsePortalState(v.admin_notes))) return false
  return true
}

/** Gmail ignores dots and anything after '+' in the local part. */
export function gmailKey(email: string): string {
  const [local, domain] = email.toLowerCase().trim().split('@')
  if (!domain || !/^(gmail|googlemail)\.com$/.test(domain)) return email.toLowerCase().trim()
  return `${local.split('+')[0].replace(/\./g, '')}@gmail.com`
}

export async function resolveVendorForEmail(db: Db, fromAddress: string, exact: IntakeVendor | null): Promise<IntakeVendor | null> {
  if (exact) return exact
  const from = fromAddress.toLowerCase()
  // 1. exact registered-email match (any domain), case-insensitive. The proof
  //    fetcher passes its own exact hit as `exact`; the plan/invoice auto-replies
  //    pass null, so without this they resolved a non-gmail vendor ONLY when a
  //    thread was already linked. A vendor emailing from their registered address
  //    must resolve directly. (E2E gap found 2026-09-07.)
  if (!/@(gmail|googlemail)\.com$/.test(from)) {
    const { data } = await db.from('vendor_applications').select(VENDOR_COLS).ilike('email', from).limit(1)
    if (data && data[0]) return data[0] as IntakeVendor
  }
  // 2. gmail-normalised match. Only gmail senders can differ this way, and the
  //    candidate set is small enough to compare in memory.
  if (/@(gmail|googlemail)\.com$/.test(from)) {
    const want = gmailKey(from)
    const { data } = await db.from('vendor_applications').select(VENDOR_COLS).ilike('email', '%@gmail.com')
    const hit = (data || []).find((v) => gmailKey(String(v.email || '')) === want)
    if (hit) return hit as IntakeVendor
  }
  // 3. a thread already linked to a vendor by a human or an earlier match.
  const { data: thread } = await db.from('support_inbox_threads').select('vendor_application_id').eq('peer_email', from).maybeSingle()
  const linked = (thread as { vendor_application_id?: string | null } | null)?.vendor_application_id
  if (linked) {
    const { data } = await db.from('vendor_applications').select(VENDOR_COLS).eq('id', linked).maybeSingle()
    if (data) return data as IntakeVendor
  }
  return null
}

export interface IntakeArgs {
  db: Db
  vendor: IntakeVendor | null
  fromAddress: string
  subject: string
  body: string
  attachments: ProofAttachment[]
  messageId: string
  mailbox: 'support' | 'gmail'
}

/** Best-effort: never throws, never blocks the inbox ingest. Returns error strings. */
export async function fileEmailedProof(a: IntakeArgs): Promise<string[]> {
  const errors: string[] = []
  if (!a.attachments.length) return errors
  try {
    const { vendorInEftLane, getEftMode, getPaymentRail, markVendorToldEft } = await import('@/lib/eft')
    const vendor = await resolveVendorForEmail(a.db, a.fromAddress, a.vendor)

    if (!vendor) {
      // 4. Proof-looking mail from an address we cannot tie to a vendor. A bank's
      //    own "Payment confirmation" (payer named only inside the PDF) lands here.
      if (looksLikeProofEmail({ subject: a.subject, body: a.body, attachments: a.attachments })) {
        const { notifyOwners } = await import('@/lib/bot/notify')
        await notifyOwners({ event: 'system_alert', audience: 'master', body: `Proof of payment emailed to ${a.mailbox === 'gmail' ? 'capetownhalaal@gmail.com' : 'support@'} from ${a.fromAddress} ("${a.subject.slice(0, 80)}") but no vendor matches that address. Open the thread in /admin/inbox, identify the vendor and file it from their profile.` })
      }
      return errors
    }
    if (vendor.paid_at) return errors // zanii-codef: settled stall; accessory top-ups still arrive via WhatsApp/portal

    // MUST BE A VENDOR WHO IS SUPPOSED TO PAY (Taona 2026-09-14). Only an approved,
    // owing, non-withdrawn vendor can have an emailed proof auto-filed. A pending or
    // rejected applicant replying to a blast (e.g. with the event poster attached)
    // has no stall fee due, so that image is never a stall payment and must never
    // lane them covert. A genuine proof from a non-approved sender is still surfaced
    // to a human via the master alert rather than dropped.
    const portalMod = await import('@/lib/portal-state')
    if (!isEligiblePayer(vendor) || portalMod.isWithdrawn(portalMod.parsePortalState(vendor.admin_notes || ''))) {
      if (looksLikeProofEmail({ subject: a.subject, body: a.body, attachments: a.attachments })) {
        const { notifyOwners } = await import('@/lib/bot/notify')
        await notifyOwners({ event: 'system_alert', audience: 'master', body: `${vendor.business_name || a.fromAddress} (status: ${vendor.status || 'unknown'}) emailed a possible proof of payment but is not an approved vendor with a fee still owing (already settled means a duplicate, refund or accessory matter), so it was NOT auto-filed. Review the thread in /admin/inbox.` })
      }
      return errors
    }

    const alreadyLane = vendorInEftLane(vendor.admin_notes || '', await getEftMode(), vendor.paid_at ?? null, { email: vendor.email, phone: vendor.phone })
    if (!looksLikeProofEmail({ subject: a.subject, body: a.body, attachments: a.attachments, alreadyLane })) return errors
    const att = pickProofAttachment(a.attachments)
    if (!att?.content) return errors

    // READ an attachment before filing it. The email path had no content gate, so a
    // replied-with-poster passed looksLikeProofEmail (a text/lane heuristic) and was
    // filed as an EFT proof. Now the file must be CONFIRMED a real bank proof (bank +
    // amount) before filing: an image via vision, a PDF via its text + an LLM verdict.
    // A poster/flyer/menu/invoice/quote, or a file that cannot be read, is surfaced to
    // the master instead of auto-filed. Both modalities share one standard.
    const attType = (att.contentType || '').toLowerCase()
    const isImage = /^image\//i.test(attType)
    const isPdf = /pdf/i.test(attType) || /\.pdf$/i.test(att.filename || '')
    let proofBank: string | null = null
    let proofAmount: string | null = null
    const alertNotProof = async (why: string) => {
      const { notifyOwners } = await import('@/lib/bot/notify')
      await notifyOwners({ event: 'system_alert', audience: 'master', body: `${vendor.business_name || a.fromAddress} emailed a file but ${why}. It was NOT filed as a proof. Check the thread in /admin/inbox if it was meant as one.` })
    }
    if (isImage) {
      const { seeImageBytes } = await import('@/lib/bot/see-image')
      // Longer vision timeout than the WhatsApp path: this runs in the mail cron,
      // not on Meta's webhook-retry clock, and an emailed proof can be a full-res
      // photo/screenshot that the WhatsApp 8s cap times out on (a 1.8MB PNG did).
      const seen = await seeImageBytes(att.content, att.contentType, 25_000)
      if (!seen || !seen.isPaymentProof) {
        await alertNotProof(seen ? `it is not a payment proof (${seen.description.slice(0, 100)})` : 'the image could not be read automatically')
        return errors
      }
      proofBank = seen.bankName ?? null
      proofAmount = seen.amount ?? null
    } else if (isPdf) {
      // PDFs are the canonical bank-confirmation format, but an invoice, quote,
      // statement, menu or poster can also arrive as a PDF. Read the text layer and
      // let the model rule proof vs not-proof, same standard as the image vision gate.
      // A scanned image-only PDF has no text to read, so it cannot be auto-verified
      // and is surfaced to a human rather than filed on the filename alone.
      const { extractPdfText, classifyProofText } = await import('@/lib/payments/proof-content')
      const text = await extractPdfText(att.content)
      const verdict = text ? await classifyProofText(text) : null
      if (!verdict || !verdict.isPaymentProof) {
        await alertNotProof(!text ? 'the PDF has no readable text (a scanned image) and could not be auto-verified'
          : verdict ? `the PDF is not a payment proof (${verdict.description.slice(0, 100)})`
          : 'the PDF text could not be read automatically')
        return errors
      }
      proofBank = verdict.bankName
      proofAmount = verdict.amount
    }

    const { parsePortalState } = await import('@/lib/portal-state')
    const notesNow = vendor.admin_notes ?? null
    // First-proof gate that survives a write outage: keyed ALSO off whether this
    // exact email was already ingested (a read), so a re-fetch never re-acks.
    const { data: alreadyIngested } = await a.db.from('support_inbox_messages').select('id').eq('message_id', a.messageId).maybeSingle()
    const isFirstProof = !alreadyIngested && !parsePortalState(notesNow || '').payment?.eft_submitted_at

    // ACK ON RECEIPT, not on filing (Papa Chai 2026-09-04: the capture threw and
    // the ack was lost with it). recordEftProof's own ack is skipped below.
    if (isFirstProof) {
      try {
        const { sendProofAck } = await import('@/lib/payments/send-proof-ack')
        const ack = await sendProofAck({ businessName: vendor.business_name ?? 'your business', contactName: vendor.contact_name, email: vendor.email, phone: vendor.phone })
        if (!ack.email && !ack.whatsapp) errors.push(`proof-ack ${a.fromAddress}: ${ack.errors.join('; ')}`)
      } catch (e) { errors.push(`proof-ack ${a.fromAddress}: ${(e as Error).message}`) }
    }

    // RAIL-AWARE covert laning, identical to the WhatsApp path: ⟦EFT⟧ (hide from
    // Samreen) ONLY on the master rail. On samreen_eft the proof is captured but
    // not laned, so eftProofVisibleToOwner can surface it on HER page.
    if ((await getPaymentRail()) === 'master' && !alreadyLane) {
      await markVendorToldEft({ email: vendor.email, phone: vendor.phone })
    }
    const { recordEftProof } = await import('@/lib/payments/eft-proof-shared')
    const result = await recordEftProof({
      applicationId: vendor.id,
      admin_notes: notesNow,
      paid_at: vendor.paid_at ?? null,
      email: vendor.email ?? null,
      phone: vendor.phone ?? null,
      business_name: vendor.business_name ?? null,
      contact_name: vendor.contact_name ?? null,
      file: { bytes: att.content, name: att.filename || 'proof-of-payment', type: att.contentType },
      note: `emailed proof of payment${proofBank ? ` (${proofBank}${proofAmount ? ` ${proofAmount}` : ''})` : ''} (subject: "${a.subject.slice(0, 120)}")`,
      source: 'email',
      captureRegardless: true,
      skipAck: true,
    })
    if (!result.ok) {
      errors.push(`eft-proof ${a.fromAddress}: ${result.error}`)
      try {
        const { notifyOwners } = await import('@/lib/bot/notify')
        await notifyOwners({ event: 'system_alert', audience: 'master', body: `Could not auto-file ${vendor.business_name || a.fromAddress}'s emailed proof of payment (${result.error}). They have been acknowledged; file it from their profile.` })
      } catch { /* best-effort */ }
    }
  } catch (e) {
    errors.push(`eft-proof ${a.fromAddress}: ${(e as Error).message}`)
  }
  return errors
}
