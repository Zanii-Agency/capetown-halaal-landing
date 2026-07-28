// Runs under `node --import tsx --test src/lib/eft.test.ts`.
//
// The risk: the ⟦EFT⟧ lane marker shares admin_notes with the ⟦STALL:..⟧
// allocation marker, the ⟦PORTAL:..⟧ base64 state, and human prose. Adding or
// removing the lane marker must never touch any of them, and the PORTAL/STALL
// writers must leave ⟦EFT⟧ alone (asserted via updatePortalStateImpl).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { vendorInOwnerScope, hasEftMarker, withEftMarker, withoutEftMarker, eftReference, vendorInEftLane, vendorCommsInEftLane, hasNoEftMarker, withNoEftMarker, withoutNoEftMarker, mentionsEft, isInternalAccount, isOperatorPreviewAddress, visiblePaymentStatus, EFT_ADMIN_EMAIL } from './eft'
import { updatePortalStateImpl, parsePortalState } from './portal-state'

test('withEftMarker adds the token and is idempotent', () => {
  const once = withEftMarker('')
  assert.equal(once, '⟦EFT⟧')
  assert.equal(withEftMarker(once), '⟦EFT⟧')
  assert.ok(hasEftMarker(once))
  assert.ok(!hasEftMarker('just a note'))
})

test('adding + removing ⟦EFT⟧ preserves prose, ⟦STALL⟧ and ⟦PORTAL⟧', () => {
  // Prose + allocation + payment state all in one string.
  let notes = 'Priority vendor.\n\n⟦STALL:FS12⟧'
  notes = updatePortalStateImpl(notes, { ...parsePortalState(notes), v: 1, payment: { status: 'pending' } })
  const added = withEftMarker(notes)
  assert.ok(hasEftMarker(added))
  assert.match(added, /⟦STALL:FS12⟧/)
  assert.match(added, /Priority vendor\./)
  assert.equal(parsePortalState(added).payment?.status, 'pending')

  // A subsequent PORTAL write (unrelated mutation) must not drop ⟦EFT⟧.
  const afterPortalWrite = updatePortalStateImpl(added, { ...parsePortalState(added), v: 1, stage: 'paid' })
  assert.ok(hasEftMarker(afterPortalWrite), '⟦EFT⟧ survives a PORTAL read-modify-write')

  // Removing the lane marker leaves everything else intact.
  const removed = withoutEftMarker(afterPortalWrite)
  assert.ok(!hasEftMarker(removed))
  assert.match(removed, /⟦STALL:FS12⟧/)
  assert.match(removed, /Priority vendor\./)
  assert.equal(parsePortalState(removed).stage, 'paid')
})

test('vendorInEftLane excludes already-paid vendors even under global mode', () => {
  // Already paid via the paid_at column -> never in the lane, even marked + global.
  assert.equal(vendorInEftLane('⟦EFT⟧', true, '2026-07-23T00:00:00Z'), false)
  // Already paid via the portal marker status -> never in the lane.
  const paidNotes = updatePortalStateImpl('⟦EFT⟧', { v: 1, payment: { status: 'paid' } })
  assert.equal(vendorInEftLane(paidNotes, true), false)
  // Unpaid + individually marked -> in the lane even with global OFF.
  assert.equal(vendorInEftLane('⟦EFT⟧', false), true)
  // Unpaid + unmarked + global ON -> in the lane.
  assert.equal(vendorInEftLane('just a note', true), true)
  // Unpaid + unmarked + global OFF -> NOT in the lane.
  assert.equal(vendorInEftLane('just a note', false), false)
})

