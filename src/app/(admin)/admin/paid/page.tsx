import { redirect } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle2, ChevronDown } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { formatRand } from '@/lib/payments/pricing'
import { loadPaidVendors, type PaidVendorRow } from '@/lib/payments/paid-vendors'
import { AdminPage } from '@/components/admin/AdminPage'
import { EftProofConfirmButton } from '@/components/admin/EftProofConfirmButton'

export const dynamic = 'force-dynamic'

// PAID vendors, scoped to Samreen's world: Yoco (card/cash/waived) + her EFT
// (...629), INCLUDING vendors deliberately handed to her with ⟦OWNERVIS⟧ even
// though they sit in the frozen cutover set. The covert master lane (...191:
// frozen-66 with NO OWNERVIS, un-OWNERVIS ⟦EFT⟧ markers, master-rail) NEVER
// appears, so the page is safe for the festival owner to open.
//
// Scope = paymentOnOwnerSide && paidish:
//   paymentOnOwnerSide = whose MONEY this is, rail-INDEPENDENT: ⟦OWNERVIS⟧
//     hand-backs are hers; master-only methods, master-stamped proofs and the
//     pinned covert cohort (⟦EFT⟧ / frozen set / ⟦NEWVENDOR⟧) are his; everyone
//     else — Yoco, Samreen-EFT, plan vendors — is hers on EVERY rail. The live
//     onCovertMasterLane was wrong here: under the master rail it sweeps everyone
//     covert (a bank-details decision) and collapsed this page to 7 hand-backs /
//     R52.6k when master went on (2026-09-11). The earlier `!onCovertMasterLane`-only
//     version had the mirror bug on the frozen set, dropping Africa Muslims Agency,
//     Farfashions, Vanilla Cream, Y&K and Stubborn Monkey by ignoring ⟦OWNERVIS⟧.
//   payment signal (descending confidence): Paid (rosterPaid) > EFT received
//     (status 'collected'). Unconfirmed proofs (Proof pending rows) are computed
//     but not SHOWN here since 2026-09-11 — see TABS below; unconfirmed money is
//     never summed into Total collected either way.
// Unpaid/deferred vendors with no EFT proof stay out.
//
// TABS (Taona 2026-09-06: "those who have paid should be under partial payments,
// make a partial payments tab, you should be able to click on instalments"):
//   Paid              settled in full
//   Partial payments  instalment plans mid-way (and a plan vendor whose first proof
//                     is in): each row expands to its instalment ledger, and the
//                     next instalment is confirmable right there once a proof is in
//
// NO "Proof pending" tab (Taona 2026-09-11: "its confusing, just remove that tab,
// dont temper with the data"). Unconfirmed proofs live on /admin/eft-proofs, the
// dedicated proofs inbox where they get confirmed. Page-only removal: pendingRows
// is still computed in loadPaidVendors and still served by the connector's
// paid_vendors tool; no data or classification changes.
//
// Note: the master-lane SETTLEMENT SCHEDULES on the plans tab still key on the
// live onCovertMasterLane (they exist only while a vendor is covert NOW); the
// paid/partial rosters above use the rail-independent paymentOnOwnerSide.

type Tab = 'paid' | 'partial' | 'plans'

