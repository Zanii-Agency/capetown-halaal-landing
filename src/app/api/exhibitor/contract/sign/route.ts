import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getExhibitorContext } from '@/lib/exhibitor'
import { createAdminClient } from '@/lib/supabase/admin'
import { renderSignedContractPdf } from '@/lib/contract/render-pdf'
import { CONTRACT_VERSION } from '@/lib/contract/copy'

export const runtime = 'nodejs'
export const maxDuration = 60

const VENDOR_DOCS_BUCKET = 'vendor-docs'

const signSchema = z.object({
  signatureDataUrl: z.string().min(20).max(2_500_000), // up to ~2MB encoded
  signatureMode: z.enum(['type', 'draw']),
  printName: z.string().min(2).max(160),
  signedAt: z.string().min(2).max(120),
})

export async function POST(req: NextRequest) {
  let body: z.infer<typeof signSchema>
  try {
    body = signSchema.parse(await req.json())
  } catch {
    return NextResponse.json({ error: 'Bad payload' }, { status: 400 })
  }

  const ctx = await getExhibitorContext()
  if (!ctx || !ctx.application) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const app = ctx.application as any
  if (app.status !== 'approved') {
    return NextResponse.json({ error: 'Application not approved yet' }, { status: 403 })
  }
  if (app.contract_signed_at) {
    return NextResponse.json({ ok: true, alreadySigned: true })
  }

  const admin = createAdminClient()
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null
  const ua = (req.headers.get('user-agent') || '').slice(0, 400)
  const signedAtIso = new Date().toISOString()

  // Render the themed PDF
  const pdf = await renderSignedContractPdf({
    vendorName: String(app.business_name || 'Vendor'),
    contactName: String(app.contact_name || ''),
    printName: body.printName,
    signedAtPlace: body.signedAt,
    signedAtIso,
    signatureDataUrl: body.signatureDataUrl,
    ip,
    applicationId: app.id,
  })
  if (!pdf) {
    return NextResponse.json({ error: 'Could not render contract' }, { status: 500 })
  }

  // Upload to vendor-docs/signed-contracts/<application_id>.pdf
  const path = `signed-contracts/${app.id}.pdf`
  const { error: upErr } = await admin.storage
    .from(VENDOR_DOCS_BUCKET)
    .upload(path, pdf, { contentType: 'application/pdf', upsert: true })
  if (upErr) {
    console.error('[contract-sign] upload failed:', upErr.message)
    return NextResponse.json({ error: 'Could not store contract' }, { status: 500 })
  }

  // Atomic transition authority. This guarded UPDATE is the SINGLE point that
  // decides whether THIS call is the one that moved the row unsigned -> signed.
  // It only touches a row where contract_signed_at IS NULL, and .select()
  // returns the rows it actually wrote. Under a double-submit or concurrent
  // sign, exactly one call matches the unsigned row and gets a returned row
  // back; every other concurrent call matches 0 rows and gets an empty array.
  // We gate the post-sign side-effects (audit event, owner notify) on this
  // result so a duplicate sign can never re-notify. The early contract_signed_at
  // read above is only a fast-path bail, it is not load-bearing for this gate.
  // The PDF render + upload above is idempotent: it upserts to a deterministic
  // path keyed by app.id, so a losing call merely overwrites identical content.
  const { data: transitioned, error: dbErr } = await admin
    .from('vendor_applications')
    .update({
      contract_signed_at: signedAtIso,
      contract_signed_ip: ip,
      contract_signed_ua: ua,
      contract_pdf_path: path,
      contract_version: CONTRACT_VERSION,
    })
    .eq('id', app.id)
    .is('contract_signed_at', null)
    .select('id')
  if (dbErr) {
    console.error('[contract-sign] db update failed:', dbErr.message)
    return NextResponse.json({ error: 'Could not record signature' }, { status: 500 })
  }

  // This call won the unsigned -> signed transition iff the guarded UPDATE
  // affected exactly the unsigned row (returned >= 1 row). A concurrent /
  // double-submitted sign matches 0 rows here, so it skips every side-effect
  // below and returns the already-signed state gracefully. Only the winning
  // call fires the audit event + owner notification.
  const wonTransition = Array.isArray(transitioned) && transitioned.length > 0
  if (!wonTransition) {
    return NextResponse.json({ ok: true, alreadySigned: true, path })
  }

  // Best-effort audit event (winning call only). Canonical site_events shape:
  // { session_id, event_type, path, metadata }. contract_signed is in the
  // activity-feed union, so it surfaces in the admin feed + vendor Activity tab.
  try {
    await admin.from('site_events').insert({
      session_id: `contract-${app.id}`,
      event_type: 'contract_signed',
      path: '/exhibitor/portal/contract',
      metadata: {
        vendor_application_id: app.id,
        business_name: app.business_name,
        mode: body.signatureMode,
        print_name: body.printName,
        ip,
        version: CONTRACT_VERSION,
        signed_at: signedAtIso,
        storage_path: path,
      },
    })
  } catch (e) {
    console.warn('[contract-sign] site_events insert failed:', (e as Error).message)
  }

  // Best-effort owner notification (winning call only). Failure here never
  // blocks the vendor's sign.
  try {
    const { notifyOwners } = await import('@/lib/bot/notify')
    await notifyOwners({
      event: 'system_alert',
      body: `Contract signed: ${String(app.business_name || 'Vendor')}.`,
      audience: 'all',
    })
  } catch (e) {
    console.error('[contract-sign] notifyOwners failed:', (e as Error).message)
  }

  return NextResponse.json({ ok: true, path })
}