test('vendorCommsInEftLane routes by payment status: unpaid + collected -> master while global on; only truly paid -> owner', () => {
  // Individually added + unpaid -> master, regardless of global mode.
  assert.equal(vendorCommsInEftLane('⟦EFT⟧', null), true)
  assert.equal(vendorCommsInEftLane('⟦EFT⟧', null, true), true)
  // Uploaded an EFT proof + unpaid -> master regardless of global (mid-transaction).
  const submitted = updatePortalStateImpl('note', { v: 1, payment: { eft_submitted_at: '2026-07-23T00:00:00Z' } })
  assert.equal(vendorCommsInEftLane(submitted, null), true)
  assert.equal(vendorCommsInEftLane(submitted, null, false), true)
  // NEW RULE: while global EFT mode is ON, ANY unpaid non-excluded vendor -> master,
  // even with no marker/proof/reveal. Self-reverts when global is off.
  assert.equal(vendorCommsInEftLane('just a note', null, true), true)   // global on  -> master
  assert.equal(vendorCommsInEftLane('just a note', null, false), false) // global off -> owner
  // 'collected' (EFT interim, paid_at null, status !== 'paid') -> master while global on.
  const collected = updatePortalStateImpl('note', { v: 1, payment: { status: 'collected', eft_collected_at: '2026-07-25T00:00:00Z' } })
  assert.equal(vendorCommsInEftLane(collected, null, true), true)
  // A truly PAID vendor (Yoco-settled) is NEVER on the master lane.
  const paid = updatePortalStateImpl('note', { v: 1, payment: { status: 'paid' } })
  assert.equal(vendorCommsInEftLane(paid, null, true), false)
  assert.equal(vendorCommsInEftLane('⟦EFT⟧', '2026-07-23T00:00:00Z', true), false) // paid_at set -> owner
  // ⟦NOEFT⟧ + internal accounts are explicit exclusions even under global mode.
  assert.equal(vendorCommsInEftLane(withNoEftMarker('just a note'), null, true), false)
  assert.equal(vendorCommsInEftLane('⟦NOEFT⟧', null, true), false)
  assert.equal(vendorCommsInEftLane('just a note', null, true, { email: 'samreenkumandan1@gmail.com' }), false)
})

test('⟦NOEFT⟧ exclusion overrides global mode AND ⟦EFT⟧ in both predicates', () => {
  // Excluding a vendor strips any ⟦EFT⟧ and adds ⟦NOEFT⟧ (the two never coexist).
  const ex = withNoEftMarker('⟦EFT⟧')
  assert.ok(hasNoEftMarker(ex))
  assert.ok(!hasEftMarker(ex))
  // Excluded: never in the payment lane (even global ON) or the comms lane.
  assert.equal(vendorInEftLane(ex, true, null), false)
  assert.equal(vendorCommsInEftLane(ex, null), false)
  // Un-exclude lifts it; preserves prose + ⟦STALL⟧.
  assert.ok(!hasNoEftMarker(withoutNoEftMarker(ex)))
  const keep = withNoEftMarker('Priority.\n\n⟦STALL:FS1⟧')
  assert.match(keep, /⟦STALL:FS1⟧/)
  assert.match(keep, /Priority\./)
})

test('internal/operator accounts are never in either lane, even under global mode', () => {
  // Matched by identity: samreenkumandan* email, GLOBAL CUISINE email/phone, capetownhalaal@.
  assert.ok(isInternalAccount('samreenkumandan1@gmail.com', null))
  assert.ok(isInternalAccount('SamreenKumandan99@outlook.com', null)) // substring, case-insensitive
  assert.ok(isInternalAccount('sales@globalcuisine.co.za', null))
  assert.ok(isInternalAccount('capetownhalaal@gmail.com', null))
  assert.ok(isInternalAccount(null, '+27 72 380 3393')) // last-9 match, any formatting
  assert.ok(isInternalAccount(null, '0723803393'))
  // Real vendors do NOT match.
  assert.ok(!isInternalAccount('chef@realvendor.co.za', '+27821234567'))
  assert.ok(!isInternalAccount(null, null))
  // Global mode would normally sweep an unmarked unpaid vendor into the payment
  // lane; an internal identity blocks it in BOTH predicates.
  const identity = { email: 'samreenkumandan1@gmail.com', phone: null }
  assert.equal(vendorInEftLane('just a note', true, null, identity), false)
  assert.equal(vendorCommsInEftLane('⟦EFT⟧', null, true, identity), false) // even an explicit ⟦EFT⟧ marker
  // Without identity, behaviour is unchanged (backward-compatible).
  assert.equal(vendorInEftLane('just a note', true, null), true)
})

test('isOperatorPreviewAddress matches the operator preview inbox (case-insensitive)', () => {
  assert.ok(isOperatorPreviewAddress('taonac96@gmail.com'))
  assert.ok(isOperatorPreviewAddress('TaonaC96@Gmail.com'))
  assert.ok(!isOperatorPreviewAddress('nazleyparker3@gmail.com'))
  assert.ok(!isOperatorPreviewAddress(null))
})

