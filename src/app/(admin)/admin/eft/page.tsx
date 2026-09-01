import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEftAdmin, hasEftMarker, hasNoEftMarker, getEftMode, getEftBankDetails, eftReference, onEftLane, vendorCommsInOwnerScope, getFullEftMode, eftProofVisibleToOwner } from '@/lib/eft'
import { parseAllocation } from '@/lib/stalls'
import { isTestVendor } from '@/lib/test-vendors'
import { parsePortalState } from '@/lib/portal-state'
import { computeVendorPricing, formatRand } from '@/lib/payments/pricing'
import { vendorBill } from '@/lib/payments/vendor-bill'
import { buildOpsDigest, type OpsDigest } from '@/lib/payments/ops-digest'
import { CustomerInboxClient } from '../customer-inbox/CustomerInboxClient'
import EftAdminClient from './EftAdminClient'
import EftOutreachClient, { type OutreachVendor } from './EftOutreachClient'

export const dynamic = 'force-dynamic'

// TEMPORARY EFT lane management surface. Gated to the EFT admin email ON TOP of
// the admin layout's auth: every other operator (including Samreen) is redirected
// away and never sees this in the nav. Two tabs: Payments (lane management +
// reconcile) and Messages (the EFT-only inbox, reusing CustomerInboxClient).
function MethodChip({ m }: { m: 'yoco' | 'eft' }) {
  const eft = m === 'eft'
  return (
    <span className={`inline-flex items-center justify-center w-11 h-6 rounded text-[10px] font-bold ${eft ? 'bg-[#cd2653]/10 text-[#cd2653]' : 'bg-[#1f8a4a]/12 text-[#1f8a4a]'}`}>
      {eft ? 'EFT' : 'Yoco'}
    </span>
  )
}

