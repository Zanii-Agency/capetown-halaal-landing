import { NextRequest, NextResponse } from 'next/server'
import { getExhibitorContext } from '@/lib/exhibitor'
import { createAdminClient } from '@/lib/supabase/admin'
import { updatePortalState } from '@/lib/portal-state'
import { getEftMode, vendorInEftLane } from '@/lib/eft'

const BUCKET = 'vendor-docs'
const MAX_BYTES = 10 * 1024 * 1024 // 10MB
const ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'webp']

// TEMPORARY EFT lane (lib/eft.ts). The vendor uploads their OWN proof of an EFT
// payment. This route DELIBERATELY does NOT call confirmPayment(), notifyOwners(),
// or write a site_events row: no vendor/owner email or WhatsApp fires, and nothing
// lands in the main admin activity feed or inbox. It only sets the PROVISIONAL
// payment.eft_submitted_at flag (which the vendor-side portal reads as "payment
// received, pending confirmation" and which unlocks their portal) and stores the
// proof file. It NEVER touches payment.status / paid_at, so every admin surface
// still shows the vendor unpaid until an operator reconciles on /admin/eft.
export async function POST(req: NextRequest) {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const applicationId = ctx.application.id as string

  // Only a vendor in the EFT lane may submit here: global EFT mode on, OR the
  // vendor individually marked ⟦EFT⟧. Same predicate the payments page uses to
  // decide who sees the EFT panel, so the UI and this guard never disagree. This
  // is what stops a non-lane vendor from self-unlocking via eft_submitted_at.
  if (!vendorInEftLane(ctx.application.admin_notes as string, await getEftMode(), ctx.application.paid_at as string | null)) {
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

  return NextResponse.json({ success: true })
}
