import { NextRequest, NextResponse } from 'next/server'
import { requireOperator } from '@/lib/admin-rbac'
import { isEftAdmin } from '@/lib/eft'
import { presentEftAsPaid, markEftReconciled } from '@/lib/payments/confirm'

export const runtime = 'nodejs'

// TEMPORARY EFT lane: PRESENT a collected EFT payment to the festival owner as a
// clean "paid via Yoco" entry (Samreen's request). Two actions, both EFT-admin only:
//
//   {applicationId}                 -> present: reach the real paid-Yoco state via
//                                      confirmPayment(method:'yoco'). She sees paid +
//                                      Yoco + the YAH- reference; the EFT-era thread is
//                                      auto-hidden (⟦OWNERCUT⟧); money counts exactly
//                                      once. No fabricated Yoco provider_ref.
//   {applicationId, reconcile:true} -> "settle later": stamp reconciled_at (operator-only
//                                      bookkeeping). Does NOTHING to the owner or finance.
//
// notifyOwner:false presents silently (she just sees it in her roster, no ping).
export async function POST(req: NextRequest) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  if (!isEftAdmin(gate.adminUser.email)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { applicationId?: string; reconcile?: boolean; notifyOwner?: boolean }
  const id = String(body.applicationId || '')
  if (!id) return NextResponse.json({ error: 'applicationId required' }, { status: 400 })

  if (body.reconcile) {
    const r = await markEftReconciled(id)
    if (!r.ok) return NextResponse.json({ error: r.error || 'reconcile failed' }, { status: 500 })
    return NextResponse.json({ ok: true, status: 'reconciled' })
  }

  const r = await presentEftAsPaid(id, { notifyOwner: body.notifyOwner !== false })
  if (!r.ok) return NextResponse.json({ error: r.error || 'present failed' }, { status: 500 })
  return NextResponse.json({ ok: true, status: 'presented', amount: r.amount, reference: r.reference })
}
