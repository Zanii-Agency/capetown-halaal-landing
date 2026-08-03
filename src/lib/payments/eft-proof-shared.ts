// Shared EFT proof-of-payment recording used by both the exhibitor portal
// upload route and the WhatsApp bot. Keeping it in one place guarantees the
// same storage path, portal state shape, master alert, vendor ack and WhatsApp
// copy regardless of how the proof arrived.

import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState, parsePortalState } from '@/lib/portal-state'
import { getEftMode, vendorInEftLane, eftReference } from '@/lib/eft'
import { notifyOwners } from '@/lib/bot/notify'
import { sendMedia, toE164 } from '@/lib/whatsapp'
import { BOT_ADMINS } from '@/lib/bot/admins'

const BUCKET = 'vendor-docs'
const ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'webp']
const MAX_BYTES = 10 * 1024 * 1024 // 10MB

export interface EftProofInput {
  applicationId: string
  admin_notes: string | null
  paid_at: string | null
  email: string | null
  phone: string | null
  business_name: string | null
  contact_name: string | null
  file: {
    bytes: Buffer
    name?: string
    type?: string
  }
  note?: string
  source: 'portal' | 'whatsapp' | 'email'
}

export type EftProofResult =
  | { ok: true; path: string; uploaded_at: string; isFirst: boolean }
  | { ok: false; error: string; status: number }

function allowedExtension(filename?: string, mimeType?: string): string | null {
  const ext = (filename?.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (ext && ALLOWED_EXT.includes(ext)) return ext
  const map: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
  }
  const fromMime = map[(mimeType || '').toLowerCase()]
  return fromMime && ALLOWED_EXT.includes(fromMime) ? fromMime : null
}

/** Record an EFT proof in storage and portal state. Sends master alert + vendor
 *  ack + master WhatsApp copy. Returns the storage path on success. */
export async function recordEftProof(input: EftProofInput): Promise<EftProofResult> {
  const {
    applicationId,
    admin_notes,
    paid_at,
    email,
    phone,
    business_name,
    contact_name,
    file,
    note,
    source,
  } = input

  // Same guard the portal route uses: only EFT-lane vendors may submit proof.
  if (!vendorInEftLane(admin_notes || '', await getEftMode(), paid_at, { email, phone })) {
    return { ok: false, error: 'EFT is not enabled for your account', status: 403 }
  }

  if (file.bytes.byteLength > MAX_BYTES) {
    return { ok: false, error: 'File too large (max 10MB)', status: 400 }
  }

  const ext = allowedExtension(file.name, file.type)
  if (!ext) {
    return { ok: false, error: 'Please upload a PDF or image (pdf, png, jpg, webp)', status: 400 }
  }

  const path = `${applicationId}/eft-proof-${Date.now()}.${ext}`
  const admin = createAdminClient()
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, file.bytes, {
    contentType: file.type || (ext === 'pdf' ? 'application/pdf' : `image/${ext}`),
    upsert: true,
  })
  if (upErr) {
    console.error(`[eft-proof-shared:${source}] upload failed:`, upErr.message)
    return { ok: false, error: 'Upload failed', status: 500 }
  }

  const uploaded_at = new Date().toISOString()
  const prior = parsePortalState(admin_notes || '').payment?.eft_submitted_at
  const isFirst = !prior

  await updatePortalState(applicationId, (s) => ({
    ...s,
    payment: {
      ...s.payment,
      eft_submitted_at: s.payment?.eft_submitted_at || uploaded_at,
      proofs: [
        ...(s.payment?.proofs || []),
        { path, kind: 'eft_submission' as const, note: note || undefined, uploaded_at },
      ],
    },
  }))

  const name = String(business_name || 'A vendor')
  const ref = eftReference({ id: applicationId, admin_notes: admin_notes || '' })
  const noteSnippet = note ? `, note: "${note.slice(0, 120)}"` : ''

  // Master-only heads-up.
  try {
    await notifyOwners({
      event: 'system_alert',
      audience: 'master',
      body: `${name} uploaded ${isFirst ? 'their EFT proof of payment' : 'ANOTHER EFT proof'} via ${source}. Ref ${ref}${noteSnippet}. Reconcile it on /admin/eft.`,
    })
  } catch (e) {
    console.error(`[eft-proof-shared:${source}] notifyOwners failed:`, (e as Error).message)
  }

  // Vendor ack (first proof only).
  if (isFirst) {
    try {
      const { sendProofAck } = await import('@/lib/payments/send-proof-ack')
      const r = await sendProofAck({ businessName: name, contactName: contact_name, email, phone })
      if (r.errors.length) console.warn(`[eft-proof-shared:${source}] ack partial:`, JSON.stringify(r))
    } catch (e) {
      console.error(`[eft-proof-shared:${source}] ack failed:`, (e as Error).message)
    }
  }

  // Master WhatsApp copy of the proof.
  try {
    const master = BOT_ADMINS.find((a) => a.role === 'master')
    if (master) {
      const isImage = ext !== 'pdf'
      const r = await sendMedia(toE164(master.phone), {
        bytes: file.bytes,
        mimeType: file.type || (isImage ? `image/${ext}` : 'application/pdf'),
        filename: `eft-proof-${ref}.${ext}`,
        kind: isImage ? 'image' : 'document',
        caption: `EFT proof from ${name} via ${source}. Ref ${ref}${noteSnippet}`,
      })
      if (r.skipped) console.warn(`[eft-proof-shared:${source}] master copy skipped: ${r.skipped}`)
    }
  } catch (e) {
    console.error(`[eft-proof-shared:${source}] master WhatsApp copy failed:`, (e as Error).message)
  }

  return { ok: true, path, uploaded_at, isFirst }
}
