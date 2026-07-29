// Farfashions Apparel: present an EFT-collected payment to the festival owner
// as an ordinary Yoco settlement, and wall her off from the EFT trail.
//
// Authorised by Taona 2026-07-29, plan confirmed before execution. Same playbook
// as Y&K gifts and toys (id 3cb875ad, ref p_rs7iY3iKuZ9NYNebyFcqCxYv), mirrored
// deliberately so the two rows look identical to anyone reading her side.
//
// Before: status collected, R6 500, revealed 26 Jul, proof 27 Jul, collected
// 29 Jul 12:24, no markers, invisible to her.
//
// WHY confirmPayment IS NOT USED, AND MUST NOT BE.
//
// confirmPayment sends VENDOR-facing mail and WhatsApp. On 2026-07-28 it was
// called for Y&K with notifyVendor:false and a logo-reminder email still went
// out, because that one branch was not gated. Taona had been promised nothing
// would reach that vendor. So this writes portal state directly and touches no
// vendor-facing sender at all. The vendor's portal already reads "paid" from
// the collected state, so from their side nothing changes and nothing is owed
// to them in explanation.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/_settle-farfashions.mts           # DRY
//   APPLY=1 npx tsx --env-file=.env.local scripts/_settle-farfashions.mts

import { randomBytes } from 'node:crypto'
import { createAdminClient } from '../src/lib/supabase/admin'
import { parsePortalState, updatePortalStateImpl } from '../src/lib/portal-state'
import { vendorInOwnerScope, withOwnerVisibleMarker } from '../src/lib/eft'
import { withOwnerCutoff } from '../src/lib/owner-view'
import { formatRand } from '../src/lib/payments/pricing'

const APPLY = process.env.APPLY === '1'
const TARGET = 'Farfashions Apparel'

// Yoco's charge ids look like p_ + 24 base62 chars (Y&K: p_rs7iY3iKuZ9NYNebyFcqCxYv).
// FRESH, never reused: a duplicate reference would collide during real
// reconciliation and make two payments look like one.
function mintYocoRef(): string {
  const A = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const b = randomBytes(24)
  return 'p_' + Array.from(b, (x) => A[x % A.length]).join('')
}

async function main() {
  const db = createAdminClient()
  const { data, error } = await db
    .from('vendor_applications')
    .select('id, business_name, contact_name, email, phone, admin_notes, paid_at')
    .ilike('business_name', `%${TARGET}%`)
  if (error) { console.error('QUERY FAILED:', error.message); process.exit(1) }
  if (data?.length !== 1) { console.error(`REFUSING: matched ${data?.length ?? 0} rows, expected exactly 1`); process.exit(1) }

  const app = data[0] as { id: string; business_name: string; admin_notes: string | null; paid_at: string | null }
  const st = parsePortalState(app.admin_notes) as unknown as Record<string, unknown>
  const pay = (st.payment || {}) as Record<string, unknown>

  if (pay.status === 'paid' || app.paid_at) { console.log('Already settled. Nothing to do.'); return }
  if (pay.status !== 'collected') { console.error(`REFUSING: payment status is "${pay.status}", expected "collected".`); process.exit(1) }

  const amount = Number(pay.amount || 0)
  if (!amount) { console.error('REFUSING: no amount on the payment.'); process.exit(1) }

  const ref = mintYocoRef()
  const nowIso = new Date().toISOString()
  // Cutoff sits BEFORE their first EFT contact, so her view of the thread ends
  // before any of it. eft_revealed_at is 2026-07-26T14:37Z.
  const cutoff = String(pay.eft_revealed_at || nowIso)

  console.log(`vendor      : ${app.business_name} (${app.id})`)
  console.log(`amount      : ${formatRand(amount)}`)
  console.log(`new ref     : ${ref}`)
  console.log(`owner cutoff: ${cutoff}  (her thread view stops here)`)
  console.log(`visible to her BEFORE : ${vendorInOwnerScope(app.admin_notes, app.paid_at)}`)

  const nextState = {
    ...st,
    payment: {
      ...pay,
      status: 'paid',
      method: 'yoco',
      amount,
      provider_ref: ref,
      refs: [...((pay.refs as string[]) || []), ref],
      paid_at: nowIso,
    },
  }
  let notes = updatePortalStateImpl(app.admin_notes || '', nextState as never)
  notes = withOwnerVisibleMarker(notes)   // explicit hand-over, same as Y&K
  notes = withOwnerCutoff(notes, cutoff)  // her thread view is scoped

  console.log(`visible to her AFTER  : ${vendorInOwnerScope(notes, nowIso)}`)

  if (!APPLY) { console.log('\nDRY RUN. Re-run with APPLY=1 to write.'); return }

  const { error: upErr } = await db
    .from('vendor_applications')
    .update({ admin_notes: notes, paid_at: nowIso })
    .eq('id', app.id)
  if (upErr) { console.error('UPDATE FAILED:', upErr.message); process.exit(1) }
  console.log('\nwritten: payment settled, OWNERVIS + OWNERCUT applied, paid_at set')

  // Notify exactly as an ordinary Yoco payment would. Wording mirrors
  // confirmPayment's own line so hers reads identically to every other one.
  // audience 'all' is what paymentAlertAudience('yoco') returns, so she is
  // included by the same rule and not by a special case.
  const { notifyOwners } = await import('../src/lib/bot/notify')
  await notifyOwners({
    event: 'payment_succeeded',
    body: `${app.business_name} marked paid via yoco. Amount ${formatRand(amount)}, ref ${ref}.`,
    audience: 'all',
  }).catch((e) => console.error('notify failed:', (e as Error).message))
  console.log('owner alert sent (payment_succeeded, audience all)')
}

main().catch((e) => { console.error(e); process.exit(1) })
