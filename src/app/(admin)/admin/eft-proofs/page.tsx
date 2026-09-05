import { redirect } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getEftBankDetails } from '@/lib/eft'
import { formatRand } from '@/lib/payments/pricing'
import { loadEftProofs } from '@/lib/payments/eft-proofs-list'
import { AdminPage } from '@/components/admin/AdminPage'
import { EftProofConfirmButton } from '@/components/admin/EftProofConfirmButton'

export const dynamic = 'force-dynamic'

// FENCED owner-facing EFT-proof list. Shows ONLY vendors who uploaded an EFT proof
// AFTER the full-EFT cutover AND are not in the frozen protected set (the previous
// covert cohort). Enforced entirely by eftProofVisibleToOwner — the wall
// (vendorInOwnerScope) is untouched, so nothing about the old cohort can surface
// here. Safe for any operator (incl. the festival owner) to open.
export default async function EftProofsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')

  const bank = getEftBankDetails()
  const { ownerEftActive, fullEft, rows, totalAmount, paidAmount } = await loadEftProofs()

  const fmtDate = (iso: string) =>
    iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''


  return (
    <AdminPage title="EFT Proofs" subtitle="Vendors who paid by EFT and uploaded their proof of payment">
      {ownerEftActive && (
        <div className="rounded-xl border border-neutral-200 bg-white p-5 mb-5">
          <p className="text-[11px] uppercase tracking-wider text-neutral-500 font-medium mb-3">EFT account vendors pay into</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
            <div><div className="text-neutral-400 text-xs">Account name</div><div className="font-medium text-neutral-900">{bank.accountName}</div></div>
            <div><div className="text-neutral-400 text-xs">Bank</div><div className="font-medium text-neutral-900">{bank.bank}</div></div>
            <div><div className="text-neutral-400 text-xs">Account number</div><div className="font-medium text-neutral-900">{bank.accountNumber}</div></div>
            <div><div className="text-neutral-400 text-xs">Branch code</div><div className="font-medium text-neutral-900">{bank.branchCode}</div></div>
            {bank.accountType && <div><div className="text-neutral-400 text-xs">Account type</div><div className="font-medium text-neutral-900">{bank.accountType}</div></div>}
          </div>
          <p className="text-xs text-neutral-400 mt-3">These are the exact details shown to vendors on their payment page.</p>
        </div>
      )}
      {!ownerEftActive || !fullEft ? (
        <div className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-neutral-500 text-sm">
          EFT mode is not active yet. Once it is, vendors who upload EFT proof will appear here.
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-neutral-500 text-sm">
          No EFT proofs uploaded yet.
        </div>
      ) : (
        <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-100 text-left text-[11px] uppercase tracking-wider text-neutral-500">
                  <th className="px-5 py-3 font-medium">Vendor</th>
                  <th className="px-5 py-3 font-medium">Reference</th>
                  <th className="px-5 py-3 font-medium text-right">Amount</th>
                  <th className="px-5 py-3 font-medium">Uploaded</th>
                  <th className="px-5 py-3 font-medium">Proof</th>
                  <th className="px-5 py-3 font-medium text-right">Payment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-50">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-neutral-50">
                    <td className="px-5 py-3">
                      <div className="font-medium text-neutral-900">{r.name}</div>
                      {r.contact && <div className="text-xs text-neutral-400">{r.contact}</div>}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-neutral-600">
                      {r.reference
                        ? r.reference
                        : <span className="text-neutral-400" title="The proof shows no reference. This is the one the vendor was asked to use.">{r.expectedReference} <span className="font-sans">(not on proof)</span></span>}
                    </td>
                    <td className="px-5 py-3 text-right font-semibold text-neutral-900">{formatRand(r.amount)}</td>
                    <td className="px-5 py-3 text-neutral-600">{fmtDate(r.uploadedAt)}</td>
                    <td className="px-5 py-3">
                      {r.proofUrl ? (
                        <a href={r.proofUrl} target="_blank" rel="noopener noreferrer" className="text-[#cd2653] hover:underline font-medium">
                          View
                        </a>
                      ) : (
                        <span className="text-neutral-300">-</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {r.paid ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                          <CheckCircle2 className="w-4 h-4" /> Paid
                        </span>
                      ) : (
                        <EftProofConfirmButton applicationId={r.id} name={r.name} amount={formatRand(r.amount)} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-neutral-200 bg-neutral-50 font-semibold text-neutral-900">
                  <td className="px-5 py-3" colSpan={2}>Total · {rows.length} proof{rows.length === 1 ? '' : 's'}</td>
                  <td className="px-5 py-3 text-right">{formatRand(totalAmount)}</td>
                  <td className="px-5 py-3" colSpan={2} />
                  <td className="px-5 py-3 text-right text-emerald-700">{formatRand(paidAmount)} paid</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </AdminPage>
  )
}
