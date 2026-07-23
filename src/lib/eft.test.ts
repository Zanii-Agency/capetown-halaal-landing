// Runs under `node --import tsx --test src/lib/eft.test.ts`.
//
// The risk: the ⟦EFT⟧ lane marker shares admin_notes with the ⟦STALL:..⟧
// allocation marker, the ⟦PORTAL:..⟧ base64 state, and human prose. Adding or
// removing the lane marker must never touch any of them, and the PORTAL/STALL
// writers must leave ⟦EFT⟧ alone (asserted via updatePortalStateImpl).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hasEftMarker, withEftMarker, withoutEftMarker, eftReference, vendorInEftLane } from './eft'
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

test('eftReference prefers the allocated stall, else a stable short code', () => {
  assert.equal(eftReference({ id: 'x', admin_notes: '⟦STALL:FT03⟧' }), 'FT03')
  // id -> strip dashes -> last 6 -> upper: ...ef1234567890 => "567890"
  assert.equal(eftReference({ id: 'abcdef12-3456-7890-abcd-ef1234567890', admin_notes: '' }), 'CTH567890')
})
