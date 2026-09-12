import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isEftAdmin } from '@/lib/eft'
import { formatRand } from '@/lib/payments/pricing'
import { loadNewVendors, type NewVendorStatus } from '@/lib/payments/new-vendors-list'
import { AdminPage } from '@/components/admin/AdminPage'

export const dynamic = 'force-dynamic'

// MASTER-ONLY tracking page for the frozen "new vendor" cohort (never traded,
// hand-flipped onto master EFT, tagged ⟦NEWVENDOR⟧). Lists covert master-lane
// vendors, so it is gated to the EFT admin and redirects the festival owner.
const STATUS_STYLE: Record<NewVendorStatus, string> = {
  'Paid': 'bg-emerald-100 text-emerald-700',
  'Collected': 'bg-sky-100 text-sky-700',
  'Proof uploaded': 'bg-amber-100 text-amber-700',
  'Opened EFT': 'bg-neutral-100 text-neutral-600',
  'Not started': 'bg-neutral-100 text-neutral-500',
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white px-4 py-3">
      <div className="text-xs text-neutral-400">{label}</div>
      <div className="text-lg font-semibold text-neutral-900">{value}</div>
    </div>
  )
}

export default async function NewVendorsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')
  if (!isEftAdmin(user.email)) redirect('/admin')

  const { rows, totalOwed, paidCount } = await loadNewVendors()
  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''

  return (
    <AdminPage title="New Vendors" subtitle="First-time vendors (never traded before) on the master EFT lane">
      <div className="grid grid-cols-3 gap-3 mb-5">
        <Stat label="Vendors" value={String(rows.length)} />
        <Stat label="Paid" value={`${paidCount} / ${rows.length}`} />
        <Stat label="Still owed" value={formatRand(totalOwed)} />
      </div>
      <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-neutral-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-4 py-3">Business</th>
                <th className="text-left font-medium px-4 py-3">Phone</th>
                <th className="text-left font-medium px-4 py-3">Status</th>
                <th className="text-right font-medium px-4 py-3">Owed</th>
                <th className="text-left font-medium px-4 py-3">Applied</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3 font-medium text-neutral-900">{r.business_name}</td>
                  <td className="px-4 py-3 text-neutral-600 tabular-nums">{r.phone || ''}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-700">{formatRand(r.owed)}</td>
                  <td className="px-4 py-3 text-neutral-500">{fmtDate(r.applied)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-neutral-400">No new vendors tagged yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AdminPage>
  )
}
