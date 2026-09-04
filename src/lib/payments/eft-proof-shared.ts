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
import { recordLedger } from '@/lib/zanii-ledger'

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
  /** Capture the proof even when the vendor is NOT on the EFT lane (paid, card-
   *  only ⟦NOEFT⟧, or lane-off). A proof a vendor actually sent us is a fait
   *  accompli: dropping it loses money and trust (Sumeez/Sataari, Two Scoops,
   *  2026-09-01, five vendors got "I could not save it from here"). The lane gate
   *  is the right guard for the PORTAL upload button (don't invite an EFT payment
   *  from a card-only vendor), but a proof already in our hands must be stored and
   *  the master alerted so a human can reconcile it. Set by the WhatsApp/email bot
   *  paths, never by the portal.
   *
   *  SEAL NOTE: this flag does not itself add the ⟦EFT⟧ marker, but recordEftProof
   *  ALWAYS stamps eft_submitted_at (below), and eftProofVisibleToOwner treats a
   *  post-cutover eft_submitted_at on a non-⟦EFT⟧, non-protected vendor as "hers".
   *  So capture is NOT seal-neutral on its own: the CALLER decides covert-vs-owner
   *  by laning ⟦EFT⟧ on the master rail only (handle-eft-proof-media +
   *  support-mail-fetcher are rail-aware). On the master rail the vendor is laned
   *  and stays hidden; on samreen_eft the proof is meant to reach her page. */
  captureRegardless?: boolean
  /** Skip the built-in vendor acknowledgement. The email intake sends the ack on
   *  RECEIPT (before/independent of this filing) so a filing hiccup can never deny
   *  the vendor their reply; it passes skipAck so we never double-send. Portal and
   *  bot callers omit it and keep the automatic ack. */
  skipAck?: boolean
  /** 'accessories' = an ACCESSORY-balance EFT from a vendor whose stall fee is
   *  already settled (split-bill, 2026-08-04). Uses the `payment.acc` sub-ledger
   *  and the `<ref>-ACC` reference; gated on an actual accessory balance owing,
   *  not on the (paid-excluding) stall EFT lane. Default: stall proof. */
  purpose?: 'stall' | 'accessories'
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
  const forAccessories = input.purpose === 'accessories'

  if (forAccessories) {
    // Accessory proof: the vendor's STALL is settled, so the stall lane gate
    // (which excludes paid vendors) is the wrong test. The gate is: an accessory
    // balance is actually owing on the split bill, AND the EFT lane switch is
    // still on (global mode or individual marker) so one switch closes the
    // whole rail (doctrine review 2026-08-04).
    const { hasEftMarker } = await import('@/lib/eft')
    if (!(await getEftMode()) && !hasEftMarker(admin_notes || '')) {
      return { ok: false, error: 'EFT is not enabled for your account', status: 403 }
    }
    const db = createAdminClient()
    const { data: row } = await db
      .from('vendor_applications')
      .select('preferred_booth_tier, special_requirements')
      .eq('id', applicationId)
      .maybeSingle()
    const { vendorBill } = await import('@/lib/payments/vendor-bill')
    const bill = vendorBill({
      id: applicationId,
      preferred_booth_tier: (row?.preferred_booth_tier as string) || null,
      special_requirements: row?.special_requirements,
      admin_notes,
      paid_at,
    })
    if (!bill.settled || bill.accessories.owing <= 0) {
      return { ok: false, error: 'No accessory balance is owing on your account', status: 403 }
    }
  } else if (!input.captureRegardless && !vendorInEftLane(admin_notes || '', await getEftMode(), paid_at, { email, phone })) {
    // Same guard the portal route uses: only EFT-lane vendors may submit proof.
    // captureRegardless (WhatsApp/email bot) bypasses it: a proof already sent to
    // us is stored and the master alerted rather than dropped. Capture only; the
    // lane marker is never added here, so Samreen's wall is unaffected.
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
  const priorState = parsePortalState(admin_notes || '').payment
  const isFirst = forAccessories ? !priorState?.acc?.submitted_at : !priorState?.eft_submitted_at

  await updatePortalState(applicationId, (s) => ({
    ...s,
    payment: {
      ...s.payment,
      ...(forAccessories
        ? { acc: { ...(s.payment?.acc || {}), submitted_at: s.payment?.acc?.submitted_at || uploaded_at } }
        : { eft_submitted_at: s.payment?.eft_submitted_at || uploaded_at }),
      proofs: [
        ...(s.payment?.proofs || []),
        { path, kind: (forAccessories ? 'eft_accessories' : 'eft_submission') as 'eft_accessories' | 'eft_submission', note: note || undefined, uploaded_at },
      ],
    },
  }))

  const name = String(business_name || 'A vendor')
  const baseRef = eftReference({ id: applicationId, admin_notes: admin_notes || '', business_name })
  const ref = forAccessories ? `${baseRef}-ACC` : baseRef
  const noteSnippet = note ? `, note: "${note.slice(0, 120)}"` : ''

  // Master-only heads-up. An off-lane capture (paid vendor sending a proof, or a
  // card-only ⟦NOEFT⟧ vendor who paid by EFT anyway) will NOT show on /admin/eft,
  // so point the master at the vendor's profile to check and mark paid by hand
  // rather than at a console that won't list them.
  const offLane = !!input.captureRegardless
    && !vendorInEftLane(admin_notes || '', await getEftMode(), paid_at, { email, phone })
  try {
    await notifyOwners({
      event: 'system_alert',
      audience: 'master',
      body: forAccessories
        ? `${name} uploaded ${isFirst ? 'their ACCESSORY EFT proof' : 'ANOTHER accessory EFT proof'} via ${source} (accessory electricity balance). Ref ${ref}${noteSnippet}. Collect it on /admin/eft.`
        : offLane
          ? `${name} sent a proof of payment via ${source}${paid_at ? ' (already marked paid, may be a duplicate or accessories)' : ' but is card-only, not on the EFT lane'}. Ref ${ref}${noteSnippet}. Check it against the account and mark them paid on their profile if it clears.`
          : `${name} uploaded ${isFirst ? 'their EFT proof of payment' : 'ANOTHER EFT proof'} via ${source}. Ref ${ref}${noteSnippet}. Reconcile it on /admin/eft.`,
    })
  } catch (e) {
    console.error(`[eft-proof-shared:${source}] notifyOwners failed:`, (e as Error).message)
  }

  // Vendor ack (first proof only). skipAck lets a caller that already acked on
  // receipt (the email intake) suppress this so the vendor is not double-messaged.
  if (isFirst && !input.skipAck) {
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

  // Signed proof-of-action: an EFT payment proof was uploaded (portal or bot,
  // this is the shared path). The media type (pdf vs image) rides on the target
  // so the proof layer shows WHAT kind of proof was submitted, not just that one
  // was. Best-effort: recordLedger never throws.
  const proofKind = ext === 'pdf' ? 'pdf' : 'image'
  await recordLedger('uploads', `cth.upload.payment_proof_submitted.${proofKind}`, {
    application_id: applicationId,
    path,
    uploaded_at,
    first: isFirst,
    purpose: forAccessories ? 'accessories' : 'stall',
    source,
  })
  return { ok: true, path, uploaded_at, isFirst }
}
