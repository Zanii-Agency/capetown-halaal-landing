import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEftAdmin, hasEftMarker, getEftMode, getEftBankDetails } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { CustomerInboxClient } from '../customer-inbox/CustomerInboxClient'
import EftAdminClient from './EftAdminClient'

export const dynamic = 'force-dynamic'

// TEMPORARY EFT lane management surface. Gated to the EFT admin email ON TOP of
// the admin layout's auth: every other operator (including Samreen) is redirected
// away and never sees this in the nav. Two tabs: Payments (lane management +
// reconcile) and Messages (the EFT-only inbox, reusing CustomerInboxClient).
export default async function EftAdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const email = user?.email ?? null
  if (!isEftAdmin(email)) redirect('/admin')

  const { tab } = await searchParams
  const activeTab = tab === 'messages' ? 'messages' : 'payments'
  const db = createAdminClient()

  const header = (
    <div className="mb-6">
      <h1 className="font-serif text-2xl text-[#1B1A17]">EFT payments (Yoco down)</h1>
      <p className="text-sm text-[#1B1A17]/55 mt-1">
        Temporary lane. Managed only from here, never on the main admin. Signed in as {email}.
      </p>
      <div className="flex gap-1 mt-4 border-b border-[#E5DCC4]">
        <Link
          href="/admin/eft"
          className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px ${activeTab === 'payments' ? 'border-[#cd2653] text-[#cd2653]' : 'border-transparent text-[#1B1A17]/55 hover:text-[#1B1A17]'}`}
        >
          Payments
        </Link>
        <Link
          href="/admin/eft?tab=messages"
          className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px ${activeTab === 'messages' ? 'border-[#cd2653] text-[#cd2653]' : 'border-transparent text-[#1B1A17]/55 hover:text-[#1B1A17]'}`}
        >
          Messages
        </Link>
      </div>
    </div>
  )

  if (activeTab === 'messages') {
    let operators: { id: string; email: string }[] = []
    try {
      const { data } = await db.from('admin_users').select('id, email').limit(50)
      operators = (data || []) as { id: string; email: string }[]
    } catch { /* empty */ }
    return (
      <div className="p-6 h-full flex flex-col">
        {header}
        <div className="flex-1 min-h-0">
          <CustomerInboxClient currentUserId={user!.id} operators={operators} eftOnly />
        </div>
      </div>
    )
  }

  // ---- Payments tab: gather the actionable lane set ----
  const globalOn = await getEftMode()

  const { data: apps } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, paid_at, preferred_booth_tier, special_requirements, status')
    .limit(2000)

  type Row = {
    id: string
    business_name: string | null
    contact_name: string | null
    email: string | null
    phone: string | null
    amount: number | null
    outstanding: number | null
    submitted: boolean
    submitted_at: string | null
    marked: boolean
    reconciled: boolean
    proofs: Array<{ url: string; uploaded_at: string; note?: string }>
  }

  const rows: Row[] = []
  const candidates: Array<{ id: string; business_name: string | null; contact_name: string | null; email: string | null }> = []

  for (const a of (apps || []) as Array<Record<string, unknown>>) {
    const notes = (a.admin_notes as string) || ''
    const marked = hasEftMarker(notes)
    const state = parsePortalState(notes)
    const submitted = !!state.payment?.eft_submitted_at
    const reconciled = state.payment?.status === 'paid' || !!a.paid_at
    const inLane = marked // individually selected (global-on vendors are handled in bulk, not listed until they submit)

    // Actionable set: individually marked OR has uploaded EFT proof.
    if (marked || submitted) {
      const pricing = computeVendorPricing({
        preferred_booth_tier: a.preferred_booth_tier as string,
        special_requirements: a.special_requirements,
      })
      const paidSoFar = Number(state.payment?.amount) || 0
      const outstanding = Math.max(0, pricing.total - paidSoFar)
      const proofFiles = (state.payment?.proofs || []).filter((p) => p.kind === 'eft_submission')
      const proofs: Row['proofs'] = []
      for (const p of proofFiles) {
        if (!p.path) continue
        try {
          const { data } = await db.storage.from('vendor-docs').createSignedUrl(p.path, 60 * 60)
          if (data?.signedUrl) proofs.push({ url: data.signedUrl, uploaded_at: p.uploaded_at, note: p.note })
        } catch { /* skip unreachable proof */ }
      }
      rows.push({
        id: a.id as string,
        business_name: a.business_name as string | null,
        contact_name: a.contact_name as string | null,
        email: a.email as string | null,
        phone: a.phone as string | null,
        amount: pricing.total || null,
        outstanding,
        submitted,
        submitted_at: state.payment?.eft_submitted_at || null,
        marked,
        reconciled,
        proofs,
      })
    } else if (!reconciled && !inLane) {
      // Candidate for the "add to lane" picker: not in lane, not already paid.
      candidates.push({
        id: a.id as string,
        business_name: a.business_name as string | null,
        contact_name: a.contact_name as string | null,
        email: a.email as string | null,
      })
    }
  }

  // Submitted-not-reconciled first (they need action), then the rest.
  rows.sort((x, y) => {
    const rank = (r: Row) => (r.submitted && !r.reconciled ? 0 : r.reconciled ? 2 : 1)
    return rank(x) - rank(y)
  })

  return (
    <div className="p-6">
      {header}
      <EftAdminClient globalOn={globalOn} bank={getEftBankDetails()} rows={rows} candidates={candidates} />
    </div>
  )
}
