// Handle a vendor sending an EFT proof of payment over WhatsApp.
//
// The portal is the preferred upload surface, but vendors often just reply with
// a screenshot or PDF on WhatsApp. This helper detects that, moves them onto the
// EFT lane if they were not already, records the proof in the same bucket and
// portal state as a portal upload, alerts the master, and replies to the vendor.
// It is deliberately eager for known vendors: a payment proof is time-sensitive
// and falling back to "thanks for your document" loses money.

import type { InboundMedia } from '@/lib/whatsapp'
import { fetchMediaBytes, sendText, toE164 } from '@/lib/whatsapp'
import { seeImage, type SeenImage } from '@/lib/bot/see-image'
import { markVendorToldEft, vendorInEftLane, getEftMode } from '@/lib/eft'
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

  const { yes, note } = await isProofMedia(media, caption, seen)
  if (!yes && !alreadyLane) return { handled: false }
  // If they are already in the EFT lane, any document/image is treated as a proof
  // unless we have a strong reason to think it is not. This avoids losing a proof
  // because the caption was empty or the PDF had no text layer.

  const bytes = await fetchMediaBytes(media.id)
  if (!bytes) {
    return { handled: true, reply: "I got your file but couldn't open it. Please upload it directly in your portal, or try sending a clearer photo.", laneAdded: false }
  }

  // Make sure they are on the lane BEFORE recording proof, otherwise recordEftProof 403s.
  let laneAdded = false
  if (!alreadyLane && !vendor.paid_at) {
    const marked = await markVendorToldEft({ email: vendor.email, phone: vendor.phone })
    laneAdded = !!marked
  }

  const ref = extractReference(caption) || extractReference(note) || undefined
  const noteWithRef = ref ? `${note} (ref ${ref})` : note

  const filename = media.filename || `proof-${Date.now()}.${media.kind === 'image' ? 'jpg' : 'pdf'}`
  const result = await recordEftProof({
    applicationId: vendor.id,
    admin_notes: vendor.admin_notes || '',
    paid_at: vendor.paid_at || null,
    email: vendor.email,
    phone: vendor.phone,
    business_name: vendor.business_name,
    contact_name: identity.firstName || null,
    file: { bytes: bytes.bytes, name: filename, type: bytes.contentType || media.mimeType },
    note: noteWithRef.slice(0, 240),
    source: 'whatsapp',
  })

  if (!result.ok) {
    // If recording failed because they were not on the lane and marking failed,
    // still tell them to use the portal so the proof does not vanish.
    return {
      handled: true,
      reply: "I can see that looks like a payment proof, but I could not save it from here. Please upload it in your portal under Payments — that is the fastest way for finance to match it.",
      laneAdded,
    }
  }

  const name = identity.firstName || vendor.contact_name || vendor.business_name || 'there'
  const reply = `Thanks ${name}, I've received your proof of payment and passed it to the finance team. You do not need to email it — uploading it here is enough. We'll let you know once it has been checked.`
  return { handled: true, reply, laneAdded }
}
