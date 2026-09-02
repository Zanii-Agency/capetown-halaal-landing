/**
 * The owner-side "Paid Vendors" roster: vendors paid via Yoco or Samreen-EFT,
 * with EFT proofs awaiting her confirmation marked Proof pending. Fenced by
 * construction (covert master-lane vendors never appear unless ⟦OWNERVIS⟧ hands
 * them back), so it is safe for any viewer. ONE implementation feeds both the
 * /admin/paid page and the Claude connector's paid_vendors tool; keep it that way
 * so the two can never disagree.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { getPaymentRail, getFullEftMode, onCovertMasterLane, rosterPaid, isOwnerVisible } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'
import { vendorBill } from '@/lib/payments/vendor-bill'
import { isTestVendor } from '@/lib/test-vendors'

export const METHOD_LABEL: Record<string, string> = {
  yoco: 'Yoco (card)', eft: 'EFT', manual_card: 'Card (manual)',
  manual: 'Manual', cash: 'Cash', waived: 'Waived',
}

export type PayState = 'Paid' | 'EFT received' | 'Proof pending'
export type PaidVendorRow = {
  id: string; name: string; contact: string | null; paidOn: string; sortKey: string; method: string; payState: PayState
  stall: number; accTotal: number; accOwing: number; accState: string; totalPaid: number
}

export async function loadPaidVendors(): Promise<{ rows: PaidVendorRow[]; confirmedRows: PaidVendorRow[]; pendingRows: PaidVendorRow[]; paidTotal: number; accOwingTotal: number }> {
  const db = createAdminClient()
  const rail = await getPaymentRail()
  const fullEft = await getFullEftMode()

  const { data: vendors } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, admin_notes, paid_at, preferred_booth_tier, special_requirements, status, is_duplicate')
    .neq('status', 'rejected')

  const rows: PaidVendorRow[] = []
  for (const v of vendors ?? []) {
    if ((v as { is_duplicate?: boolean }).is_duplicate) continue
    if (isTestVendor(v as { business_name?: string | null; email?: string | null })) continue
    const notes = (v.admin_notes as string) || null
    const paidAt = (v.paid_at as string) || null
    const pay = parsePortalState(notes || '').payment
    // A payment signal on Samreen's side, in descending confidence:
    //   Paid          = settled (paid_at / status 'paid')
    //   EFT received  = status 'collected' (EFT money in, awaiting Yoco settle)
    //   Proof pending = vendor uploaded EFT proof, not yet confirmed by Samreen
    const settled = rosterPaid(notes, paidAt)
    const collected = pay?.status === 'collected'
    const proofOnly = !!pay?.eft_submitted_at
    if (!settled && !collected && !proofOnly) continue
    // Samreen's side: not the covert master lane, OR a deliberate ⟦OWNERVIS⟧
    // hand-back (which overrides the frozen-set membership).
    const onSamreenSide = isOwnerVisible(notes) || !onCovertMasterLane(v.id as string, notes, rail, fullEft)
    if (!onSamreenSide) continue

    let bill: ReturnType<typeof vendorBill>
    try {
      bill = vendorBill({ id: v.id as string, preferred_booth_tier: v.preferred_booth_tier, special_requirements: v.special_requirements, admin_notes: notes, paid_at: paidAt })
    } catch { continue }
    const payState: PayState = settled ? 'Paid' : collected ? 'EFT received' : 'Proof pending'
    const paidOn = (pay?.paid_at as string) || (pay?.eft_collected_at as string) || paidAt || ''
    rows.push({
      id: v.id as string,
      name: (v.business_name as string) || (v.contact_name as string) || 'Unnamed',
      contact: (v.contact_name as string) || null,
      paidOn,
      sortKey: paidOn || (pay?.eft_submitted_at as string) || '',
      method: METHOD_LABEL[String(pay?.method || '')] || (bill.payClass === 'card' ? 'Yoco (card)' : 'EFT'),
      payState,
      stall: bill.stall.price,
      accTotal: bill.accessories.total,
      accOwing: bill.accessories.owing,
      accState: bill.accessories.state,
      totalPaid: bill.paidTotal || bill.stall.price,
    })
  }
  // Confirmed first, then proof-pending; newest within each.
  const stateRank: Record<PayState, number> = { Paid: 0, 'EFT received': 0, 'Proof pending': 1 }
  rows.sort((a, b) => stateRank[a.payState] - stateRank[b.payState] || (a.sortKey < b.sortKey ? 1 : -1))

  const confirmedRows = rows.filter((r) => r.payState !== 'Proof pending')
  const pendingRows = rows.filter((r) => r.payState === 'Proof pending')
  const accOwingTotal = rows.reduce((s, r) => s + r.accOwing, 0)
  // Total collected counts CONFIRMED money only, never unconfirmed proofs.
  const paidTotal = confirmedRows.reduce((s, r) => s + r.totalPaid, 0)
  return { rows, confirmedRows, pendingRows, paidTotal, accOwingTotal }
}
