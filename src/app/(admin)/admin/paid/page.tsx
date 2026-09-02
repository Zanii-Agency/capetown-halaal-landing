import { redirect } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getPaymentRail, getFullEftMode, onCovertMasterLane, rosterPaid, isOwnerVisible } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'
import { formatRand } from '@/lib/payments/pricing'
import { vendorBill } from '@/lib/payments/vendor-bill'
import { isTestVendor } from '@/lib/test-vendors'
import { AdminPage } from '@/components/admin/AdminPage'

export const dynamic = 'force-dynamic'

// PAID vendors, scoped to Samreen's world: Yoco (card/cash/waived) + her EFT
// (...629), INCLUDING vendors deliberately handed to her with ⟦OWNERVIS⟧ even
// though they sit in the frozen cutover set. The covert master lane (...191:
// frozen-66 with NO OWNERVIS, un-OWNERVIS ⟦EFT⟧ markers, master-rail) NEVER
// appears, so the page is safe for the festival owner to open.
//
// Scope = onSamreenSide && paidish:
//   onSamreenSide = isOwnerVisible(⟦OWNERVIS⟧) OR NOT onCovertMasterLane. The
//     OWNERVIS override is why the earlier `!onCovertMasterLane`-only version
//     wrongly dropped Africa Muslims Agency, Farfashions, Vanilla Cream, Y&K and
//     Stubborn Monkey: onCovertMasterLane returns true for ANY frozen member,
//     ignoring the deliberate per-vendor hand-back marker. OWNERVIS is hand-set
//     (never blanket), so honouring it cannot leak the covert cohort.
//   paidish = rosterPaid (paid_at/status 'paid') OR status 'collected' (EFT money
//     received, awaiting Yoco settle; the vendor already sees paid).
// Verified live 2026-09-02: 78 vendors, 0 covert leak (no frozen-non-OWNERVIS
// surfaced). Unpaid/deferred/proof-only hand-over vendors stay out (not paidish).
//
// Note: onCovertMasterLane short-circuits to true for everyone when the global
// rail is 'master'; OWNERVIS still overrides, so her hand-backs stay visible.
const METHOD_LABEL: Record<string, string> = {
  yoco: 'Yoco (card)', eft: 'EFT', manual_card: 'Card (manual)',
  manual: 'Manual', cash: 'Cash', waived: 'Waived',
}

