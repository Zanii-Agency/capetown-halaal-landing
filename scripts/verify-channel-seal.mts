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

const SAMREEN = 'capetownhalaal@gmail.com'
const MASTER = 'dev@cthalaal.co.za'  // EFT_ADMIN_EMAIL. NOT taona@, who is lane-restricted himself.

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const { data: apps } = await db.from('vendor_applications').select('id, business_name, admin_notes, paid_at, status')
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
console.log('')
for (const [label, load] of [
  ['whatsapp', (v: string) => loadWhatsAppThreads(v)],
  ['support', (v: string) => loadMailThreads(v, 'support')],
  ['gmail', (v: string) => loadMailThreads(v, 'gmail')],
] as const) {
  const master = await load(MASTER)
  const owner = await load(SAMREEN)
  const ownerIds = new Set(owner.map((t) => t.id))
  const withheld = master.filter((t) => !ownerIds.has(t.id)).length
  console.log(`${label.padEnd(9)} master=${String(master.length).padStart(4)}  owner=${String(owner.length).padStart(4)}  withheld=${withheld}`)
  if (master.length < owner.length) { failures++; console.log('   FAIL: master sees FEWER than the owner') }
  if (withheld === 0) { failures++; console.log('   FAIL: the seal withheld nothing here, so it was never exercised') }
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
