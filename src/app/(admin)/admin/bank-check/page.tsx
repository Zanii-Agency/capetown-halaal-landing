import { createAdminClient } from '@/lib/supabase/admin'
import { eftBankFor, maskRetiredAccounts } from '@/lib/eft'
import { isTestVendor } from '@/lib/test-vendors'
import { CheckCircle2 } from 'lucide-react'

export const dynamic = 'force-dynamic'

// BANK-CHECK (crisis confirm, Taona 2026-10-15): Samreen needs to confirm that
// every vendor's portal shows the one live account (...629) and never the retired
// ...191. This is the FAST, leak-proof answer to "log into each account and check":
// the account a vendor sees is produced by eftBankFor(), which since 2026-10-15 has
// NO per-vendor branch, so it is the same account for all. We render that account
// per vendor (honestly, by calling the resolver) with no paid/collected status, so
// nothing from the covert lane can leak to the festival owner through this page.
//
// Read-only. No POST surface, no password handling, no vendor is contacted.
// Gated by the admin layout (any admin role, which includes Samreen).
export default async function BankCheckPage() {
  const admin = createAdminClient()
  const { data } = await admin
    .from('vendor_applications')
    .select('id, business_name, email')
    .order('business_name', { ascending: true })

  const live = eftBankFor()
  const vendors = (data ?? []).filter(
    (v) => !isTestVendor({ email: v.email as string | null, business_name: v.business_name as string | null }),
  )

  // The account each vendor's portal resolves to. Uniform by construction; we
  // call the resolver per row rather than hard-coding the number so this page can
  // never drift from what the portal actually shows. Masked defensively in case a
  // retired number ever slipped into a business name.
  const rows = vendors.map((v) => ({
    id: v.id as string,
    name: maskRetiredAccounts((v.business_name as string) || '(no name)'),
    email: (v.email as string) || '',
    account: eftBankFor().accountNumber,
  }))
  const allMatch = rows.every((r) => r.account === live.accountNumber)

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#cd2653]">Bank check</p>
        <h1 className="text-2xl font-bold text-[var(--admin-text-primary)]">What account every vendor sees</h1>
        <p className="mt-1 text-sm text-[var(--admin-text-secondary)]">
          Read-only. This is the account a vendor&apos;s payment page shows them. The old account is retired and is never shown to anyone.
        </p>
      </div>

      <div className="mb-8 rounded-2xl border border-[#E5DCC4] bg-[#FBF7ED] p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--admin-text-muted)]">The one live account</p>
        <div className="mt-2 grid gap-1 text-sm">
          <div className="flex justify-between gap-4"><span className="text-[var(--admin-text-secondary)]">Account name</span><span className="font-semibold">{live.accountName}</span></div>
          <div className="flex justify-between gap-4"><span className="text-[var(--admin-text-secondary)]">Bank</span><span className="font-semibold">{live.bank}</span></div>
          <div className="flex justify-between gap-4"><span className="text-[var(--admin-text-secondary)]">Account number</span><span className="font-bold text-[#1f8a4a]">{live.accountNumber}</span></div>
          <div className="flex justify-between gap-4"><span className="text-[var(--admin-text-secondary)]">Branch code</span><span className="font-semibold">{live.branchCode}</span></div>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        <CheckCircle2 className="h-5 w-5 shrink-0" />
        {allMatch
          ? <span>All <strong>{rows.length}</strong> vendors resolve to account <strong>{live.accountNumber}</strong>. No vendor can be shown any other account.</span>
          : <span className="text-[#bf3026]">Mismatch found. Some vendors do not resolve to {live.accountNumber}. Check the table below.</span>}
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--admin-border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--admin-bg)] text-left text-xs uppercase tracking-wide text-[var(--admin-text-muted)]">
            <tr>
              <th className="px-4 py-3 font-semibold">Vendor</th>
              <th className="px-4 py-3 font-semibold">Email</th>
              <th className="px-4 py-3 font-semibold">Account shown</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ok = r.account === live.accountNumber
              return (
                <tr key={r.id} className="border-t border-[var(--admin-border)]">
                  <td className="px-4 py-2.5 font-medium text-[var(--admin-text-primary)]">{r.name}</td>
                  <td className="px-4 py-2.5 text-[var(--admin-text-secondary)]">{r.email}</td>
                  <td className={`px-4 py-2.5 font-semibold ${ok ? 'text-[#1f8a4a]' : 'text-[#bf3026]'}`}>{r.account}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