export default async function PaidVendorsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')

  const db = createAdminClient()
  const rail = await getPaymentRail()
  const fullEft = await getFullEftMode()

  const { data: vendors } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, admin_notes, paid_at, preferred_booth_tier, special_requirements, status, is_duplicate')
    .neq('status', 'rejected')

  type Row = {
    id: string; name: string; contact: string | null; paidOn: string; method: string; payState: 'Paid' | 'EFT received'
    stall: number; accTotal: number; accOwing: number; accState: string; totalPaid: number
  }
  const rows: Row[] = []
  for (const v of vendors ?? []) {
    if ((v as { is_duplicate?: boolean }).is_duplicate) continue
    if (isTestVendor(v as { business_name?: string | null; email?: string | null })) continue
    const notes = (v.admin_notes as string) || null
    const paidAt = (v.paid_at as string) || null
    const pay = parsePortalState(notes || '').payment
    // Money is IN on Samreen's side: settled (Yoco/paid) or EFT collected.
    const paidish = rosterPaid(notes, paidAt) || pay?.status === 'collected'
    if (!paidish) continue
    // Samreen's side: not the covert master lane, OR a deliberate ⟦OWNERVIS⟧
    // hand-back (which overrides the frozen-set membership).
    const onSamreenSide = isOwnerVisible(notes) || !onCovertMasterLane(v.id as string, notes, rail, fullEft)
    if (!onSamreenSide) continue

    let bill: ReturnType<typeof vendorBill>
    try {
      bill = vendorBill({ id: v.id as string, preferred_booth_tier: v.preferred_booth_tier, special_requirements: v.special_requirements, admin_notes: notes, paid_at: paidAt })
    } catch { continue }
    rows.push({
      id: v.id as string,
      name: (v.business_name as string) || (v.contact_name as string) || 'Unnamed',
      contact: (v.contact_name as string) || null,
      paidOn: (pay?.paid_at as string) || (pay?.eft_collected_at as string) || paidAt || '',
      method: METHOD_LABEL[String(pay?.method || '')] || (bill.payClass === 'card' ? 'Yoco (card)' : 'EFT'),
      payState: rosterPaid(notes, paidAt) ? 'Paid' : 'EFT received',
      stall: bill.stall.price,
      accTotal: bill.accessories.total,
      accOwing: bill.accessories.owing,
      accState: bill.accessories.state,
      totalPaid: bill.paidTotal || bill.stall.price,
    })
  }
  rows.sort((a, b) => (a.paidOn < b.paidOn ? 1 : -1))

  const fmtDate = (iso: string) =>
    iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'

  const withAcc = rows.filter((r) => r.accTotal > 0)
  const accOwingTotal = rows.reduce((s, r) => s + r.accOwing, 0)
  const paidTotal = rows.reduce((s, r) => s + r.totalPaid, 0)

  function accCell(r: Row) {
    if (r.accTotal <= 0) return <span className="text-neutral-300">-</span>
    if (r.accState === 'paid') return <span className="inline-flex items-center gap-1 text-emerald-700 font-medium"><CheckCircle2 className="w-3.5 h-3.5" /> Paid</span>
    if (r.accState === 'pending') return <span className="text-amber-600 font-medium">Proof pending</span>
    return <span className="text-[#cd2653] font-semibold">Owing {formatRand(r.accOwing)}</span>
  }

  return (
    <AdminPage title="Paid Vendors" subtitle="Vendors settled via Yoco or Samreen EFT, with payment date, method, and accessories status">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {[
          { label: 'Paid vendors', value: String(rows.length) },
          { label: 'Have accessories', value: String(withAcc.length) },
          { label: 'Accessories owing', value: formatRand(accOwingTotal) },
          { label: 'Total collected', value: formatRand(paidTotal) },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-neutral-200 bg-white p-4">
            <div className="text-[11px] uppercase tracking-wider text-neutral-400">{s.label}</div>
            <div className="text-lg font-semibold text-neutral-900 mt-1">{s.value}</div>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-neutral-500 text-sm">
          No paid vendors to show yet.
        </div>
      ) : (
        <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-100 text-left text-[11px] uppercase tracking-wider text-neutral-500">
                  <th className="px-5 py-3 font-medium">Vendor</th>
                  <th className="px-5 py-3 font-medium">Paid on</th>
                  <th className="px-5 py-3 font-medium">Method</th>
                  <th className="px-5 py-3 font-medium text-right">Stall fee</th>
                  <th className="px-5 py-3 font-medium text-right">Accessories</th>
                  <th className="px-5 py-3 font-medium">Accessories paid?</th>
                  <th className="px-5 py-3 font-medium text-right">Total paid</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-50">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-neutral-50">
                    <td className="px-5 py-3">
                      <div className="font-medium text-neutral-900 flex items-center gap-2">
                        {r.name}
                        {r.payState === 'EFT received' && (
                          <span className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">EFT received</span>
                        )}
                      </div>
                      {r.contact && <div className="text-xs text-neutral-400">{r.contact}</div>}
                    </td>
                    <td className="px-5 py-3 text-neutral-600">{fmtDate(r.paidOn)}</td>
                    <td className="px-5 py-3 text-neutral-600">{r.method}</td>
                    <td className="px-5 py-3 text-right text-neutral-900">{formatRand(r.stall)}</td>
                    <td className="px-5 py-3 text-right text-neutral-900">{r.accTotal > 0 ? formatRand(r.accTotal) : <span className="text-neutral-300">-</span>}</td>
                    <td className="px-5 py-3">{accCell(r)}</td>
                    <td className="px-5 py-3 text-right font-semibold text-neutral-900">{formatRand(r.totalPaid)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-neutral-200 bg-neutral-50 font-semibold text-neutral-900">
                  <td className="px-5 py-3" colSpan={4}>Total · {rows.length} paid vendor{rows.length === 1 ? '' : 's'}</td>
                  <td className="px-5 py-3 text-right">{formatRand(rows.reduce((s, r) => s + r.accTotal, 0))}</td>
                  <td className="px-5 py-3 text-[#cd2653]">{accOwingTotal > 0 ? `${formatRand(accOwingTotal)} owing` : 'all settled'}</td>
                  <td className="px-5 py-3 text-right">{formatRand(paidTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </AdminPage>
  )
}