test('mentionsEft fires on EFT replies, not on unrelated ones', () => {
  assert.ok(mentionsEft('You can pay by EFT, upload your proof of payment in the portal.'))
  assert.ok(mentionsEft('Please do a bank transfer to the account on your portal.'))
  assert.ok(mentionsEft('Send us your proof of payment once done.'))
  // Not a payment reply -> must NOT sweep the vendor onto the lane.
  assert.ok(!mentionsEft('Thanks for your halaal certificate, we have added it.'))
  assert.ok(!mentionsEft('Your stall is allocated, see you at the festival.'))
  assert.ok(!mentionsEft(''))
  assert.ok(!mentionsEft(null))
})

test('eftReference prefers the allocated stall, else a stable short code', () => {
  assert.equal(eftReference({ id: 'x', admin_notes: '⟦STALL:FT03⟧' }), 'FT03')
  // id -> strip dashes -> last 6 -> upper: ...ef1234567890 => "567890"
  assert.equal(eftReference({ id: 'abcdef12-3456-7890-abcd-ef1234567890', admin_notes: '' }), 'CTH567890')
})

// --- visiblePaymentStatus: the owner must never learn a vendor is 'collected' ---
// Taona 2026-07-25: "once I click mark collected, everything for the vendor
// should be normal, only Samreen doesn't know and never will know till we do
// Yoco settlement."
test('visiblePaymentStatus: collected reads as none for the owner, real for the EFT admin', () => {
  assert.equal(visiblePaymentStatus('collected', 'samreen@youngatheart.co.za'), 'none')
  assert.equal(visiblePaymentStatus('collected', null), 'none')
  assert.equal(visiblePaymentStatus('collected', undefined), 'none')
  assert.equal(visiblePaymentStatus('collected', EFT_ADMIN_EMAIL), 'collected')
  assert.equal(visiblePaymentStatus('collected', EFT_ADMIN_EMAIL.toUpperCase()), 'collected')
})

test('visiblePaymentStatus: never hides real revenue or alters any other state', () => {
  // A settled payment must ALWAYS show to the owner, or money goes missing from
  // her finance view. Only the interim EFT state is masked.
  for (const email of ['samreen@youngatheart.co.za', null, EFT_ADMIN_EMAIL]) {
    assert.equal(visiblePaymentStatus('paid', email), 'paid')
    assert.equal(visiblePaymentStatus('waived', email), 'waived')
    assert.equal(visiblePaymentStatus('pending', email), 'pending')
    assert.equal(visiblePaymentStatus('deferred', email), 'deferred')
    assert.equal(visiblePaymentStatus('none', email), 'none')
    assert.equal(visiblePaymentStatus(undefined, email), 'none')
    assert.equal(visiblePaymentStatus(null, email), 'none')
  }
})

test('vendorInOwnerScope: the festival owner only ever sees vendors who paid through HER channels', () => {
  const paidVia = (method: string) => updatePortalStateImpl('note', { v: 1, payment: { status: 'paid', method } as never })
  // Yoco, cash and waived are hers.
  assert.equal(vendorInOwnerScope(paidVia('yoco'), null), true)
  assert.equal(vendorInOwnerScope(paidVia('cash'), null), true)
  assert.equal(vendorInOwnerScope(paidVia('waived'), null), true)
  // EFT and manual card are the master's, even once SETTLED. This is the case
  // vendorCommsInEftLane got wrong: paid_at alone used to hand them back to her.
  assert.equal(vendorInOwnerScope(paidVia('eft'), '2026-07-19T00:00:00Z'), false)
  assert.equal(vendorInOwnerScope(paidVia('manual_card'), '2026-07-19T00:00:00Z'), false)
  // Legacy paid vendors carry no method (20 of 47 live rows) — they must NOT be
  // blanked out of her world, which is why the rule is a denylist.
  assert.equal(vendorInOwnerScope(updatePortalStateImpl('note', { v: 1, payment: { status: 'paid' } }), null), true)
  assert.equal(vendorInOwnerScope('just a note', '2026-07-19T00:00:00Z'), true)
})

