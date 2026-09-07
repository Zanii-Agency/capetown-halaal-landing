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
import { nextInstalment, PLAN_LAST_DATE } from '@/lib/payments/payment-plan'
import { isTestVendor } from '@/lib/test-vendors'

export const METHOD_LABEL: Record<string, string> = {
  yoco: 'Yoco (card)', eft: 'EFT', manual_card: 'Card (manual)',
  manual: 'Manual', cash: 'Cash', waived: 'Waived',
}

export type Instalment = { n: number; amount: number; due: string; status: 'paid' | 'proof' | 'due' | 'overdue'; paidOn: string | null }
export type PayState = 'Paid' | 'Partial payment' | 'EFT received' | 'Proof pending'
export type PaidVendorRow = {
  id: string; name: string; contact: string | null; paidOn: string; sortKey: string; method: string; payState: PayState
  /** Partial payments: what is still owed on the stall fee and the next instalment (if on a plan). */
  owing: number; nextAmount: number | null; nextDue: string | null
  /** What the partial payer will have paid when done: the plan total when on a plan (stall + accessories), else the stall fee. */
  due: number
  /** The instalment ledger for the Partial payments tab (click to expand). Empty when not on a plan. */
  instalments: Instalment[]
  /** A proof is in that no confirm has consumed yet (proofs > confirms): the next instalment can be confirmed. */
  proofPending: boolean
  proofUrl: string | null
  /** A committed plan with an instalment dated after the current cap (30 Nov): agreed
   *  under the old rules, for Samreen to renegotiate earlier with the vendor herself. */
  overCap: boolean
  stall: number; accTotal: number; accOwing: number; accState: string; totalPaid: number
}

/** The instalment ledger for a plan: each instalment marked paid (money so far
 *  covers it), proof (the next one, a proof is in awaiting confirm), overdue or
 *  due. Shared by the Partial payments and Active payment plans tabs. */
function buildLedger(
  installments: Array<{ date: string; amount: number }>,
  paidTotal: number,
  proofPending: boolean,
  today: string,
  paidOnRef: string | null,
): Instalment[] {
  let cumulative = 0
  let nextSeen = false
  return [...installments].sort((a, b) => (a.date < b.date ? -1 : 1)).map((p, i) => {
    cumulative += Number(p.amount) || 0
    const covered = cumulative <= paidTotal + 0.005
    let status: Instalment['status']
    if (covered) status = 'paid'
    else if (!nextSeen) { nextSeen = true; status = proofPending ? 'proof' : (p.date < today ? 'overdue' : 'due') }
    else status = p.date < today ? 'overdue' : 'due'
    return { n: i + 1, amount: Number(p.amount) || 0, due: p.date, status, paidOn: covered ? paidOnRef : null }
  })
}

