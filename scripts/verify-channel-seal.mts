/**
 * Adversarial check on the per-channel inbox split.
 *
 * The refactor's one non-negotiable (Taona, 2026-07-27): "the current master lane
 * limitations that blind samreen must not be broken just cause of this update."
 *
 * So this does NOT trust the loaders' own filtering. It loads each channel AS
 * Samreen, then re-derives, from vendor_applications directly, whether each
 * returned thread's vendor is one she is allowed to see, and fails on any
 * disagreement. A seal that is only tested by the code that implements it is not
 * tested.
 *
 *   npx tsx scripts/verify-channel-seal.mts
 */
// env comes from --env-file=.env.local (see the run line above)
import { createClient } from '@supabase/supabase-js'
import { loadWhatsAppThreads, loadMailThreads } from '../src/lib/inbox/channel-threads'
import { vendorInOwnerScope } from '../src/lib/eft'
import { isMasterOnlySender } from '../src/lib/master-only-senders'

const SAMREEN = 'capetownhalaal@gmail.com'
const MASTER = 'dev@cthalaal.co.za'  // the confined EFT mailbox. taona@ (the master) is now also an EFT admin (2026-09-02); this script only checks the owner (Samreen) seal, which is unaffected.

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const { data: apps } = await db.from('vendor_applications').select('id, business_name, admin_notes, paid_at, status, phone, email')
const byId = new Map((apps || []).map((a) => [a.id as string, a]))

/** Independently derived truth: may the festival owner see this vendor at all? */
const MERGED = /\u27E6MERGED:([0-9a-fA-F-]{36})\u27E7/
function ownerMaySee(appId: string | null): boolean {
  if (!appId) return true                       // unresolved contact: never lane-gated
  let a = byId.get(appId)
  if (!a) return true
  // Follow a merge to its primary. The subordinate carries none of the payment
  // state, so judging by it says "unpaid" about a vendor who has paid.
  const m = MERGED.exec((a.admin_notes as string) || '')
  if (m) a = byId.get(m[1]) ?? a
  // Two authorised widenings, both deliberate and both re-derived here from the
  // ROW rather than trusted from the loader:
  //   unapproved applicants have no payment lane yet, so nothing to protect
  //   ⟦OWNERVIS⟧ is an explicit per-vendor hand-over
  if (a.status && a.status !== 'approved') return true
  if (/\u27E6OWNERVIS\u27E7/.test((a.admin_notes as string) || '')) return true
  return vendorInOwnerScope(a.admin_notes as string | null, a.paid_at as string | null)
}

/** Last-9 subscriber key, matching phoneKey in src/lib/inbox-lane.ts. */
const pkey = (p: string | null | undefined) => (p || '').replace(/\D/g, '').slice(-9)

/** Every vendor reachable by a given phone key / email, so a thread can be judged
 *  on the same identifiers the seal actually uses. */
const vendorsByPhone = new Map<string, string[]>()
const vendorsByEmail = new Map<string, string[]>()
for (const a of apps || []) {
  const k = pkey(a.phone as string)
  if (k) vendorsByPhone.set(k, [...(vendorsByPhone.get(k) || []), a.id as string])
  const e = ((a.email as string) || '').toLowerCase()
  if (e) vendorsByEmail.set(e, [...(vendorsByEmail.get(e) || []), a.id as string])
  // ⟦WAV…⟧ alternates are real inbound numbers for the same vendor.
  for (const m of ((a.admin_notes as string) || '').matchAll(/WAV(\d{6,})/g)) {
    const alt = pkey(m[1])
    if (alt) vendorsByPhone.set(alt, [...(vendorsByPhone.get(alt) || []), a.id as string])
  }
}

/**
 * May she reach this THREAD, judged on the identifiers THAT CHANNEL routes on?
 *
 * The two loaders deliberately differ, and flattening that difference produced
 * false failures in both directions on 2026-07-28:
 *
 *   whatsapp keys on the PHONE. Two vendor rows can share a number, and the
 *   thread cannot say which of them is writing, so if either is master-lane the
 *   whole thread is withheld. Judging it by application_id alone under-counted
 *   and reported three false over-blocks.
 *
 *   mail keys on the EMAIL (plus a resolved application id). An address
 *   identifies one vendor exactly, so a phone collision on some OTHER row is
 *   irrelevant. Applying the phone rule here over-counted and reported four
 *   false leaks.
 *
 * Judging each channel by its own routing key is not a relaxation: it is the
 * only way the expectation can be exact enough to catch a real over-block.
 */
function ownerMayReach(
  t: { application_id: string | null; phone: string | null; email: string | null },
  channel: 'whatsapp' | 'mail',
): boolean {
  const candidates = new Set<string>()
  if (t.application_id) candidates.add(t.application_id)
  if (channel === 'whatsapp') {
    for (const id of vendorsByPhone.get(pkey(t.phone)) || []) candidates.add(id)
  } else {
    for (const id of vendorsByEmail.get((t.email || '').toLowerCase()) || []) candidates.add(id)
  }
  // A bank's payment notice or the EFT admin's own alert is master-lane whoever
  // it is about (6e3a114, 2026-09-02): it has no vendor row, so without this the
  // oracle reported 14 false over-blocks.
  if (channel === 'mail' && isMasterOnlySender(t.email)) return false
  if (!candidates.size) return true            // resolves to no vendor: never lane-gated
  return [...candidates].every((id) => ownerMaySee(id))
}

