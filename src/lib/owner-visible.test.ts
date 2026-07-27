import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vendorInOwnerScope, withOwnerVisibleMarker, withoutOwnerVisibleMarker, isOwnerVisible } from '@/lib/eft'

test('an unpaid vendor is invisible to the owner by default', () => {
  assert.equal(vendorInOwnerScope('', null), false)
})

test('the marker hands an UNPAID vendor to her, which is its whole purpose', () => {
  // The 10 extension requesters: unpaid, and hers to negotiate with.
  assert.equal(vendorInOwnerScope(withOwnerVisibleMarker(''), null), true)
})

test('removing it puts the vendor straight back behind the wall', () => {
  const on = withOwnerVisibleMarker('⟦EFT⟧')
  assert.equal(vendorInOwnerScope(on, null), true)
  assert.equal(vendorInOwnerScope(withoutOwnerVisibleMarker(on), null), false)
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
