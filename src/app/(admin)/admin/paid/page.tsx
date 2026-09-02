import { redirect } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { formatRand } from '@/lib/payments/pricing'
import { loadPaidVendors, type PaidVendorRow } from '@/lib/payments/paid-vendors'
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
//   payment signal (descending confidence): Paid (rosterPaid) > EFT received
//     (status 'collected') > Proof pending (eft_submitted_at, not yet confirmed).
//     Proof-pending vendors are shown but chipped, and excluded from Total
//     collected (unconfirmed money is never summed).
// Verified live 2026-09-02: 78 confirmed + 6 proof-pending, 0 covert leak (no
// frozen-non-OWNERVIS surfaced). Unpaid/deferred vendors with no EFT proof stay out.
//
// Note: onCovertMasterLane short-circuits to true for everyone when the global
// rail is 'master'; OWNERVIS still overrides, so her hand-backs stay visible.

export default async function PaidVendorsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')

  const { rows, confirmedRows, pendingRows, paidTotal, accOwingTotal } = await loadPaidVendors()
  type Row = PaidVendorRow

  const fmtDate = (iso: string) =>
    iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'

  function accCell(r: Row) {
    if (r.accTotal <= 0) return <span className="text-neutral-300">-</span>
    if (r.accState === 'paid') return <span className="inline-flex items-center gap-1 text-emerald-700 font-medium"><CheckCircle2 className="w-3.5 h-3.5" /> Paid</span>
    if (r.accState === 'pending') return <span className="text-amber-600 font-medium">Proof pending</span>
    return <span className="text-[#cd2653] font-semibold">Owing {formatRand(r.accOwing)}</span>
  }

  return (
    <AdminPage title="Paid Vendors" subtitle="Vendors paid via Yoco or Samreen EFT, with payment date, method, and accessories status. EFT proofs awaiting confirmation are marked Proof pending.">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {[
          { label: 'Confirmed paid', value: String(confirmedRows.length) },
          { label: 'Proof pending', value: String(pendingRows.length) },
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
                        {r.payState === 'Proof pending' && (
                          <span className="inline-flex items-center rounded-full bg-neutral-100 border border-neutral-200 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-500">Proof pending</span>
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
                  <td className="px-5 py-3" colSpan={4}>Total · {confirmedRows.length} paid{pendingRows.length > 0 ? ` · ${pendingRows.length} proof pending` : ''}</td>
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
