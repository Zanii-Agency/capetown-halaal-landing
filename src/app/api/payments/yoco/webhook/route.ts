// Yoco Online Checkout webhook receiver. Verifies the Standard-Webhooks
// signature, marks the application paid, and triggers the confirmation email
// + invoice. Idempotent — Yoco may retry the same event up to 3 times.

import { NextRequest, NextResponse } from 'next/server'
import { yoco } from '@/lib/payments/yoco'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, updatePortalState } from '@/lib/portal-state'
import { confirmPayment } from '@/lib/payments/confirm'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const raw = await req.text()
  let result
  try {
    if (!yoco.parseWebhook) throw new Error('parseWebhook not implemented')
    result = await yoco.parseWebhook(req, raw)
  } catch (e) {
    console.error('[yoco-webhook] parse error:', (e as Error).message)
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 })
  }

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 401 })
  }
  if (!result.status || (result.status !== 'paid' && result.status !== 'failed')) {
    return NextResponse.json({ ok: true, ignored: true })
  }

  const applicationId = result.applicationId
  if (!applicationId) {
    return NextResponse.json({ ok: false, error: 'missing applicationId in metadata' }, { status: 400 })
  }

  // Failed: bump the failed_attempts counter so the UI can escalate to
  // "WhatsApp support" after repeated failures. Never downgrade a paid status.
  if (result.status === 'failed') {
    const admin = createAdminClient()
    const { data: app } = await admin
      .from('vendor_applications')
      .select('admin_notes')
      .eq('id', applicationId)
      .maybeSingle()
    const alreadyPaid = parsePortalState(app?.admin_notes as string).payment?.status === 'paid'
    await updatePortalState(applicationId, (s) => ({
      ...s,
      payment: {
        ...(s.payment || {}),
        status: alreadyPaid ? 'paid' : 'pending',
        provider_ref: result.providerRef || s.payment?.provider_ref,
        failed_attempts: alreadyPaid
          ? (s.payment?.failed_attempts || 0)
          : ((s.payment?.failed_attempts as number) || 0) + 1,
      },
    }))
    return NextResponse.json({ ok: true })
  }

  // status === 'paid'.
  // EFT→Yoco settlement: if the vendor is currently 'collected' (EFT interim,
  // already acknowledged to them), this Yoco payment SETTLES that same payment.
  // It is the first real paid_at transition (collected never set paid_at, so no
  // double-count), and the OWNER is notified as a normal Yoco payment, but the
  // VENDOR is NOT re-pinged. A fresh (non-collected) Yoco payment notifies both.
  const admin = createAdminClient()
  const { data: cur } = await admin
    .from('vendor_applications')
    .select('admin_notes')
    .eq('id', applicationId)
    .maybeSingle()
  const isEftSettlement = parsePortalState(cur?.admin_notes as string).payment?.status === 'collected'
  const out = await confirmPayment({
    applicationId,
    method: 'yoco',
    amount: result.amount,
    providerRef: result.providerRef,
    notifyVendor: !isEftSettlement,
  })
  if (!out.ok) return NextResponse.json({ ok: false, error: out.error }, { status: 500 })

  return NextResponse.json({ ok: true, alreadyPaid: out.alreadyPaid })
}