// Master-only daily pulse, rendered above the lane table: opens today, payments
// today, and the live Yoco/EFT rotation state (received-so-far + the next 3
// payers per tier). Same data the 20:00 WhatsApp digest carries.
function OpsPanel({ digest }: { digest: OpsDigest }) {
  const { opensToday, paymentsToday, paidTotal, rotation } = digest
  const tiers = [...rotation.tiers].sort(
    (a, b) => Number(b.hasPending) - Number(a.hasPending) || a.label.localeCompare(b.label),
  )
  return (
    <div className="mb-8 rounded-2xl border border-[#E5DCC4] bg-[#FBF7ED] p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-serif text-lg text-[#1B1A17]">Today · {digest.dateLabel}</h2>
        <span className="text-[11px] text-[#1B1A17]/45">pushed to your WhatsApp at 20:00</span>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-5">
        <div className="rounded-xl bg-white border border-[#E5DCC4] px-4 py-3">
          <div className="text-2xl font-semibold text-[#1B1A17]">{opensToday.count}</div>
          <div className="text-xs text-[#1B1A17]/55">opened the portal today</div>
        </div>
        <div className="rounded-xl bg-white border border-[#E5DCC4] px-4 py-3">
          <div className="text-2xl font-semibold text-[#1B1A17]">
            {paymentsToday.length} <span className="text-sm font-normal text-[#1B1A17]/55">· {formatRand(paidTotal)}</span>
          </div>
          <div className="text-xs text-[#1B1A17]/55">paid today</div>
        </div>
      </div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs uppercase tracking-wider text-[#1B1A17]/55 font-semibold">Yoco / EFT rotation</p>
        <span className="text-[11px] text-[#1B1A17]/45">
          {!rotation.eftModeOn
            ? 'EFT mode OFF'
            : rotation.activated && rotation.startedAt
              ? `live since ${new Date(rotation.startedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`
              : 'not activated'}
        </span>
      </div>
      {!rotation.eftModeOn ? (
        <div className="rounded-xl bg-white border border-[#E5DCC4] px-4 py-3 text-sm text-[#1B1A17]">
          <span className="font-semibold">Card only.</span> Everyone pays by Yoco, except{' '}
          <span className="font-semibold">{rotation.recentEftOpeners}</span> who opened EFT bank details in the last 48h
          (still on EFT until they pay or the window lapses).
        </div>
      ) : (
        <div className="rounded-xl bg-white border border-[#E5DCC4] divide-y divide-[#F0E9D6] overflow-hidden">
          {tiers.map((t) => (
            <div key={t.slug} className={`flex items-center gap-3 px-4 py-2.5 ${t.hasPending ? '' : 'opacity-45'}`}>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[#1B1A17] truncate">
                  {t.label} {t.isSmall && <span className="text-[10px] text-[#1B1A17]/40">small</span>}
                </div>
                <div className="text-[11px] text-[#1B1A17]/45">{t.received} paid since start</div>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-[#1B1A17]/40 mr-1">next</span>
                {t.nextThree.map((m, i) => (
                  <span key={i} className={i === 0 ? '' : 'opacity-40'}>
                    <MethodChip m={m} />
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default async function EftAdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const email = user?.email ?? null
  if (!isEftAdmin(email)) redirect('/admin')

  const { tab } = await searchParams
  const activeTab = tab === 'messages' ? 'messages' : tab === 'outreach' ? 'outreach' : 'payments'
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
        <Link
          href="/admin/eft?tab=outreach"
          className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px ${activeTab === 'outreach' ? 'border-[#cd2653] text-[#cd2653]' : 'border-transparent text-[#1B1A17]/55 hover:text-[#1B1A17]'}`}
        >
          Outreach
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

  if (activeTab === 'outreach') {
    // Audience = the REAL EFT lane: vendors who actually went through EFT
    // (⟦EFT⟧-designated or a real EFT money footprint), NOT every unpaid applicant
    // (Taona 2026-09-02: the ~40 on the proofs list, not ~170). Intersected with
    // `!vendorCommsInOwnerScope` so the SEND stays walled from Samreen: a stall-
    // paid vendor settling accessories by EFT is on the lane yet visible to her,
    // and messaging them would leak. Vendors with no contact channel are dropped.
    const { data: apps } = await db
      .from('vendor_applications')
      .select('id, business_name, contact_name, email, phone, admin_notes, paid_at, status')
      .eq('status', 'approved')
      .limit(2000)

    const vendors: OutreachVendor[] = []
    for (const a of (apps || []) as Array<Record<string, unknown>>) {
      if (isTestVendor(a as Parameters<typeof isTestVendor>[0])) continue // never message demo/seed rows
      const notes = (a.admin_notes as string) || ''
      const email = a.email as string | null
      const phone = a.phone as string | null
      const paidAt = a.paid_at as string | null
      if (!onEftLane(notes, { email, phone })) continue
      if (vendorCommsInOwnerScope(notes, paidAt)) continue // drop anyone Samreen can see: keep the send walled
      if (!email && !phone) continue
      vendors.push({
        id: a.id as string,
        business_name: a.business_name as string | null,
        contact_name: a.contact_name as string | null,
        email,
        phone,
        stall: parseAllocation(notes).stall || null,
      })
    }
    vendors.sort((x, y) => (x.business_name || '').localeCompare(y.business_name || ''))

    return (
      <div className="p-6">
        {header}
        <EftOutreachClient vendors={vendors} />
      </div>
    )
  }

  // ---- Payments tab: gather the actionable lane set ----
  const globalOn = await getEftMode()
  // Post-cutover EFT proofs from non-frozen vendors belong to Samreen's new
  // EFT-proofs lane (/admin/eft-proofs), NOT this covert master lane (Taona
  // 2026-09-02). The frozen protected 66 stay here regardless. eftProofVisibleToOwner
  // is the single source of "linked to Samreen's new lane", so reusing it keeps the
  // two surfaces from ever disagreeing about who owns a vendor.
  const fullEft = await getFullEftMode()

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
    presented: boolean        // shown to the owner as paid-Yoco (presented_eft set)
    ownerReconciled: boolean  // operator marked their own EFT reconciliation done
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
    // On Samreen's new lane? Then it is hers, not the master's: drop it entirely
    // (neither a lane row nor an add-candidate). The fence only fires for a
    // post-cutover proof from a vendor NOT in the frozen 66, so the covert cohort
    // is untouched.
    if (eftProofVisibleToOwner(a.id as string, notes, fullEft)) continue
    const contact: Contact = {
      id: a.id as string,
      business_name: a.business_name as string | null,
      contact_name: a.contact_name as string | null,
      email: a.email as string | null,
      phone: a.phone as string | null,
      // Same EFT reference the vendor pays with (and the lane rows show), so the
      // add / exclude search matches a reference read off a bank deposit.
      reference: eftReference({ id: a.id as string, admin_notes: notes, business_name: a.business_name as string | null }),
    }
    // Excluded from EFT (handled manually): never in the lane list or the add picker.
    if (hasNoEftMarker(notes)) { excluded.push(contact); continue }
    const marked = hasEftMarker(notes)
    const state = parsePortalState(notes)
    const submitted = !!state.payment?.eft_submitted_at
    const collected = state.payment?.status === 'collected'
    const reconciled = state.payment?.status === 'paid' || !!a.paid_at
    // Presented to the owner as paid-Yoco (still tracked on the lane so the
    // operator can mark their own reconciliation done later).
    const presented = !!state.payment?.presented_eft
    const ownerReconciled = !!state.payment?.reconciled_at
    const inLane = marked // individually selected (global-on vendors are handled in bulk, not listed until they submit)
    // ACCESSORY sub-ledger (split-bill, 2026-08-04): settled vendors paying
    // their accessory-electricity balance by EFT with a <ref>-ACC reference.
    const acc = state.payment?.acc
    const accSubmitted = !!acc?.submitted_at
    const accCollected = !!acc?.collected_at
    const accSettled = !!acc?.settled_at

    // Actionable set: individually marked, uploaded EFT proof (stall OR
    // accessory), OR EFT-collected (awaiting Yoco settlement).
    if (marked || submitted || collected || accSubmitted || presented) {
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
        reference: eftReference({ id: a.id as string, admin_notes: notes, business_name: a.business_name as string | null }),
        amount: pricing.total || null,
        outstanding,
        submitted,
        submitted_at: state.payment?.eft_submitted_at || null,
        added_at: addedAt.get(a.id as string)?.at || null,
        added_by: addedAt.get(a.id as string)?.by || null,
        marked,
        collected,
        reconciled,
        presented,
        ownerReconciled,
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

  const digest = await buildOpsDigest()

  return (
    <div className="p-6">
      {header}
      <OpsPanel digest={digest} />
      <EftAdminClient globalOn={globalOn} bank={getEftBankDetails()} rows={rows} candidates={candidates} excluded={excluded} />
    </div>
  )
}
