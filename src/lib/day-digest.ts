/**
 * Owner-safe "what happened on a day" digest, for any date. Unions the two audit
 * streams (vendor_application_events + site_events), scopes them EXACTLY like the
 * owner pages (vendorInOwnerScope + the audit wall hiddenFromOwner /
 * siteEventHiddenFromOwner), and groups the day's events into plain buckets:
 * payments received, payments reversed, withdrawals, plans & extensions,
 * contracts signed, documents & proofs. The EFT admin (dev@/taona@) sees the
 * unwalled day. Read-only; feeds /admin/todo's Day card, its endpoint, and the
 * connector `day_activity` tool.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { isEftAdmin, onCovertMasterLane, eftProofVisibleToOwner, getPaymentRail, getFullEftMode } from '@/lib/eft'
import { revealsPaymentArrangement } from '@/lib/eft'

export type DayEntry = { name: string; detail: string; at: string }
export type DayGroup = { key: string; label: string; items: DayEntry[] }
export type DayDigest = { date: string; dateLabel: string; total: number; groups: DayGroup[] }

const SAST_OFFSET = 2 * 3600 * 1000 // UTC+2, no DST
/** [start,end) UTC ISO for the SAST calendar day of `dateStr` (YYYY-MM-DD). */
function sastDayBounds(dateStr: string): { startIso: string; endIso: string } {
  const [y, m, d] = dateStr.split('-').map(Number)
  const startUtc = Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0) - SAST_OFFSET
  return { startIso: new Date(startUtc).toISOString(), endIso: new Date(startUtc + 864e5).toISOString() }
}
/** Today's date in SAST as YYYY-MM-DD. */
export function sastToday(): string {
  return new Date(Date.now() + SAST_OFFSET).toISOString().slice(0, 10)
}
const rand = (n: unknown) => (typeof n === 'number' && n > 0 ? `R${n.toLocaleString('en-ZA')}` : '')
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})

// event_type -> bucket + a human detail builder
const RECEIVED = new Set(['payment_captured', 'payment_manual'])
const DOC = new Set(['vendor_doc_uploaded', 'profile_logo_uploaded'])
// EFT-lane / payment events stay walled by scope (the master EFT lane is the one
// secret). Everything else — withdrawals, contracts, documents, stall changes —
// is operational and shown for ALL vendors (Taona 2026-09-07: 'everything that
// happened, except the master EFT lane').
const PAYMENT_EVENTS = new Set(['payment_captured', 'payment_manual', 'payment_reverted', 'payment_plan_proposed', 'payment_extension_granted', 'eft_proof_uploaded', 'payment_proof_uploaded', 'payment_collected', 'eft_collected', 'accessories_collected'])

