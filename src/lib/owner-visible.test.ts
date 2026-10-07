import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vendorInOwnerScope, withOwnerVisibleMarker, withoutOwnerVisibleMarker, isOwnerVisible } from '@/lib/eft'
import { updatePortalStateImpl } from '@/lib/portal-state'

test('a clean unpaid vendor is visible to the owner by default (2026-09-11 rule)', () => {
  // New rule: a merely-unpaid vendor with no EFT trace is HERS; only real master
  // money hides. Taona 2026-09-24: a BARE ⟦EFT⟧ marker (no master money) no longer
  // hides either — it pins which bank details they SEE, not whether she can SEE them.
  assert.equal(vendorInOwnerScope('', null), true)
  assert.equal(vendorInOwnerScope('⟦EFT⟧', null), true, 'bare ⟦EFT⟧, no master money -> hers now (2026-09-24)')
})

test('the marker hands an UNPAID vendor to her, which is its whole purpose', () => {
  // The 10 extension requesters: unpaid, and hers to negotiate with.
  assert.equal(vendorInOwnerScope(withOwnerVisibleMarker(''), null), true)
})

test('a real master-EFT trace overrides the OWNERVIS hand-over', () => {
  // The OWNERVIS hand-over is GUARDED against money in motion: a vendor with a real
  // master-EFT trace (here a collected interim payment) is NOT handed over, because
  // exposing an unsettled master collection is the breach this wall prevents.
  const collectedNote = updatePortalStateImpl('note', { v: 1, payment: { status: 'collected' } })
  assert.equal(vendorInOwnerScope(withOwnerVisibleMarker(collectedNote), null), false, 'collected stays hidden even with OWNERVIS')
})

test('removing OWNERVIS from a clean unpaid vendor leaves them visible (2026-09-24)', () => {
  // OWNERVIS hands a clean unpaid vendor to her. Removing it used to plunge them
  // back behind the wall; under the 2026-09-24 rule a clean unpaid vendor (no real
  // master money) is visible anyway, so they STAY visible. The marker no longer
  // re-hides them. (Real master money is covered by the guard test above.)
  const on = withOwnerVisibleMarker('⟦EFT⟧')
  assert.equal(vendorInOwnerScope(on, null), true)
  assert.equal(vendorInOwnerScope(withoutOwnerVisibleMarker(on), null), true)
})

test('it never eats the other markers sharing admin_notes', () => {
  const notes = withOwnerVisibleMarker('⟦EFT⟧ ⟦STALL:F12⟧ ⟦WAV27821234567⟧')
  for (const m of ['⟦EFT⟧', '⟦STALL:F12⟧', '⟦WAV27821234567⟧']) assert.ok(notes.includes(m), m)
  assert.ok(!withoutOwnerVisibleMarker(notes).includes('OWNERVIS'))
  assert.ok(withoutOwnerVisibleMarker(notes).includes('⟦STALL:F12⟧'))
})

test('applying it twice does not duplicate it', () => {
  const once = withOwnerVisibleMarker('')
  assert.equal(withOwnerVisibleMarker(once), once)
})

test('isOwnerVisible reports the state', () => {
  assert.equal(isOwnerVisible('⟦EFT⟧'), false)
  assert.equal(isOwnerVisible(withOwnerVisibleMarker('⟦EFT⟧')), true)
})
