// Handle a vendor sending an EFT proof of payment over WhatsApp.
//
// The portal is the preferred upload surface, but vendors often just reply with
// a screenshot or PDF on WhatsApp. This helper detects that, moves them onto the
// EFT lane if they were not already, records the proof in the same bucket and
// portal state as a portal upload, alerts the master, and replies to the vendor.
// It is deliberately eager for known vendors: a payment proof is time-sensitive
// and falling back to "thanks for your document" loses money.

import type { InboundMedia } from '@/lib/whatsapp'
import { fetchMediaBytes } from '@/lib/whatsapp'
import { seeImage, type SeenImage } from '@/lib/bot/see-image'
import { markVendorToldEft, vendorInEftLane, getEftMode, getPaymentRail, withEftMarker } from '@/lib/eft'
import { recordEftProof } from '@/lib/payments/eft-proof-shared'
import { resolveIdentity } from '@/lib/bot/identity'
import { createAdminClient } from '@/lib/supabase/admin'

const PROOF_KEYWORDS_RE = /\b(proof\s*of\s*payment|pop|eft|bank\s*transfer|deposit|paid|payment|reference|ref\s*[:#])\b/i

async function extractPdfText(buf: Buffer, maxChars = 8000): Promise<string | null> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(buf))
    const { text } = await extractText(pdf, { mergePages: true })
    const raw = Array.isArray(text) ? text.join('\n') : String(text || '')
    const cleaned = raw.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    return cleaned.length > maxChars ? cleaned.slice(0, maxChars) + '\n\n[…truncated]' : cleaned
  } catch (e) {
    console.warn('[handle-eft-proof-media] pdf text extraction failed:', (e as Error).message)
    return null
  }
}

function looksLikePaymentProof(caption: string): boolean {
  return PROOF_KEYWORDS_RE.test(caption)
}