let failures = 0
for (const [label, load] of [
  ['whatsapp', () => loadWhatsAppThreads(SAMREEN)],
  ['support', () => loadMailThreads(SAMREEN, 'support')],
  ['gmail', () => loadMailThreads(SAMREEN, 'gmail')],
] as const) {
  const threads = await load()
  const leaked = threads.filter((t) => !ownerMaySee(t.application_id))
  const pinned = threads.filter((t) => t.needs_response).length
  console.log(`${label.padEnd(9)} threads=${String(threads.length).padStart(4)}  pinned=${String(pinned).padStart(3)}  LEAKED=${leaked.length}`)
  for (const l of leaked.slice(0, 10)) {
    failures++
    console.log(`   LEAK ${l.id} ${l.business_name || l.peer_name || l.email || l.phone}`)
  }
}

// The other direction: the master lane must still SEE what she cannot. A seal
// that blinds everyone is not a seal, it is an outage.
// Prove the seal is not VACUOUS. "No leaks" is also what a filter that blocks
// nothing looks like. The first run of this script reported clean on all three
// channels while withholding zero rows, because the control viewer was
// taona@cthalaal.co.za, who is NOT the EFT admin (EFT_ADMIN_EMAIL is dev@) and
// is therefore lane-restricted himself. Comparing two restricted viewers proves
// nothing. The master lane must see strictly MORE, on every channel.
// CHANNEL-AWARE, AND EXACT. This used to assert `withheld > 0` on every channel,
// which is the right instinct at the wrong granularity: it cannot tell a broken
// seal from a channel that legitimately has nothing to hide. On 2026-07-28 gmail
// reported withheld=0 and FAILED, while the truth was simply that no master-lane
// vendor had a live gmail thread that day. An assertion that cries wolf gets
// relaxed, and a relaxed seal check is worth nothing.
//
// So: derive the EXPECTED withholding per channel from vendor_applications via
// ownerMaySee (independent of the loaders), then require the actual withholding
// to match it EXACTLY. That is strictly stronger than "> 0" because it also
// catches OVER-blocking, which the old check could never see, and it lets a
// channel legitimately withhold nothing without lying about it.
//
// The anti-vacuous guard survives at the level where it is actually meaningful:
// across ALL channels combined. If the scope withholds nothing ANYWHERE, it was
// never exercised and the run proves nothing.
console.log('')
let totalExpected = 0
for (const [label, kind, load] of [
  ['whatsapp', 'whatsapp', (v: string) => loadWhatsAppThreads(v)],
  ['support', 'mail', (v: string) => loadMailThreads(v, 'support')],
  ['gmail', 'mail', (v: string) => loadMailThreads(v, 'gmail')],
] as const) {
  const master = await load(MASTER)
  const owner = await load(SAMREEN)
  const ownerIds = new Set(owner.map((t) => t.id))

  const withheld = master.filter((t) => !ownerIds.has(t.id))
  // Expected withholding is judged on EVERY identifier, not just application_id.
  // The seal blocks a thread when its phone OR email OR application id resolves
  // to a vendor she may not see, because two vendor rows can share a phone and a
  // crafted request pairing a benign email with a lane vendor's number was a real
  // leak once. Judging by application_id alone reported three false over-blocks
  // on 2026-07-28 (Foodhangover, probe-rate, The creative hub): each had
  // blocksAppId=false but blocksPhone=true, so the LOADER was right and this
  // check was naive.
  const expected = master.filter((t) => !ownerMayReach(t, kind))
  const expectedIds = new Set(expected.map((t) => t.id))
  totalExpected += expected.length

  console.log(`${label.padEnd(9)} master=${String(master.length).padStart(4)}  owner=${String(owner.length).padStart(4)}  withheld=${String(withheld.length).padStart(3)}  expected=${String(expected.length).padStart(3)}`)

  if (master.length < owner.length) { failures++; console.log('   FAIL: master sees FEWER than the owner') }

  // Should have been withheld and was not: a leak.
  const leakedThrough = expected.filter((t) => ownerIds.has(t.id))
  for (const t of leakedThrough.slice(0, 5)) {
    failures++
    console.log(`   FAIL leak: ${t.business_name || t.email || t.phone} reached the owner`)
  }
  // Withheld although she was entitled to it: an over-block. Invisible to the
  // old check, and it silently shrinks her inbox.
  const overBlocked = withheld.filter((t) => !expectedIds.has(t.id))
  for (const t of overBlocked.slice(0, 5)) {
    failures++
    console.log(`   FAIL over-block: ${t.business_name || t.email || t.phone} withheld but she may see it`)
  }
  if (!expected.length) {
    console.log('   note: no master-lane vendor has a thread on this channel, so withholding nothing is correct')
  }
}
if (totalExpected === 0) {
  failures++
  console.log('\nFAIL: nothing was withheld on ANY channel, so the seal was never exercised.')
}

// A thread must appear in EXACTLY ONE mailbox. support_inbox_threads carries no
// mailbox column, so the split is derived per thread from its newest message; if
// that derivation is wrong a conversation shows up in both lists (answered twice)
// or in neither (silently lost). This is the core claim of the split, so it is
// asserted rather than assumed.
const sup = await loadMailThreads(MASTER, 'support')
const gm = await loadMailThreads(MASTER, 'gmail')
const supIds = new Set(sup.map((t) => t.id))
const both = gm.filter((t) => supIds.has(t.id))
console.log(`\nmailbox split: support=${sup.length} gmail=${gm.length} in-both=${both.length}`)
if (both.length) {
  failures++
  for (const b of both.slice(0, 5)) console.log('   IN BOTH LISTS:', b.subject || b.email)
}

console.log(failures === 0 ? '\nPASS: no master-lane vendor reached the owner on any channel.' : `\nFAIL: ${failures} problem(s).`)
process.exit(failures === 0 ? 0 : 1)
