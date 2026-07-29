import { NextRequest, NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState, parsePortalState } from '@/lib/portal-state'
import { getEftMode, vendorInEftLane } from '@/lib/eft'
import { sendMedia, toE164 } from '@/lib/whatsapp'
import { BOT_ADMINS } from '@/lib/bot/admins'

const BUCKET = 'vendor-docs'
const MAX_BYTES = 10 * 1024 * 1024 // 10MB
const ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'webp']

// TEMPORARY EFT lane (lib/eft.ts). The vendor uploads their OWN proof of an EFT
// payment. This route DELIBERATELY does NOT call confirmPayment() or write a
// site_events row: no vendor-facing email or WhatsApp fires, and nothing lands in
// the main admin activity feed. It only sets the PROVISIONAL
// payment.eft_submitted_at flag (which the vendor-side portal reads as "payment
// received, pending confirmation" and which unlocks their portal) and stores the
// proof file. It NEVER touches payment.status / paid_at, so every admin surface
// still shows the vendor unpaid until an operator reconciles on /admin/eft.
//
// It DOES fire a MASTER-ONLY heads-up (Taona 2026-07-25: "not only notify when a
// vendor opens eft details but also when they upload proof"). The reveal alert in
// ../eft-intent tells him a vendor is ABOUT to pay; this one closes that loop by
// telling him the proof has landed and is waiting to be reconciled. Otherwise a
// proof could sit unseen indefinitely, since this route touches no admin feed.
// audience:'master' keeps it off the festival owner even if global mode is
// toggled off, matching the reveal alert.
export async function POST(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const applicationId = ctx.application.id as string

  // Only a vendor in the EFT lane may submit here: global EFT mode on, OR the
  // vendor individually marked ⟦EFT⟧. Same predicate the payments page uses to
  // decide who sees the EFT panel, so the UI and this guard never disagree. This
  // is what stops a non-lane vendor from self-unlocking via eft_submitted_at.
  if (!vendorInEftLane(ctx.application.admin_notes as string, await getEftMode(), ctx.application.paid_at as string | null, { email: ctx.application.email as string | null, phone: ctx.application.phone as string | null })) {
    return NextResponse.json({ error: 'EFT is not enabled for your account' }, { status: 403 })
  }

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  const note = String(form?.get('note') || '').slice(0, 500)
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 400 })

  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!ALLOWED_EXT.includes(ext)) {
    return NextResponse.json({ error: 'Please upload a PDF or image (pdf, png, jpg, webp)' }, { status: 400 })
  }
  const path = `${applicationId}/eft-proof-${Date.now()}.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())

  const admin = createAdminClient()
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, buffer, {
    contentType: file.type || 'application/octet-stream',
    upsert: true,
  })
  if (upErr) {
    console.error('[eft-proof] upload failed:', upErr.message)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }

  const uploaded_at = new Date().toISOString()
  await updatePortalState(applicationId, (s) => ({
    ...s,
    payment: {
      ...s.payment,
      // Keep the FIRST submission time as the provisional marker; append every
      // proof so a vendor can add a clearer copy. Status/paid_at untouched.
      eft_submitted_at: s.payment?.eft_submitted_at || uploaded_at,
      proofs: [
        ...(s.payment?.proofs || []),
        { path, kind: 'eft_submission' as const, note: note || undefined, uploaded_at },
      ],
    },
  }))

  // Best-effort: a notify failure must never cost the vendor their upload, which
  // is already stored and stamped above.
  const { notifyOwners } = await import('@/lib/bot/notify')
  const { eftReference } = await import('@/lib/eft')
  const name = String(ctx.application.business_name || 'A vendor')
  const ref = eftReference({ id: applicationId, admin_notes: ctx.application.admin_notes as string })
  const isFirst = !parsePortalState(ctx.application.admin_notes as string).payment?.eft_submitted_at
  await notifyOwners({
    event: 'system_alert',
    audience: 'master',
    body: `${name} uploaded ${isFirst ? 'their EFT proof of payment' : 'ANOTHER EFT proof'}. Ref ${ref}${note ? `, note: "${note.slice(0, 120)}"` : ''}. Reconcile it on /admin/eft.`,
  }).catch(() => {})

  // ACKNOWLEDGE THE VENDOR. Until 2026-07-29 this route told the operator and
  // told the vendor NOTHING, so someone who had just handed over money watched
  // the screen go quiet. Aurelia sat that way from 29 July. Silence right after
  // a payment is the worst possible moment for it.
  //
  // Only on the FIRST proof: a vendor re-uploading a clearer photo of the same
  // slip does not need to be thanked twice, and the operator alert above
  // already distinguishes the repeat.
  //
  // Best-effort, like everything else here. The proof is stored and stamped
  // above, so a mail or WhatsApp failure must not cost them the upload.
  if (isFirst) {
    try {
      const { sendProofAck } = await import('@/lib/payments/send-proof-ack')
      const r = await sendProofAck({
        businessName: name,
        contactName: ctx.application.contact_name as string | null,
        email: ctx.application.email as string | null,
        phone: ctx.application.phone as string | null,
      })
      if (r.errors.length) console.warn('[eft-proof] ack partial:', JSON.stringify(r))
    } catch (e) {
      console.error('[eft-proof] ack failed:', (e as Error).message)
    }
  }

  // Send the PROOF ITSELF to the master's WhatsApp, not just an alert about it
  // (Taona 2026-07-26: "I should receive the copy via WhatsApp as well"). The
  // point of this lane is reconciling payments from a phone, so making him open
  // an admin page to look at the slip defeats it. MASTER ONLY — a proof of
  // payment is EFT content and never goes to the festival owner.
  //
  // Best-effort and non-blocking: sendMedia is gated by Meta's 24h window, so
  // outside it this returns `skipped` and he still has the text alert above.
  try {
    const master = BOT_ADMINS.find((a) => a.role === 'master')
    if (master) {
      const isImage = ['png', 'jpg', 'jpeg', 'webp'].includes(ext)
      const r = await sendMedia(toE164(master.phone), {
        bytes: buffer,
        mimeType: file.type || (isImage ? `image/${ext}` : 'application/pdf'),
        filename: `eft-proof-${ref}.${ext}`,
        kind: isImage ? 'image' : 'document',
        caption: `EFT proof from ${name}. Ref ${ref}${note ? ` — "${note.slice(0, 120)}"` : ''}`,
      })
      if (r.skipped) console.warn(`[eft-proof] master copy skipped: ${r.skipped}`)
    }
  } catch (e) {
    console.error('[eft-proof] master WhatsApp copy failed:', (e as Error).message)
  }

  return NextResponse.json({ success: true })
}
