/**
 * EFT reconciliation sweep. READ ONLY — writes nothing.
 *
 *   npx tsx --env-file=.env.local scripts/eft-reconcile-sweep.mts
 *
 * Two questions, after Y&K gifts and toys turned up having paid by EFT while the
 * system still showed them owing (2026-07-28):
 *
 *   A. Who else revealed the bank details and has no recorded payment? Each one
 *      is a vendor who may have paid into the account with nothing on file, and
 *      who is still being sent weekly overdue chasers.
 *
 *   B. Is the ⟦NOEFT⟧ exclusion actually EFFECTIVE? The marker is meant to beat
 *      global EFT mode. This runs the REAL predicate the portal payments page
 *      calls (vendorInEftLane) rather than re-reading the rule, because a wall
 *      that is only correct in my reading of it is not verified.
 */

import { createAdminClient } from '../src/lib/supabase/admin'
import { parsePortalState } from '../src/lib/portal-state'
import { vendorInEftLane, vendorInOwnerScope, hasNoEftMarker, hasEftMarker, getEftMode, eftReference } from '../src/lib/eft'

const db = createAdminClient()
const sast = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' }) : '—'

const rows: Array<Record<string, unknown>> = []
for (let page = 0; page < 10; page++) {
  const { data, error } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, status, paid_at, admin_notes')
    .order('id', { ascending: true })
    .range(page * 1000, page * 1000 + 999)
  if (error) { console.error('query failed:', error.message); process.exit(1) }
  if (!data || !data.length) break
  rows.push(...data)
  if (data.length < 1000) break
}

const globalOn = await getEftMode()
console.log(`scanned ${rows.length} vendor rows · global EFT mode is ${globalOn ? 'ON' : 'OFF'}\n`)

type V = { id: string; business_name: string | null; contact_name: string | null; email: string | null; phone: string | null; status: string | null; paid_at: string | null; admin_notes: string | null }

// ---------------------------------------------------------------------------
// A. Revealed the bank details, nothing recorded against them.
// ---------------------------------------------------------------------------
const unrecorded: Array<{ v: V; revealed: string; submitted?: string }> = []
for (const r of rows as V[]) {
  const p = parsePortalState(r.admin_notes || '').payment
  const revealed = p?.eft_revealed_at
  if (!revealed) continue
  const recorded = !!r.paid_at || p?.status === 'paid' || p?.status === 'collected'
  if (!recorded) unrecorded.push({ v: r, revealed, submitted: p?.eft_submitted_at })
}
unrecorded.sort((a, b) => a.revealed.localeCompare(b.revealed))

console.log('='.repeat(74))
console.log(`A. REVEALED THE BANK DETAILS, NO PAYMENT RECORDED — ${unrecorded.length} vendor(s)`)
console.log('='.repeat(74))
if (!unrecorded.length) console.log('  none.')
for (const { v, revealed, submitted } of unrecorded) {
  console.log(`\n  ${v.business_name || v.email}   ref ${eftReference(v)}`)
  console.log(`     contact  : ${v.contact_name || '—'}  ${v.phone || 'no phone'}  ${v.email || ''}`)
  console.log(`     revealed : ${sast(revealed)}`)
  console.log(`     proof    : ${submitted ? sast(submitted) + '  <-- uploaded proof, still unrecorded' : 'never uploaded'}`)
  console.log(`     status   : ${v.status}  ·  NOEFT=${hasNoEftMarker(v.admin_notes)}  EFT=${hasEftMarker(v.admin_notes)}`)
  console.log(`     id       : ${v.id}`)
}

// ---------------------------------------------------------------------------
// B. Is the exclusion real? Run the predicate the portal actually calls.
// ---------------------------------------------------------------------------
const excluded = (rows as V[]).filter((r) => hasNoEftMarker(r.admin_notes))
const leaks: V[] = []
const revealedWhileExcluded: Array<{ v: V; revealed: string }> = []
for (const r of excluded) {
  const inLane = vendorInEftLane(r.admin_notes, globalOn, r.paid_at, { email: r.email, phone: r.phone })
  if (inLane) leaks.push(r)
  const revealed = parsePortalState(r.admin_notes || '').payment?.eft_revealed_at
  if (revealed) revealedWhileExcluded.push({ v: r, revealed })
}

