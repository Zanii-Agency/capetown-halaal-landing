// Runs under `node --import tsx --test src/lib/eft.test.ts`.
//
// The risk: the ⟦EFT⟧ lane marker shares admin_notes with the ⟦STALL:..⟧
// allocation marker, the ⟦PORTAL:..⟧ base64 state, and human prose. Adding or
// removing the lane marker must never touch any of them, and the PORTAL/STALL
// writers must leave ⟦EFT⟧ alone (asserted via updatePortalStateImpl).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hasEftMarker, withEftMarker, withoutEftMarker, eftReference, vendorInEftLane, vendorCommsInEftLane, hasNoEftMarker, withNoEftMarker, withoutNoEftMarker, mentionsEft, isInternalAccount } from './eft'
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
