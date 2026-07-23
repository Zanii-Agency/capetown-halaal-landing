import { NextRequest, NextResponse } from 'next/server'
import { requireOperator } from '@/lib/admin-rbac'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEftAdmin, withoutEftMarker } from '@/lib/eft'
import { confirmPayment } from '@/lib/payments/confirm'

export const runtime = 'nodejs'

// TEMPORARY EFT lane: reconcile a vendor once the money has actually landed.
// Flips them to really paid via the SAME silent path as a manual mark-paid
// (silent:true => no vendor/owner email or WhatsApp), then removes the ⟦EFT⟧
// marker so their comms return to the main inbox, the bot resumes normally, and
// their payment view returns to normal. amount omitted => settle the full
// outstanding balance (confirmPayment computes it). Restricted to the EFT admin.
export async function POST(req: NextRequest) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  if (!isEftAdmin(gate.adminUser.email)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { applicationId?: string; amount?: number; reference?: string }
  const id = String(body.applicationId || '')
  if (!id) return NextResponse.json({ error: 'applicationId required' }, { status: 400 })

  const providerRef = body.reference?.trim() || `eft-reconcile-${id}-${Date.now()}`
  const result = await confirmPayment({
    applicationId: id,
    method: 'eft',
    amount: typeof body.amount === 'number' ? body.amount : undefined,
    providerRef,
    silent: true,
  })
  if (!result.ok) return NextResponse.json({ error: result.error || 'reconcile failed' }, { status: 500 })

  const admin = createAdminClient()
  const { data } = await admin.from('vendor_applications').select('admin_notes').eq('id', id).maybeSingle()
  if (data) {
    const { error: rmErr } = await admin
      .from('vendor_applications')
      .update({ admin_notes: withoutEftMarker(data.admin_notes as string) })
      .eq('id', id)
    // Payment already landed (confirmPayment succeeded); a marker-removal failure
    // only leaves them in the lane. Log it so an operator can Remove by hand; it
    // also self-heals on a re-reconcile. Never fail the request for this.
    if (rmErr) console.error('[eft/reconcile] lane-marker removal failed for', id, rmErr.message)
  }

  return NextResponse.json({ ok: true, amount: result.amount })
}