export async function loadDayDigest(dateStr?: string): Promise<DayDigest> {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') ? (dateStr as string) : sastToday()
  const { data: { user } } = await (await createClient()).auth.getUser()
  const unwalled = isEftAdmin(user?.email)
  const [rail, fullEft] = await Promise.all([getPaymentRail(), getFullEftMode()])
  const { startIso, endIso } = sastDayBounds(date)
  const db = createAdminClient()

  const [vae, se] = await Promise.all([
    db.from('vendor_application_events')
      .select('id, application_id, event_type, note, before_value, after_value, actor_email, created_at')
      .gte('created_at', startIso).lt('created_at', endIso).order('created_at', { ascending: false }).limit(1000),
    db.from('site_events')
      .select('id, event_type, metadata, created_at')
      .gte('created_at', startIso).lt('created_at', endIso)
      .or('event_type.eq.contract_signed,event_type.ilike.vendor_doc_%,event_type.ilike.payment_%')
      .order('created_at', { ascending: false }).limit(1000),
  ])

  // Resolve vendor names + scope for every application_id we touch.
  const ids = new Set<string>()
  for (const e of (vae.data || []) as Array<{ application_id: string | null }>) if (e.application_id) ids.add(e.application_id)
  for (const e of (se.data || []) as Array<{ metadata: unknown }>) {
    const m = asObj((e as { metadata: unknown }).metadata)
    const id = (m.application_id || m.vendor_id)
    if (typeof id === 'string') ids.add(id)
  }
  const vendorMap: Record<string, { name: string; covert: boolean; proofVisible: boolean }> = {}
  if (ids.size) {
    const { data } = await db.from('vendor_applications').select('id, business_name, contact_name, admin_notes, paid_at').in('id', [...ids])
    for (const v of (data || []) as Array<{ id: string; business_name: string | null; contact_name: string | null; admin_notes: string | null; paid_at: string | null }>) {
      vendorMap[v.id] = {
        name: v.business_name || v.contact_name || 'A vendor',
        // The ONLY thing hidden from her is the COVERT ...191 lane. Her own
        // samreen_eft payments and proofs (visible on her EFT Proofs page) are hers.
        covert: onCovertMasterLane(v.id, v.admin_notes, rail, fullEft),
        proofVisible: eftProofVisibleToOwner(v.id, v.admin_notes, fullEft),
      }
    }
  }

  const buckets: Record<string, DayEntry[]> = { received: [], eft_pending: [], accessories: [], reversed: [], withdrawn: [], plan: [], contract: [], docs: [] }
  const add = (k: string, name: string, detail: string, at: string) => buckets[k].push({ name, detail, at })

  for (const e of (vae.data || []) as Array<{ application_id: string | null; event_type: string; note: string | null; before_value: unknown; after_value: unknown; created_at: string }>) {
    const v = e.application_id ? vendorMap[e.application_id] : undefined
    if (!unwalled) {
      if (PAYMENT_EVENTS.has(e.event_type)) {
        // Hide ONLY the covert ...191 lane. Her Yoco + her samreen_eft payments
        // and proofs (which she sees on the EFT Proofs page) are hers to see.
        if (v?.covert) continue
      } else if (revealsPaymentArrangement([e.event_type, e.note, JSON.stringify(e.after_value), JSON.stringify(e.before_value)].join(' '))) {
        continue
      }
    }
    const name = v?.name || 'A vendor'
    const after = asObj(e.after_value)
    if (e.event_type === 'accessories_collected') add('accessories', name, rand(Number(after.amount ?? e.after_value)) || 'Accessories paid', e.created_at)
    else if (e.event_type === 'eft_proof_uploaded' || e.event_type === 'payment_proof_uploaded') add('eft_pending', name, 'EFT proof uploaded, confirm it', e.created_at)
    else if (RECEIVED.has(e.event_type)) add('received', name, rand(after.total_paid ?? after.amount) || 'Stall fee paid', e.created_at)
    else if (e.event_type === 'payment_reverted') add('reversed', name, 'Payment reverted to unpaid', e.created_at)
    else if (e.event_type === 'vendor_withdrawn') add('withdrawn', name, `Withdrew${asObj(after.withdrawn).reason ? `: ${String(asObj(after.withdrawn).reason).slice(0, 80)}` : ''}`, e.created_at)
    else if (e.event_type === 'payment_plan_proposed') add('plan', name, `Payment plan${e.note ? `: ${e.note.slice(0, 80)}` : ''}`, e.created_at)
    else if (e.event_type === 'payment_extension_granted') add('plan', name, `More time to pay${e.note ? `, ${e.note.slice(0, 60)}` : ''}`, e.created_at)
    else if (e.event_type === 'contract_signed') add('contract', name, 'Signed their contract', e.created_at)
    else if (DOC.has(e.event_type)) add('docs', name, 'Uploaded a document', e.created_at)
  }
  for (const e of (se.data || []) as Array<{ event_type: string; metadata: unknown; created_at: string }>) {
    const m = asObj(e.metadata)
    const id = (typeof m.application_id === 'string' ? m.application_id : typeof m.vendor_id === 'string' ? m.vendor_id : null)
    const v = id ? vendorMap[id] : undefined
    // Same rule as above: hide only the covert lane's payment events.
    if (!unwalled && e.event_type.startsWith('payment_') && v?.covert) continue
    const name = v?.name || 'A vendor'
    if (e.event_type === 'contract_signed') add('contract', name, 'Signed their contract', e.created_at)
    else if (e.event_type.startsWith('vendor_doc_')) add('docs', name, 'Uploaded a document', e.created_at)
    else if (e.event_type.startsWith('payment_')) add('received', name, 'Payment activity', e.created_at)
  }

  // de-dupe contracts (both streams can carry contract_signed)
  // Both streams can carry the same contract/doc. Drop a generic "A vendor" entry
  // when a NAMED entry shares its second, then de-dupe exact repeats.
  const dedupe = (arr: DayEntry[]) => {
    const namedSeconds = new Set(arr.filter((x) => x.name !== 'A vendor').map((x) => x.at.slice(0, 19)))
    const seen = new Set<string>()
    return arr.filter((x) => {
      if (x.name === 'A vendor' && namedSeconds.has(x.at.slice(0, 19))) return false
      const k = x.name + x.at.slice(0, 16)
      if (seen.has(k)) return false
      seen.add(k); return true
    })
  }
  const groups: DayGroup[] = [
    { key: 'received', label: 'Stall fees paid', items: dedupe(buckets.received) },
    { key: 'accessories', label: 'Accessories paid', items: dedupe(buckets.accessories) },
    { key: 'eft_pending', label: 'EFT payments in (awaiting your confirm)', items: dedupe(buckets.eft_pending) },
    { key: 'plan', label: 'Payment plans & extensions', items: dedupe(buckets.plan) },
    { key: 'withdrawn', label: 'Withdrawals', items: dedupe(buckets.withdrawn) },
    { key: 'reversed', label: 'Payments reversed', items: dedupe(buckets.reversed) },
    { key: 'contract', label: 'Contracts signed', items: dedupe(buckets.contract) },
    { key: 'docs', label: 'Documents uploaded', items: dedupe(buckets.docs) },
  ]
  const dateLabel = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  return { date, dateLabel, total: groups.reduce((s, g) => s + g.items.length, 0), groups }
}