export async function loadPaidVendors(): Promise<{ rows: PaidVendorRow[]; confirmedRows: PaidVendorRow[]; partialRows: PaidVendorRow[]; pendingRows: PaidVendorRow[]; planRows: PaidVendorRow[]; paidTotal: number; accOwingTotal: number }> {
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
    const planApproved = pay?.arrangement?.plan_status === 'approved' && (pay.arrangement.installments?.length ?? 0) > 0
    if (!settled && !collected && !proofOnly) continue
    // Samreen's side: not the covert master lane, OR a deliberate ⟦OWNERVIS⟧
    // hand-back (which overrides the frozen-set membership).
    const onSamreenSide = isOwnerVisible(notes) || !onCovertMasterLane(v.id as string, notes, rail, fullEft)
    if (!onSamreenSide) continue

    let bill: ReturnType<typeof vendorBill>
    try {
      bill = vendorBill({ id: v.id as string, preferred_booth_tier: v.preferred_booth_tier, special_requirements: v.special_requirements, admin_notes: notes, paid_at: paidAt })
    } catch { continue }
    //   Partial payment = settled but the stall fee is not fully covered (instalments)
    //   A plan vendor whose first proof is in (nothing confirmed yet) sits under
    //   Partial too, so instalment 1 is confirmable from that tab.
    const onPartial = (settled && bill.partial) || (!settled && planApproved && proofOnly)
    const payState: PayState = onPartial ? 'Partial payment' : settled ? 'Paid' : collected ? 'EFT received' : 'Proof pending'
    const inst = onPartial ? nextInstalment(pay?.arrangement, bill.paidTotal) : null
    const proofs = (pay?.proofs || []).filter((f) => f.kind === 'eft_submission')
    const confirms = [...(pay?.refs || []), pay?.provider_ref || ''].filter((r) => String(r).startsWith(`eftproof-${v.id}`)).length
    const proofPending = proofs.length > confirms
    const newestProof = [...proofs].sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1))[0]
    let proofUrl: string | null = null
    if (onPartial && newestProof) {
      const { data: signed } = await db.storage.from('vendor-docs').createSignedUrl(newestProof.path, 60 * 60)
      proofUrl = signed?.signedUrl ?? null
    }
    const today = new Date().toISOString().slice(0, 10)
    const instalments: Instalment[] = onPartial && planApproved
      ? buildLedger(pay!.arrangement!.installments as Array<{ date: string; amount: number }>, bill.paidTotal, proofPending, today, (pay?.paid_at as string) || paidAt)
      : []
    const paidOn = (pay?.paid_at as string) || (pay?.eft_collected_at as string) || paidAt || ''
    rows.push({
      id: v.id as string,
      name: (v.business_name as string) || (v.contact_name as string) || 'Unnamed',
      contact: (v.contact_name as string) || null,
      paidOn,
      sortKey: paidOn || (pay?.eft_submitted_at as string) || '',
      method: METHOD_LABEL[String(pay?.method || '')] || (bill.payClass === 'card' ? 'Yoco (card)' : 'EFT'),
      payState,
      due: instalments.length ? instalments.reduce((s, i) => s + i.amount, 0) : bill.stall.price,
      owing: onPartial ? Math.max(0, (instalments.length ? instalments.reduce((s, i) => s + i.amount, 0) : bill.stall.price) - bill.paidTotal) : 0,
      nextAmount: inst ? Math.min(inst.amount, bill.owing) : (onPartial ? bill.owing : null),
      nextDue: inst?.date ?? null,
      instalments,
      proofPending,
      proofUrl,
      overCap: instalments.some((i) => i.due > PLAN_LAST_DATE),
      stall: bill.stall.price,
      accTotal: bill.accessories.total,
      accOwing: bill.accessories.owing,
      accState: bill.accessories.state,
      // Old settled rows carry no amount: assume the stall price. An unsettled
      // partial row (plan vendor, first proof in) has genuinely paid nothing yet.
      totalPaid: settled ? (bill.paidTotal || bill.stall.price) : bill.paidTotal,
    })
  }
  // Confirmed first, then proof-pending; newest within each.
  const stateRank: Record<PayState, number> = { Paid: 0, 'EFT received': 0, 'Partial payment': 1, 'Proof pending': 2 }
  rows.sort((a, b) => stateRank[a.payState] - stateRank[b.payState] || (a.sortKey < b.sortKey ? 1 : -1))

  const confirmedRows = rows.filter((r) => r.payState === 'Paid' || r.payState === 'EFT received')
  const partialRows = rows.filter((r) => r.payState === 'Partial payment')
  const pendingRows = rows.filter((r) => r.payState === 'Proof pending')
  const accOwingTotal = rows.reduce((s, r) => s + r.accOwing, 0)
  // Total collected counts CONFIRMED money only (full and partial), never unconfirmed proofs.
  const paidTotal = [...confirmedRows, ...partialRows].reduce((s, r) => s + r.totalPaid, 0)

  // ACTIVE PAYMENT PLANS (Taona 2026-09-07: "a tab to show who has committed to a
  // plan"). Every vendor with an APPROVED instalment plan that is not yet fully
  // settled, on Samreen's side, whether or not they have paid an instalment yet.
  // Independent of the paid/partial/pending scan above: a vendor who agreed a plan
  // but has paid nothing is not in rows, yet belongs here.
  const today = new Date().toISOString().slice(0, 10)
  const planRows: PaidVendorRow[] = []
  for (const v of vendors ?? []) {
    if ((v as { is_duplicate?: boolean }).is_duplicate) continue
    if (isTestVendor(v as { business_name?: string | null; email?: string | null })) continue
    const notes = (v.admin_notes as string) || null
    const paidAt = (v.paid_at as string) || null
    const pay = parsePortalState(notes || '').payment
    const plan = pay?.arrangement
    if (plan?.plan_status !== 'approved' || !(plan.installments?.length)) continue
    if (!(isOwnerVisible(notes) || !onCovertMasterLane(v.id as string, notes, rail, fullEft))) continue
    let bill: ReturnType<typeof vendorBill>
    try { bill = vendorBill({ id: v.id as string, preferred_booth_tier: v.preferred_booth_tier, special_requirements: v.special_requirements, admin_notes: notes, paid_at: paidAt }) } catch { continue }
    const planTotal = plan.installments.reduce((s2, i) => s2 + (Number(i.amount) || 0), 0)
    if (bill.paidTotal >= planTotal - 0.005) continue // plan completed -> it lives under Paid, not "active"
    const proofs = (pay?.proofs || []).filter((fp) => fp.kind === 'eft_submission')
    const confirms = [...(pay?.refs || []), pay?.provider_ref || ''].filter((r) => String(r).startsWith(`eftproof-${v.id}`)).length
    const proofPending = proofs.length > confirms
    const newestProof = [...proofs].sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1))[0]
    let proofUrl: string | null = null
    if (newestProof) { const { data: signed } = await db.storage.from('vendor-docs').createSignedUrl(newestProof.path, 60 * 60); proofUrl = signed?.signedUrl ?? null }
    const instalments = buildLedger(plan.installments as Array<{ date: string; amount: number }>, bill.paidTotal, proofPending, today, (pay?.paid_at as string) || paidAt)
    const inst = nextInstalment(plan, bill.paidTotal)
    const paidOn = (pay?.paid_at as string) || (pay?.eft_collected_at as string) || paidAt || ''
    planRows.push({
      id: v.id as string,
      name: (v.business_name as string) || (v.contact_name as string) || 'Unnamed',
      contact: (v.contact_name as string) || null,
      paidOn,
      sortKey: inst?.date || plan.installments[0].date || '',
      method: METHOD_LABEL[String(pay?.method || '')] || 'EFT',
      payState: 'Partial payment',
      due: planTotal,
      owing: Math.max(0, planTotal - bill.paidTotal),
      nextAmount: inst ? Math.min(inst.amount, Math.max(0, planTotal - bill.paidTotal)) : null,
      nextDue: inst?.date ?? null,
      instalments,
      proofPending,
      proofUrl,
      overCap: (plan.installments as Array<{ date: string }>).some((i) => i.date > PLAN_LAST_DATE),
      stall: bill.stall.price,
      accTotal: bill.accessories.total,
      accOwing: bill.accessories.owing,
      accState: bill.accessories.state,
      totalPaid: bill.paidTotal,
    })
  }
  // Over-cap plans (old rules, need renegotiating) first, then next instalment soonest.
  planRows.sort((a, b) => (Number(b.overCap) - Number(a.overCap)) || (a.sortKey < b.sortKey ? -1 : 1))

  return { rows, confirmedRows, partialRows, pendingRows, planRows, paidTotal, accOwingTotal }
}
