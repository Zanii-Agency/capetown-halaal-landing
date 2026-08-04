import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEftAdmin, hasEftMarker, hasNoEftMarker, getEftMode, getEftBankDetails, eftReference } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { vendorBill } from '@/lib/payments/vendor-bill'
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
      <h1 className="font-serif text-2xl text-[#1B1A17]">Master Lane</h1>
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
          Master lane
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
      <div className="px-6 pt-6 pb-2 h-full flex flex-col">
        {header}
        <div className="flex-1 min-h-0">
          <CustomerInboxClient currentUserId={user!.id} operators={operators} eftOnly embedded />
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
    reference: string
    amount: number | null
    outstanding: number | null
    submitted: boolean
    submitted_at: string | null
    added_at: string | null
    added_by: string | null
    marked: boolean
    collected: boolean
    reconciled: boolean
    accOwing: number
    accSubmitted: boolean
    accCollected: boolean
    accSettled: boolean
    proofs: Array<{ url: string; uploaded_at: string; note?: string; accessory?: boolean }>
  }

  // When each vendor was ADDED to the lane. Read from the audit trail rather
  // than guessed: nothing on the vendor row records it (the ⟦EFT⟧ marker is a
  // bare token with no timestamp). Rows added before 2026-07-27 have no event,
  // because the audit insert was writing to a column that does not exist inside
  // a silent catch, so it recorded nothing for its whole life. Those show a dash
  // rather than a fabricated date.
  const addedAt = new Map<string, { at: string; by: string | null }>()
  {
    const { data: ev } = await db
      .from('vendor_application_events')
      .select('application_id, created_at, actor_email, event_type')
      .eq('event_type', 'eft_lane_add')
      .order('created_at', { ascending: false })
    // DESC, so the first row per vendor is the MOST RECENT add: a vendor removed
    // and re-added should read from when they last came back.
    for (const e of (ev || []) as Array<{ application_id: string; created_at: string; actor_email: string | null }>) {
      if (!addedAt.has(e.application_id)) addedAt.set(e.application_id, { at: e.created_at, by: e.actor_email })
    }
  }

  type Contact = { id: string; business_name: string | null; contact_name: string | null; email: string | null; phone: string | null; reference: string }
  const rows: Row[] = []
  const candidates: Contact[] = []
  const excluded: Contact[] = []

  for (const a of (apps || []) as Array<Record<string, unknown>>) {
    const notes = (a.admin_notes as string) || ''
    const contact: Contact = {
      id: a.id as string,
      business_name: a.business_name as string | null,
      contact_name: a.contact_name as string | null,
      email: a.email as string | null,
      phone: a.phone as string | null,
      // Same EFT reference the vendor pays with (and the lane rows show), so the
      // add / exclude search matches a reference read off a bank deposit.
      reference: eftReference({ id: a.id as string, admin_notes: notes }),
    }
    // Excluded from EFT (handled manually): never in the lane list or the add picker.
    if (hasNoEftMarker(notes)) { excluded.push(contact); continue }
    const marked = hasEftMarker(notes)
    const state = parsePortalState(notes)
    const submitted = !!state.payment?.eft_submitted_at
    const collected = state.payment?.status === 'collected'
    const reconciled = state.payment?.status === 'paid' || !!a.paid_at
    const inLane = marked // individually selected (global-on vendors are handled in bulk, not listed until they submit)
    // ACCESSORY sub-ledger (split-bill, 2026-08-04): settled vendors paying
    // their accessory-electricity balance by EFT with a <ref>-ACC reference.
    const acc = state.payment?.acc
    const accSubmitted = !!acc?.submitted_at
    const accCollected = !!acc?.collected_at
    const accSettled = !!acc?.settled_at

    // Actionable set: individually marked, uploaded EFT proof (stall OR
    // accessory), OR EFT-collected (awaiting Yoco settlement).
    if (marked || submitted || collected || accSubmitted) {
      const pricing = computeVendorPricing({
        preferred_booth_tier: a.preferred_booth_tier as string,
        special_requirements: a.special_requirements,
      })
      // Only a truly-reconciled (paid) amount reduces the outstanding balance. A
      // 'collected' amount is interim, so it still shows the full amount to settle.
      const paidSoFar = reconciled ? (Number(state.payment?.amount) || 0) : 0
      const outstanding = Math.max(0, pricing.total - paidSoFar)
      const proofFiles = (state.payment?.proofs || []).filter((p) => p.kind === 'eft_submission' || p.kind === 'eft_accessories')
      const proofs: Row['proofs'] = []
      for (const p of proofFiles) {
        if (!p.path) continue
        try {
          const { data } = await db.storage.from('vendor-docs').createSignedUrl(p.path, 60 * 60)
          if (data?.signedUrl) proofs.push({ url: data.signedUrl, uploaded_at: p.uploaded_at, note: p.note, accessory: p.kind === 'eft_accessories' })
        } catch { /* skip unreachable proof */ }
      }
      rows.push({
        id: a.id as string,
        business_name: a.business_name as string | null,
        contact_name: a.contact_name as string | null,
        email: a.email as string | null,
        phone: a.phone as string | null,
        // The EFT reference the vendor was told to pay with (stall code if
        // allocated, else CTH+id tail), i.e. what lands on the bank statement,
        // so the operator can reconcile a deposit straight from the row.
        reference: eftReference({ id: a.id as string, admin_notes: notes }),
        amount: pricing.total || null,
        outstanding,
        submitted,
        submitted_at: state.payment?.eft_submitted_at || null,
        added_at: addedAt.get(a.id as string)?.at || null,
        added_by: addedAt.get(a.id as string)?.by || null,
        marked,
        collected,
        reconciled,
        // The figure the accessory-collect confirm dialog quotes. From the SAME
        // source markAccessoriesCollected writes from (vendorBill), so the
        // operator confirms the number that will actually be recorded, not the
        // generic outstanding (which can include non-accessory arrears).
        accOwing: (() => { try { return vendorBill({ id: a.id as string, preferred_booth_tier: a.preferred_booth_tier as string, special_requirements: a.special_requirements, admin_notes: notes, paid_at: a.paid_at as string | null }).accessories.owing } catch { return 0 } })(),
        accSubmitted,
        accCollected,
        accSettled,
        proofs,
      })
    } else if (!reconciled && !inLane) {
      // Candidate for the add / exclude pickers: not in lane, not already paid.
      candidates.push(contact)
    }
  }

  // Submitted-not-reconciled first (they need action), then the rest.
  rows.sort((x, y) => {
    const accActionable = (r: Row) => r.accSubmitted && !r.accSettled
    const rank = (r: Row) => ((r.submitted && !r.reconciled) || accActionable(r) ? 0 : r.reconciled ? 2 : 1)
    return rank(x) - rank(y)
  })

  return (
    <div className="p-6">
      {header}
      <EftAdminClient globalOn={globalOn} bank={getEftBankDetails()} rows={rows} candidates={candidates} excluded={excluded} />
    </div>
  )
}