export default async function PaidVendorsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')

  const { tab: rawTab } = await searchParams
  const tab: Tab = rawTab === 'partial' || rawTab === 'plans' ? rawTab : 'paid'

  const { rows, confirmedRows, partialRows, planRows, paidTotal, accOwingTotal } = await loadPaidVendors()
  type Row = PaidVendorRow

  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', ...(iso.length === 10 ? { timeZone: 'UTC' } : {}) }) : '-'

  function accCell(r: Row) {
    if (r.accTotal <= 0) return <span className="text-neutral-300">-</span>
    if (r.accState === 'paid') return <span className="inline-flex items-center gap-1 text-emerald-700 font-medium"><CheckCircle2 className="w-3.5 h-3.5" /> Paid</span>
    if (r.accState === 'pending') return <span className="text-amber-600 font-medium">Proof pending</span>
    return <span className="text-[#cd2653] font-semibold">Owing {formatRand(r.accOwing)}</span>
  }

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'paid', label: 'Paid', count: confirmedRows.length },
    { key: 'partial', label: 'Partial payments', count: partialRows.length },
    { key: 'plans', label: 'Active payment plans', count: planRows.length },
  ]
  const shown: Row[] = tab === 'paid' ? confirmedRows : tab === 'partial' ? partialRows : planRows

  const instalmentStatus = (s: Row['instalments'][number]['status']) =>
    s === 'paid' ? <span className="inline-flex items-center gap-1 text-emerald-700 font-medium"><CheckCircle2 className="w-3.5 h-3.5" /> Paid</span>
    : s === 'proof' ? <span className="text-amber-600 font-medium">Proof received</span>
    : s === 'overdue' ? <span className="text-[#cd2653] font-semibold">Overdue</span>
    : <span className="text-neutral-500">Due</span>

  return (
    <AdminPage title="Paid Vendors" subtitle="Vendors paid via Yoco or Samreen EFT, with payment date, method, and accessories status. Instalment plans sit under Partial payments until the stall fee is covered in full.">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
        {[
          { label: 'Paid in full', value: String(confirmedRows.length) },
          { label: 'Partial payments', value: String(partialRows.length) },
          { label: 'Active plans', value: String(planRows.length) },
          { label: 'Accessories owing', value: formatRand(accOwingTotal) },
          { label: 'Total collected', value: formatRand(paidTotal) },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-neutral-200 bg-white p-4">
            <div className="text-[11px] uppercase tracking-wider text-neutral-400">{s.label}</div>
            <div className="text-lg font-semibold text-neutral-900 mt-1">{s.value}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-1 mb-4 border-b border-neutral-200">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.key === 'paid' ? '/admin/paid' : `/admin/paid?tab=${t.key}`}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === t.key ? 'border-[#cd2653] text-[#cd2653]' : 'border-transparent text-neutral-500 hover:text-neutral-800'}`}
          >
            {t.label} <span className="ml-1 text-xs text-neutral-400">{t.count}</span>
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-neutral-500 text-sm">
          No paid vendors to show yet.
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-neutral-500 text-sm">
          {tab === 'partial' ? 'No partial payments. A vendor on an instalment plan appears here once their first proof is in.' : tab === 'plans' ? 'No active payment plans. A plan appears here the moment a vendor commits to one, whether or not they have paid an instalment yet.' : 'No fully paid vendors yet.'}
        </div>
      ) : tab === 'partial' || tab === 'plans' ? (
        <div className="space-y-3">
          {shown.map((r) => (
            <details key={r.id} className="group rounded-xl border border-neutral-200 bg-white overflow-hidden" open={r.proofPending}>
              <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer list-none">
                <div className="min-w-0">
                  <div className="font-medium text-neutral-900 flex items-center gap-2">
                    {r.name}
                    <span className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">Partial payment</span>
                    {r.proofPending && <span className="inline-flex items-center rounded-full bg-neutral-100 border border-neutral-200 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600">Proof received</span>}
                    {r.overCap && <span className="inline-flex items-center rounded-full bg-[#cd2653]/10 border border-[#cd2653]/25 px-1.5 py-0.5 text-[10px] font-semibold text-[#cd2653]">Over the Nov cap</span>}
                  </div>
                  {r.contact && <div className="text-xs text-neutral-400">{r.contact}</div>}
                </div>
                <div className="grid grid-cols-[auto_auto_auto_1rem] items-center gap-x-8 text-sm shrink-0">
                  <div className="text-right">
                    <div className="text-[11px] uppercase tracking-wider text-neutral-400">Paid so far</div>
                    <div className="font-semibold text-neutral-900">{formatRand(r.totalPaid)} <span className="text-neutral-400 font-normal">of {formatRand(r.due)}</span></div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] uppercase tracking-wider text-neutral-400">Still owing</div>
                    <div className="font-semibold text-[#cd2653]">{formatRand(r.owing)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] uppercase tracking-wider text-neutral-400">Next</div>
                    <div className="text-neutral-900">{r.nextAmount !== null ? formatRand(r.nextAmount) : '-'}{r.nextDue ? <span className="text-neutral-400"> by {fmtDate(r.nextDue)}</span> : null}</div>
                  </div>
                  <ChevronDown className="w-4 h-4 text-neutral-400 transition-transform group-open:rotate-180" />
                </div>
              </summary>
              <div className="border-t border-neutral-100 px-5 py-4">
                {r.instalments.length > 0 ? (
                  <ul className="divide-y divide-neutral-100">
                    {r.instalments.map((i) => (
                      <li key={i.n} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 text-sm">
                        <div className="flex items-center gap-4 min-w-0">
                          <span className="w-16 shrink-0 text-neutral-500">{i.n} of {r.instalments.length}</span>
                          <span className="w-20 shrink-0 font-semibold text-neutral-900">{formatRand(i.amount)}</span>
                          <span className="w-36 shrink-0 text-neutral-600">by {fmtDate(i.due)}</span>
                          <span className="shrink-0">{instalmentStatus(i.status)}</span>
                          {i.status === 'paid' && i.paidOn ? <span className="text-neutral-400 text-xs">paid {fmtDate(i.paidOn)}</span> : null}
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          {i.status === 'proof' ? (
                            <>
                              {r.proofUrl && <a href={r.proofUrl} target="_blank" rel="noopener noreferrer" className="text-[#cd2653] hover:underline font-medium">View proof</a>}
                              <EftProofConfirmButton applicationId={r.id} name={r.name} amount={formatRand(r.nextAmount ?? i.amount)} />
                            </>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-4 text-sm py-1">
                    <span className="text-neutral-600">No instalment plan on file: {formatRand(r.owing)} of the stall fee is still outstanding.</span>
                    {r.proofPending && (
                      <span className="inline-flex items-center gap-3">
                        {r.proofUrl && <a href={r.proofUrl} target="_blank" rel="noopener noreferrer" className="text-[#cd2653] hover:underline font-medium">View proof</a>}
                        <EftProofConfirmButton applicationId={r.id} name={r.name} amount={formatRand(r.nextAmount ?? r.owing)} />
                      </span>
                    )}
                  </div>
                )}
                <div className="mt-3 text-xs text-neutral-400">
                  {r.paidOn ? `Last payment ${fmtDate(r.paidOn)} · ` : ''}{r.method}
                  {r.accTotal > 0 ? ` · Stall ${formatRand(r.stall)} + accessories ${formatRand(r.accTotal)}` : ` · Stall ${formatRand(r.stall)}`}
                  {r.instalments.length ? ` · Plan total ${formatRand(r.due)}` : ''}
                </div>
              </div>
            </details>
          ))}
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
                {shown.map((r) => (
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
                    <td className="px-5 py-3 text-neutral-600">{fmtDate(r.paidOn || null)}</td>
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
                  <td className="px-5 py-3" colSpan={4}>Total · {confirmedRows.length} paid in full</td>
                  <td className="px-5 py-3 text-right">{formatRand(shown.reduce((s, r) => s + r.accTotal, 0))}</td>
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
