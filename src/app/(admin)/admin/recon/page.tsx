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

type Tab = 'wrong' | 'plans'

const fmt = (d?: string | null) => d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '-'

export default async function ReconPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')
  if (!canSeeRecon(user.email)) redirect('/admin')
  const { tab: raw } = await searchParams
  const tab: Tab = raw === 'plans' ? 'plans' : 'wrong'

  const db = createAdminClient()
  const { data } = await db.from('vendor_applications')
    .select('id,business_name,contact_name,email,phone,admin_notes,paid_at,preferred_booth_tier,special_requirements,status,is_duplicate')
    .eq('status', 'approved').limit(2000)

  const wrong: Array<{ id: string; name: string; contact: string; phone: string; bill: number; paid: number; owing: number; payments: Array<{ amount: number; date: string | null; ref: string | null }> }> = []
  const plans: Array<{ id: string; name: string; contact: string; phone: string; total: number; inst: Array<{ date: string; amount: number }>; paid: number; wrongPaid: number; next: { date: string; amount: number } | null }> = []
  const today = new Date().toISOString().slice(0, 10)

  for (const v of data ?? []) {
    if (v.is_duplicate || isTestVendor(v)) continue
    const p = parsePortalState(v.admin_notes || '').payment
    let bill: ReturnType<typeof vendorBill>
    try { bill = vendorBill({ id: v.id, preferred_booth_tier: v.preferred_booth_tier, special_requirements: v.special_requirements, admin_notes: v.admin_notes, paid_at: v.paid_at }) } catch { continue }
    const wa = p?.wrong_account
    const name = (v.business_name || '').trim()
    if (wa) wrong.push({ id: v.id, name, contact: v.contact_name || '', phone: v.phone || '', bill: bill.liveTotal, paid: wa.total, owing: Math.max(0, bill.liveTotal - wa.total), payments: wa.payments })
    const a = p?.arrangement
    if (a?.plan_status && (a.installments?.length ?? 0) > 0) {
      const inst = [...(a.installments as Array<{ date: string; amount: number }>)].sort((x, y) => (x.date < y.date ? -1 : 1))
      const paid = wa ? wa.total : bill.paidTotal
      let cum = 0
      const next = inst.find((i) => (cum += Number(i.amount)) > paid) ?? null
      plans.push({ id: v.id, name, contact: v.contact_name || '', phone: v.phone || '', total: inst.reduce((s, i) => s + Number(i.amount), 0), inst, paid, wrongPaid: wa?.total ?? 0, next })
    }
  }
  wrong.sort((a, b) => a.name.localeCompare(b.name))
  plans.sort((a, b) => (a.next?.date || '9') < (b.next?.date || '9') ? -1 : 1)
  const wTotal = wrong.reduce((s, r) => s + r.paid, 0)
  const wOwing = wrong.reduce((s, r) => s + r.owing, 0)

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'wrong', label: 'Wrong Account Payments', count: wrong.length },
    { key: 'plans', label: 'Payment Plans', count: plans.length },
  ]
  const th = 'px-3 py-2 text-left font-medium text-neutral-500'
  const td = 'px-3 py-2.5 align-top'

  return (
    <AdminPage title="Reconciliation" subtitle="Payments made to the wrong account, and the payment plans approved with vendors. For reconciling offline.">
      <div className="flex gap-2 mb-4">
        {tabs.map((t) => (
          <Link key={t.key} href={`/admin/recon?tab=${t.key}`} className={`px-3 py-1.5 rounded-lg text-sm border ${tab === t.key ? 'bg-[#cd2653] text-white border-[#cd2653]' : 'bg-white border-neutral-200 text-neutral-700'}`}>
            {t.label} <span className="opacity-70">{t.count}</span>
          </Link>
        ))}
      </div>

      {tab === 'wrong' ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {[['Vendors', String(wrong.length)], ['Paid to wrong account', formatRand(wTotal)], ['Paid in full', String(wrong.filter((r) => r.owing === 0).length)], ['Still owing', formatRand(wOwing)]].map(([l, v]) => (
              <div key={l} className="rounded-xl border border-neutral-200 bg-white p-3"><div className="text-xs text-neutral-500">{l}</div><div className="text-lg font-semibold">{v}</div></div>
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50"><tr><th className={th}>Vendor</th><th className={th}>Payments (amount, date, bank reference)</th><th className={`${th} text-right`}>Bill</th><th className={`${th} text-right`}>Paid</th><th className={`${th} text-right`}>Still owing</th></tr></thead>
              <tbody>
                {wrong.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-100">
                    <td className={td}><Link href={`/admin/vendors/${r.id}`} className="font-medium hover:underline">{r.name}</Link><div className="text-xs text-neutral-500">{r.contact} · {r.phone}</div></td>
                    <td className={td}>{r.payments.map((x, i) => <div key={i}>{formatRand(x.amount)} on {fmt(x.date)}{x.ref ? <span className="text-neutral-500"> · {x.ref}</span> : null}</div>)}</td>
                    <td className={`${td} text-right tabular-nums`}>{formatRand(r.bill)}</td>
                    <td className={`${td} text-right tabular-nums font-medium`}>{formatRand(r.paid)}</td>
                    <td className={`${td} text-right tabular-nums ${r.owing ? 'text-[#cd2653] font-semibold' : 'text-emerald-700'}`}>{r.owing ? formatRand(r.owing) : 'Paid in full'}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-neutral-200 font-semibold"><td className={td}>Total</td><td className={td} /><td className={td} /><td className={`${td} text-right tabular-nums`}>{formatRand(wTotal)}</td><td className={`${td} text-right tabular-nums`}>{formatRand(wOwing)}</td></tr>
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50"><tr><th className={th}>Vendor</th><th className={th}>Instalments</th><th className={`${th} text-right`}>Plan total</th><th className={`${th} text-right`}>Paid so far</th><th className={th}>Next due</th></tr></thead>
            <tbody>
              {plans.map((r) => (
                <tr key={r.id} className="border-t border-neutral-100">
                  <td className={td}><Link href={`/admin/vendors/${r.id}`} className="font-medium hover:underline">{r.name}</Link><div className="text-xs text-neutral-500">{r.contact} · {r.phone}</div></td>
                  <td className={td}>{r.inst.map((i, k) => <div key={k}>{fmt(i.date)}: {formatRand(Number(i.amount))}</div>)}</td>
                  <td className={`${td} text-right tabular-nums`}>{formatRand(r.total)}</td>
                  <td className={`${td} text-right tabular-nums`}>{formatRand(r.paid)}{r.wrongPaid ? <div className="text-xs text-neutral-500">to wrong account</div> : null}</td>
                  <td className={td}>{r.next ? <span className={r.next.date < today ? 'text-[#cd2653] font-semibold' : ''}>{fmt(r.next.date)} · {formatRand(Number(r.next.amount))}{r.next.date < today ? ' (overdue)' : ''}</span> : <span className="text-emerald-700">Complete</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  )
}
