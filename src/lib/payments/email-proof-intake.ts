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

type Db = ReturnType<typeof createAdminClient>

export interface IntakeVendor {
  id: string
  business_name?: string | null
  contact_name?: string | null
  email?: string | null
  phone?: string | null
  admin_notes?: string | null
  paid_at?: string | null
}

const VENDOR_COLS = 'id, business_name, contact_name, email, phone, admin_notes, paid_at'

/** Gmail ignores dots and anything after '+' in the local part. */
export function gmailKey(email: string): string {
  const [local, domain] = email.toLowerCase().trim().split('@')
  if (!domain || !/^(gmail|googlemail)\.com$/.test(domain)) return email.toLowerCase().trim()
  return `${local.split('+')[0].replace(/\./g, '')}@gmail.com`
}

export async function resolveVendorForEmail(db: Db, fromAddress: string, exact: IntakeVendor | null): Promise<IntakeVendor | null> {
  if (exact) return exact
  const from = fromAddress.toLowerCase()
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

    const alreadyLane = vendorInEftLane(vendor.admin_notes || '', await getEftMode(), vendor.paid_at ?? null, { email: vendor.email, phone: vendor.phone })
    if (!looksLikeProofEmail({ subject: a.subject, body: a.body, attachments: a.attachments, alreadyLane })) return errors
    const att = pickProofAttachment(a.attachments)
    if (!att?.content) return errors

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
      note: `emailed proof of payment (subject: "${a.subject.slice(0, 120)}")`,
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