test('vendorInOwnerScope: every unpaid state is outside her world', () => {
  assert.equal(vendorInOwnerScope('just a note', null), false, 'plain unpaid')
  assert.equal(vendorInOwnerScope('⟦EFT⟧', null), false, 'on the EFT lane')
  // ⟦NOEFT⟧ deliberately NOT asserted here any more. 2026-07-26 it handed an
  // unpaid vendor to the master ("excluded from EFT is not the same as paid").
  // 2026-07-28 Taona reversed it: "If excluded on master lane, it belongs to
  // samreen." The master lane hides an EFT arrangement and an excluded vendor
  // has none. Covered by its own tests below, including the guard that keeps an
  // EFT-touched vendor on the master lane regardless of the marker.
  // 'collected' is the EFT interim state and never sets paid_at: still not hers.
  const collected = updatePortalStateImpl('note', { v: 1, payment: { status: 'collected' } })
  assert.equal(vendorInOwnerScope(collected, null), false)
  assert.equal(vendorInOwnerScope(null, null), false)
})

// ---------------------------------------------------------------------------
// ⟦NOEFT⟧ hands the vendor to the festival owner — Taona 2026-07-28: "If
// excluded on master lane, it belongs to samreen." The master lane hides an EFT
// ARRANGEMENT; a vendor excluded from EFT has none.
// ---------------------------------------------------------------------------

test('an excluded, unpaid vendor who never touched EFT is HERS', () => {
  // Telkom, Treacle and Tart, Islamic Relief SA, Call-A-Braai on 2026-07-28.
  assert.equal(vendorInOwnerScope(withNoEftMarker('note')), true)
})

test('exclusion does NOT expose a vendor already collected via EFT', () => {
  // The marker says what happens next, not what already happened. Y&K gifts and
  // toys sat at 'collected' the day this rule was written; handing that over
  // would leak the settlement the wall exists to hide.
  const collected = withNoEftMarker(
    updatePortalStateImpl('note', { v: 1, payment: { status: 'collected' } }))
  assert.equal(vendorInOwnerScope(collected), false)
})

test('exclusion does NOT expose a vendor who saw the bank details or sent proof', () => {
  const revealed = withNoEftMarker(
    updatePortalStateImpl('note', { v: 1, payment: { eft_revealed_at: '2026-07-27T11:27:22Z' } }))
  assert.equal(vendorInOwnerScope(revealed), false, 'revealed the details')

  const submitted = withNoEftMarker(
    updatePortalStateImpl('note', { v: 1, payment: { eft_submitted_at: '2026-07-27T21:32:00Z' } }))
  assert.equal(vendorInOwnerScope(submitted), false, 'uploaded proof')
})

test('exclusion does NOT expose a vendor settled by EFT or manual card', () => {
  for (const method of ['eft', 'manual_card']) {
    const paid = withNoEftMarker(
      updatePortalStateImpl('note', { v: 1, payment: { status: 'paid', method } as never }))
    assert.equal(vendorInOwnerScope(paid, '2026-07-19T00:00:00Z'), false, method)
  }
})

test('exclusion never puts a vendor back INTO the EFT lane', () => {
  // Both walls must agree: excluded means she can see them AND they see no bank
  // details, even with global mode on.
  const n = withNoEftMarker('note')
  assert.equal(vendorInOwnerScope(n), true, 'visible to her')
  assert.equal(vendorInEftLane(n, true), false, 'still no bank details')
})

// ---------------------------------------------------------------------------
// The vendor PROFILE payment state. Taona 2026-07-28, on seeing Y&K read
// "Payment pending" directly above "R4 800 collected": "for dev@cthalaal.co.za
// this is correct, for samreen it shouldnt be."
// ---------------------------------------------------------------------------

test('visiblePaymentStatus: only the EFT admin sees a collected payment', () => {
  assert.equal(visiblePaymentStatus('collected', EFT_ADMIN_EMAIL), 'collected', 'master sees the truth')
  assert.equal(visiblePaymentStatus('collected', 'capetownhalaal@gmail.com'), 'none', 'owner must not')
  assert.equal(visiblePaymentStatus('collected', null), 'none', 'unknown viewer must not')
})

test('visiblePaymentStatus leaves every other state untouched for everyone', () => {
  // Masking must be surgical: hiding 'paid' from her would break her own view of
  // the vendors she settled.
  for (const s of ['paid', 'waived', 'pending', 'none', 'deferred']) {
    assert.equal(visiblePaymentStatus(s, 'capetownhalaal@gmail.com'), s, s)
    assert.equal(visiblePaymentStatus(s, EFT_ADMIN_EMAIL), s, s)
  }
})
