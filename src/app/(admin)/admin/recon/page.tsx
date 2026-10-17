import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { AdminPage } from '@/components/admin/AdminPage'
import { parsePortalState } from '@/lib/portal-state'
import { vendorBill } from '@/lib/payments/vendor-bill'
import { formatRand } from '@/lib/payments/pricing'
import { isTestVendor } from '@/lib/test-vendors'
import { canSeeRecon } from '@/lib/recon'

export const dynamic = 'force-dynamic'

// Recon 2026-10-17 (Taona): Samreen's new view. Two tabs:
//   wrong  = payments verified from proof images as paid into a wrong account
//            (payment.wrong_account). Amounts, dates, bank references, never an
//            account number, never the proof image.
//   plans  = the real payment plans the bot approved (payment.arrangement).
// The demo login cannot open this (canSeeRecon), so it keeps the pre-recon view.

const fmt = (d?: string | null) => d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '-'

export default async function ReconPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')
  if (!canSeeRecon(user.email)) redirect('/admin')

  const db = createAdminClient()
  const { data } = await db.from('vendor_applications')
    .select('id,business_name,contact_name,email,phone,admin_notes,paid_at,preferred_booth_tier,special_requirements,status,is_duplicate')
    .eq('status', 'approved').limit(2000)

  const wrong: Array<{ id: string; name: string; contact: string; phone: string; bill: number; paid: number; owing: number; accTotal: number; accOwing: number; payments: Array<{ amount: number; date: string | null; ref: string | null }> }> = []

  for (const v of data ?? []) {
    if (v.is_duplicate || isTestVendor(v)) continue
    const p = parsePortalState(v.admin_notes || '').payment
    let bill: ReturnType<typeof vendorBill>
    try { bill = vendorBill({ id: v.id, preferred_booth_tier: v.preferred_booth_tier, special_requirements: v.special_requirements, admin_notes: v.admin_notes, paid_at: v.paid_at }) } catch { continue }
    const wa = p?.wrong_account
    const name = (v.business_name || '').trim()
    if (wa) wrong.push({ id: v.id, name, contact: v.contact_name || '', phone: v.phone || '', bill: bill.liveTotal, paid: wa.total, owing: Math.max(0, bill.liveTotal - wa.total), accTotal: bill.accessories.total, accOwing: Math.max(0, bill.accessories.total - Math.max(0, wa.total - bill.stall.price)), payments: wa.payments })
  }
  wrong.sort((a, b) => a.name.localeCompare(b.name))
  const wTotal = wrong.reduce((s, r) => s + r.paid, 0)
  const wOwing = wrong.reduce((s, r) => s + r.owing, 0)

  const th = 'px-3 py-2 text-left font-medium text-neutral-500'
  const td = 'px-3 py-2.5 align-top'

  return (
    <AdminPage title="Reconciliation" subtitle="Payments made to the wrong account, verified from each proof. Vendors on a payment plan are listed here too; their plan is under Paid Vendors.">
      <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {[['Vendors', String(wrong.length)], ['Paid to wrong account', formatRand(wTotal)], ['Paid in full', String(wrong.filter((r) => r.owing === 0).length)], ['Still owing', formatRand(wOwing)]].map(([l, v]) => (
              <div key={l} className="rounded-xl border border-neutral-200 bg-white p-3"><div className="text-xs text-neutral-500">{l}</div><div className="text-lg font-semibold">{v}</div></div>
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50"><tr><th className={th}>Vendor</th><th className={th}>Payments (amount, date, bank reference)</th><th className={th}>Accessories</th><th className={`${th} text-right`}>Bill</th><th className={`${th} text-right`}>Paid</th><th className={`${th} text-right`}>Still owing</th></tr></thead>
              <tbody>
                {wrong.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-100">
                    <td className={td}><Link href={`/admin/vendors/${r.id}`} className="font-medium hover:underline">{r.name}</Link><div className="text-xs text-neutral-500">{r.contact} · {r.phone}</div></td>
                    <td className={td}>{r.payments.map((x, i) => <div key={i}>{formatRand(x.amount)} on {fmt(x.date)}{x.ref ? <span className="text-neutral-500"> · {x.ref}</span> : null}</div>)}</td>
                    <td className={td}>{r.accTotal <= 0 ? <span className="text-neutral-400">None</span> : r.accOwing === 0 ? <span className="text-emerald-700">Paid ({formatRand(r.accTotal)})</span> : <span className="text-[#cd2653] font-medium">Owing {formatRand(r.accOwing)} of {formatRand(r.accTotal)}</span>}</td>
                    <td className={`${td} text-right tabular-nums`}>{formatRand(r.bill)}</td>
                    <td className={`${td} text-right tabular-nums font-medium`}>{formatRand(r.paid)}</td>
                    <td className={`${td} text-right tabular-nums ${r.owing ? 'text-[#cd2653] font-semibold' : 'text-emerald-700'}`}>{r.owing ? formatRand(r.owing) : 'Paid in full'}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-neutral-200 font-semibold"><td className={td}>Total</td><td className={td} /><td className={td} /><td className={td} /><td className={`${td} text-right tabular-nums`}>{formatRand(wTotal)}</td><td className={`${td} text-right tabular-nums`}>{formatRand(wOwing)}</td></tr>
              </tbody>
            </table>
          </div>
      </>
    </AdminPage>
  )
}