console.log(`\n${'='.repeat(74)}`)
console.log(`B. ⟦NOEFT⟧ EXCLUSIONS — ${excluded.length} vendor(s) marked excluded`)
console.log('='.repeat(74))
console.log(`  still returned as IN the EFT lane by vendorInEftLane(): ${leaks.length}`)
for (const v of leaks) console.log(`     LEAK: ${v.business_name || v.email}  (${v.id})`)
if (!leaks.length) console.log('     none — the exclusion holds for every excluded vendor.')

console.log(`\n  excluded vendors who HAD already revealed the bank details: ${revealedWhileExcluded.length}`)
for (const { v, revealed } of revealedWhileExcluded) {
  const p = parsePortalState(v.admin_notes || '').payment
  const recorded = !!v.paid_at || p?.status === 'paid' || p?.status === 'collected'
  console.log(`     ${v.business_name || v.email}  revealed ${sast(revealed)}  recorded=${recorded ? 'yes' : 'NO'}`)
}
if (!revealedWhileExcluded.length) console.log('     none.')

// ---------------------------------------------------------------------------
// C. Who can ACTUALLY see the bank details.
//
// The denominator is NOT vendor_applications. A portal account is only created
// on approval (provisionExhibitorAccount, called from the approve path in
// applications/decision-notify.ts), so an unapproved applicant cannot log in and
// can never reach the payments page that renders EftPanel. Counting the whole
// table through vendorInEftLane() answers "who would the predicate include",
// which is not the same question and inflates the number roughly four-fold.
// ---------------------------------------------------------------------------
const byStatus = new Map<string, number>()
for (const r of rows as V[]) byStatus.set(r.status || 'null', (byStatus.get(r.status || 'null') || 0) + 1)

const approved = (rows as V[]).filter((r) => r.status === 'approved')
const settled = approved.filter((r) => {
  const p = parsePortalState(r.admin_notes || '').payment
  return !!r.paid_at || p?.status === 'paid' || p?.status === 'collected'
})
const approvedUnpaid = approved.filter((r) => !settled.includes(r))
const exposed = approvedUnpaid.filter((r) =>
  vendorInEftLane(r.admin_notes, globalOn, r.paid_at, { email: r.email, phone: r.phone }))
const shielded = approvedUnpaid.filter((r) => !exposed.includes(r))

console.log(`\n${'='.repeat(74)}`)
console.log('C. WHO CAN ACTUALLY SEE THE BANK DETAILS')
console.log('='.repeat(74))
console.log('  application status breakdown:')
for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`     ${s.padEnd(16)} ${n}`)
}
console.log(`\n  approved (have a portal login) : ${approved.length}`)
console.log(`  of those, already settled      : ${settled.length}   (paid_at, or status paid/collected)`)
console.log(`  approved AND unpaid            : ${approvedUnpaid.length}`)
console.log(`  -> REALLY SEEING BANK DETAILS  : ${exposed.length}`)
console.log(`  -> shielded (excluded/internal): ${shielded.length}`)
console.log(`\n  global mode is ${globalOn ? 'ON' : 'OFF'}`)

const paidStillInLane = (rows as V[]).filter((r) =>
  r.paid_at && vendorInEftLane(r.admin_notes, globalOn, r.paid_at, { email: r.email, phone: r.phone }))
console.log(`  already paid but still in lane : ${paidStillInLane.length} (should be 0)`)
for (const v of paidStillInLane) console.log(`     ${v.business_name} (${v.id})`)

// ---------------------------------------------------------------------------
// D. The excluded, checked on BOTH walls.
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(74)}`)
console.log('D. THE EXCLUDED — checked on both walls')
console.log('='.repeat(74))
for (const r of excluded) {
  const seesEft = vendorInEftLane(r.admin_notes, globalOn, r.paid_at, { email: r.email, phone: r.phone })
  const hers = vendorInOwnerScope(r.admin_notes, r.paid_at)
  const p = parsePortalState(r.admin_notes || '').payment
  const flag = seesEft ? '  <-- STILL SEES EFT' : ''
  console.log(`  ${(r.business_name || r.email || r.id).slice(0, 38).padEnd(40)} approved=${String(r.status === 'approved').padEnd(5)} seesEFT=${String(seesEft).padEnd(5)} lane=${hers ? 'SAMREEN' : 'master'}  pay=${p?.status || 'none'}${flag}`)
}
