import { NextRequest, NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { recordEftProof } from '@/lib/payments/eft-proof-shared'
import { recordVendorAction } from '@/lib/vendor-action-log'
import { getPaymentRail } from '@/lib/eft'

// TEMPORARY EFT lane (lib/eft.ts). The vendor uploads their OWN proof of an EFT
// payment. This route DELIBERATELY does NOT call confirmPayment() or write a
// site_events row: no vendor-facing email or WhatsApp fires, and nothing lands in
// the main admin activity feed. It only sets the PROVISIONAL
// payment.eft_submitted_at flag (which the vendor-side portal reads as "payment
// received, pending confirmation" and which unlocks their portal) and stores the
// proof file. It NEVER touches payment.status / paid_at, so every admin surface
// still shows the vendor unpaid until an operator reconciles on /admin/eft.
//
// Shared implementation lives in lib/payments/eft-proof-shared.ts so the WhatsApp
// bot records proof identically.
export async function POST(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const applicationId = ctx.application.id as string

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  const note = String(form?.get('note') || '').slice(0, 500)
  // 'accessories' = split-bill accessory balance proof from a settled vendor
  // (payment.acc sub-ledger); anything else is a stall proof as before.
  const purpose = String(form?.get('purpose') || '') === 'accessories' ? 'accessories' as const : 'stall' as const
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

  const buffer = Buffer.from(await file.arrayBuffer())

  const result = await recordEftProof({
    purpose,
    applicationId,
    admin_notes: ctx.application.admin_notes as string | null,
    paid_at: ctx.application.paid_at as string | null,
    email: ctx.application.email as string | null,
    phone: ctx.application.phone as string | null,
    business_name: ctx.application.business_name as string | null,
    contact_name: ctx.application.contact_name as string | null,
    file: { bytes: buffer, name: file.name, type: file.type },
    note,
    source: 'portal',
    // The portal shows this uploader via resolveInEftLane (rail-aware), but
    // recordEftProof's lane gate keys on the MASTER-ONLY getEftMode(), so on the
    // samreen_eft rail an ordinary unpaid vendor the page just told to pay EFT
    // gets 403 and their proof is dropped. Capture the fact whenever EFT is the
    // active rail, exactly as the WhatsApp/email paths do. Storage-only: no
    // ⟦EFT⟧ marker, no lane move, so Samreen's wall is untouched.
    captureRegardless: (await getPaymentRail()) !== 'yoco',
  })

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  await recordVendorAction({
    applicationId,
    eventType: purpose === 'accessories' ? 'eft_acc_proof_uploaded' : 'eft_proof_uploaded',
    actorEmail: ctx.email,
    note: note || file.name,
    afterValue: result.path,
  })

  return NextResponse.json({ success: true })
}