function extractReference(text: string): string | null {
  // CTH reference, stall code, or a numeric reference near the word reference/ref.
  const cth = text.match(/\bCTH[A-Z0-9]{4,}\b/i)
  if (cth) return cth[0].toUpperCase()
  const ref = text.match(/\b(?:reference|ref)[\s:#]*([A-Z0-9\-]{4,})\b/i)
  if (ref) return ref[1].toUpperCase()
  return null
}

async function isProofMedia(
  media: InboundMedia,
  caption: string,
  seen?: SeenImage | null,
): Promise<{ yes: boolean; note: string }> {
  // Images: use vision when available. The caller may already have looked.
  if (media.kind === 'image') {
    const img = seen ?? (await seeImage(media.id, media.mimeType))
    if (img) {
      return {
        yes: img.isPaymentProof,
        note: img.description,
      }
    }
  }

  // Documents (PDF): try to read any text layer and look for payment signals.
  if (media.kind === 'document' && media.mimeType === 'application/pdf') {
    const bytes = await fetchMediaBytes(media.id)
    if (bytes) {
      const text = await extractPdfText(bytes.bytes, 8000)
      if (text && (looksLikePaymentProof(text) || looksLikePaymentProof(caption))) {
        const ref = extractReference(text) || extractReference(caption) || null
        return { yes: true, note: ref ? `reference ${ref}` : 'document text looks like a payment proof' }
      }
    }
  }

  // Fall back to caption keywords and existing lane membership.
  return { yes: looksLikePaymentProof(caption), note: caption }
}

export type EftMediaResult =
  | { handled: true; reply: string; laneAdded: boolean }
  | { handled: false }

/**
 * Inspect an inbound WhatsApp media message. If it looks like an EFT proof from a
 * known vendor, record it, lane the vendor, alert the master, and return a reply.
 * Returns handled:false when the media is not a proof or the sender is unknown.
 */
export async function tryHandleEftProofMedia(
  e164: string,
  media: InboundMedia,
  caption = '',
  seen?: SeenImage | null,
): Promise<EftMediaResult> {
  const identity = await resolveIdentity(e164)
  if (identity.role !== 'vendor' || !identity.vendor?.id) return { handled: false }

  // Load the full row: lane state, paid_at and phone live on the application record.
  const db = createAdminClient()
  const { data: fullRow } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, paid_at')
    .eq('id', identity.vendor.id)
    .single()
  const vendor = fullRow as {
    id: string
    business_name: string | null
    contact_name: string | null
    email: string | null
    phone: string | null
    admin_notes: string | null
    paid_at: string | null
  } | null
  if (!vendor) return { handled: false }

  const globalOn = await getEftMode()
  const alreadyLane = vendorInEftLane(vendor.admin_notes || '', globalOn, vendor.paid_at, { email: vendor.email, phone: vendor.phone })

  // FULL-EFT: once the cutover is active, every unpaid non-⟦NOEFT⟧ vendor is on the
  // EFT rail, so the bot must be MAXIMALLY eager to capture any proof they send.
  // vendorInEftLane only knows the OLD eft_mode toggle (currently OFF), which would
  // drop a bare screenshot the vision was unsure about with an empty caption. Treat
  // a full-EFT vendor as on the lane for the purpose of NOT dropping their proof.
  // CAPTURE-FIRST. Any UNPAID vendor who sends an image/PDF is treated as sending
  // a probable proof, so we capture it rather than dropping it or (worse) letting
  // it fall to uploadDocument, which files a first image as the vendor's PUBLIC
  // LOGO — a bank screenshot would become their storefront logo. A PAID vendor's
  // image only counts as a proof when vision or the caption says so (isProofMedia
  // below), else it is a logo/cert/doc and the document path is correct.
  // Measured 2026-09-01: five unpaid vendors sent real proofs and got "I could
  // not save it from here". `!vendor.paid_at` already covers every full-EFT case
  // (that mode only matters for unpaid vendors), so no separate fullEft term: an
  // earlier draft's `|| (fullEft && !hasNoEft)` made a PAID vendor eager once the
  // cutover activated, misfiling their logo as a proof (doctrine review, 2026-09-02).
  const eager = alreadyLane || !vendor.paid_at

  const { yes, note } = await isProofMedia(media, caption, seen)
  if (!yes && !eager) return { handled: false }

  const bytes = await fetchMediaBytes(media.id)
  if (!bytes) {
    // Do NOT send them back to a portal they often cannot reach, and do NOT drop
    // it silently: tell the master a proof came in that we could not pull.
    await alertMasterProofIssue(vendor.business_name, `sent a proof of payment on WhatsApp but the file could not be fetched from Meta (may be too large or expired). Ask them to resend, or check the vendor's WhatsApp thread.`, caption)
    const who = identity.firstName || vendor.contact_name || ''
    return { handled: true, laneAdded: false, reply: `Thanks${who ? ' ' + who : ''}, I can see you sent a file but it didn't come through clearly on my side. I've let the team know so they can follow up with you here. If you can, send it again as a photo or PDF.` }
  }

  // WHERE THE PROOF SHOWS depends on the payment rail (Taona 2026-09-02: "it
  // should auto upload for samreen under samreen proof"):
  //  - master rail  -> EFT is covert, Samreen must never see it, so lane the
  //    vendor ⟦EFT⟧ (master lane). This is the original outage seal.
  //  - samreen_eft / yoco rail -> the proof belongs on SAMREEN's fenced EFT
  //    Proofs page. Do NOT lane it ⟦EFT⟧: eftProofVisibleToOwner() hides any
  //    ⟦EFT⟧ vendor from her, so laning would bury the very proof she should see.
  //    Capture still works without laning because recordEftProof runs with
  //    captureRegardless below (it no longer needs the vendor on the lane).
  // The protected pre-cutover cohort (the frozen 66) stays hidden either way:
  // eftProofVisibleToOwner keys on protectedIds + the ⟦EFT⟧ marker they already
  // carry, which this never removes.
  //
  // STALE-READ note: when we DO lane, markVendorToldEft writes ⟦EFT⟧ to the DB but
  // recordEftProof re-checks the admin_notes we PASS it, so we reflect the write
  // locally (withEftMarker) or its own lane gate would 403 the vendor we just laned.
  const rail = await getPaymentRail()
  let laneAdded = false
  let effectiveNotes = vendor.admin_notes || ''
  if (rail === 'master' && !alreadyLane && !vendor.paid_at) {
    const marked = await markVendorToldEft({ email: vendor.email, phone: vendor.phone })
    laneAdded = !!marked
    if (laneAdded) effectiveNotes = withEftMarker(effectiveNotes)
  }

  const ref = extractReference(caption) || extractReference(note) || undefined
  const noteWithRef = ref ? `${note} (ref ${ref})` : note

  const filename = media.filename || `proof-${Date.now()}.${media.kind === 'image' ? 'jpg' : 'pdf'}`
  const result = await recordEftProof({
    applicationId: vendor.id,
    admin_notes: effectiveNotes,
    paid_at: vendor.paid_at || null,
    email: vendor.email,
    phone: vendor.phone,
    business_name: vendor.business_name,
    contact_name: identity.firstName || null,
    file: { bytes: bytes.bytes, name: filename, type: bytes.contentType || media.mimeType },
    note: noteWithRef.slice(0, 240),
    source: 'whatsapp',
    // A proof already in our hands is captured no matter the lane state (paid,
    // card-only ⟦NOEFT⟧, lane-off). recordEftProof stores it and alerts the
    // master; it never adds the ⟦EFT⟧ marker, so the Samreen wall is untouched.
    captureRegardless: true,
  })

  const name = identity.firstName || vendor.contact_name || vendor.business_name || 'there'

  if (!result.ok) {
    // With captureRegardless the lane gate can no longer 403, so a failure here is
    // a real storage problem (too large, unreadable format, upload error). Never
    // dead-end to a portal they cannot reach: acknowledge honestly and put the
    // proof in front of the master so a human takes it from here.
    await alertMasterProofIssue(vendor.business_name, `sent a proof of payment on WhatsApp but it could not be saved (${result.error}). Check the vendor's WhatsApp thread and follow up.`, caption)
    return {
      handled: true,
      laneAdded,
      reply: `Thanks ${name}, I've received your proof but couldn't file it automatically. I've passed it to the team to sort out, they'll be in touch here.`,
    }
  }

  const reply = `Thanks ${name}, I've received your proof of payment and passed it to the finance team. You do not need to email it, sending it here is enough. We'll let you know once it has been checked.`
  return { handled: true, reply, laneAdded }
}

/** Best-effort master-only heads-up for a proof we could NOT store cleanly, so a
 *  captured-but-unfiled proof never vanishes without a human knowing. Master
 *  audience keeps it off Samreen's wall regardless of the vendor's lane. */
async function alertMasterProofIssue(business: string | null, what: string, caption: string): Promise<void> {
  try {
    const { notifyOwners } = await import('@/lib/bot/notify')
    const snippet = caption ? ` Vendor wrote: "${caption.slice(0, 120)}".` : ''
    await notifyOwners({ event: 'system_alert', audience: 'master', body: `${business || 'A vendor'} ${what}${snippet}` })
  } catch (e) {
    console.error('[handle-eft-proof-media] master alert failed:', (e as Error).message)
  }
}
