import { redirect } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getFullEftMode, getPaymentRail, eftProofVisibleToOwner, eftReference, getEftBankDetails, rosterPaid } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'
import { computeVendorPricing, formatRand } from '@/lib/payments/pricing'
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

  const db = createAdminClient()
  const fullEft = await getFullEftMode()
  const bank = getEftBankDetails()
  // This surface is Samreen's, so it ONLY has anything to show on the Samreen-EFT
  // rail. On the covert master lane the whole population pays into the ...191
  // account, and NONE of it may surface to her: gate the list (and the account
  // card) so master mode shows her an empty page, never the covert account or a
  // covert vendor. On Yoco there is no EFT to reconcile either.
  const ownerEftActive = (await getPaymentRail()) === 'samreen_eft'

  const { data: vendors } = ownerEftActive ? await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, paid_at, preferred_booth_tier, special_requirements, status, is_duplicate')
    .neq('status', 'rejected') : { data: [] as Array<Record<string, unknown>> }

  type Row = { id: string; name: string; contact: string | null; reference: string; amount: number; proofUrl: string | null; note: string | null; uploadedAt: string; paid: boolean }
  const rows: Row[] = []
  for (const v of (vendors ?? [])) {
    if ((v as { is_duplicate?: boolean }).is_duplicate) continue
    if (!eftProofVisibleToOwner(v.id as string, v.admin_notes as string | null, fullEft)) continue
    const p = parsePortalState((v.admin_notes as string) || '').payment ?? {}
    const bill = computeVendorPricing({ preferred_booth_tier: v.preferred_booth_tier, special_requirements: v.special_requirements }).total
    const proofFiles = (p.proofs ?? []).filter((f) => f.kind === 'eft_submission' || f.kind === 'eft_accessories')
    const newest = [...proofFiles].sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1))[0]
    let proofUrl: string | null = null
    if (newest) {
      const { data } = await db.storage.from('vendor-docs').createSignedUrl(newest.path, 60 * 60)
      proofUrl = data?.signedUrl ?? null
    }
    rows.push({
      id: v.id as string,
      name: (v.business_name as string) || (v.contact_name as string) || 'Unnamed',
      contact: (v.contact_name as string) || null,
      reference: eftReference(v),
      amount: bill,
      proofUrl,
      note: newest?.note ?? null,
      uploadedAt: (p.eft_submitted_at as string) || newest?.uploaded_at || '',
      paid: rosterPaid(v.admin_notes as string | null, v.paid_at as string | null),
    })
  }
  rows.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))

  const fmtDate = (iso: string) =>
    iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''

  // Totals across the proofs on this page: the full amount owed, and how much of
  // it is already confirmed paid, so Samreen sees the running total at a glance.
  const totalAmount = rows.reduce((s, r) => s + r.amount, 0)
  const paidAmount = rows.filter((r) => r.paid).reduce((s, r) => s + r.amount, 0)

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
                    <td className="px-5 py-3 font-mono text-xs text-neutral-600">{r.reference}</td>
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
