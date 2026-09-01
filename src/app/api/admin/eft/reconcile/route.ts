import { NextRequest, NextResponse } from 'next/server'
import { requireOperator } from '@/lib/admin-rbac'
import { isEftAdmin } from '@/lib/eft'
import { markEftCollected } from '@/lib/payments/confirm'
import { recordAdminAction } from '@/lib/zanii-ledger'

export const runtime = 'nodejs'

// TEMPORARY EFT lane: mark a vendor's EFT money as COLLECTED (interim). This is
// the master-lane "Mark collected" action. It does NOT make the vendor really
// paid: it sets payment.status='collected' + eft_collected_at (via
// markEftCollected), so the vendor SEES paid + gets a methodless acknowledgment,
// but paid_at stays NULL, it is NOT counted in finance totals, the ⟦EFT⟧ marker
// stays (they remain on the master lane), and the owner is NOT pinged. The payment
// only becomes real `paid` when settled through Yoco (POST /api/admin/eft/settle),
// which is the single paid_at transition (so revenue can never double-count).
// amount omitted => collect the full outstanding balance. Restricted to the EFT admin.
// (Path name is legacy from when this route reconciled directly; it now collects.)
export async function POST(req: NextRequest) {
  const gate = await requireOperator()
  if (!gate.ok) return gate.response
  if (!isEftAdmin(gate.adminUser.email)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { applicationId?: string; amount?: number; accessories?: boolean }
  const id = String(body.applicationId || '')
  if (!id) return NextResponse.json({ error: 'applicationId required' }, { status: 400 })

  // ACCESSORY collect (split-bill, 2026-08-04): the vendor's STALL is already
  // settled; this confirms their accessory-balance EFT landed. Writes the
  // payment.acc sub-ledger (collected_at + amount): the vendor's bill flips to
  // accessories PAID and they get the same methodless acknowledgment as a stall
  // collect, but finance does NOT count it until the accessory Yoco settlement
  // folds it into payment.amount (webhook top-up path). Owner is NOT pinged.
  if (body.accessories) {
    const { markAccessoriesCollected } = await import('@/lib/payments/confirm')
    const result = await markAccessoriesCollected(id, typeof body.amount === 'number' ? body.amount : undefined)
    if (!result.ok) return NextResponse.json({ error: result.error || 'accessory collect failed' }, { status: 500 })
    await recordAdminAction({
      actor: { email: gate.adminUser.email, role: gate.role },
      action: 'eft_accessories_collected',
      vendorId: id,
      payload: { amount: result.amount ?? null },
    })
    return NextResponse.json({ ok: true, status: 'acc_collected', amount: result.amount })
  }

  const result = await markEftCollected(id, typeof body.amount === 'number' ? body.amount : undefined)
  if (!result.ok) return NextResponse.json({ error: result.error || 'collect failed' }, { status: 500 })

  await recordAdminAction({
    actor: { email: gate.adminUser.email, role: gate.role },
    action: 'eft_reconcile',
    vendorId: id,
    payload: { amount: result.amount ?? null },
  })

  return NextResponse.json({ ok: true, status: 'collected', amount: result.amount })
}
