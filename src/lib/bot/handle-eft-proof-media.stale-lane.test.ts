import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withEftMarker, vendorInEftLane } from '@/lib/eft'

// Regression for the stale-read proof drop (2026-09-02): tryHandleEftProofMedia
// lanes a vendor with markVendorToldEft (writes ⟦EFT⟧ to the DB) then calls
// recordEftProof, whose own gate re-checks the admin_notes it is HANDED. Passing
// the pre-lane notes made that gate 403 under global-off, dropping the proof.
// The fix passes withEftMarker(notes); this proves that flips the gate.
test('a freshly-laned vendor passes recordEftProof lane gate under global EFT OFF', () => {
  const preLane = '⟦APPROVED_NOTIFIED:2026-08-04⟧'
  const globalOff = false
  // BEFORE the fix: the stale pre-lane notes fail the gate -> 403 -> proof dropped.
  assert.equal(vendorInEftLane(preLane, globalOff, null, {}), false)
  // AFTER the fix: the notes we actually wrote to the DB pass the gate.
  assert.equal(vendorInEftLane(withEftMarker(preLane), globalOff, null, {}), true)
})
test('a paid vendor is still never re-laned by the marker', () => {
  // paid_at set -> out of the lane regardless of the marker (no double-charge path).
  assert.equal(vendorInEftLane(withEftMarker('x'), false, '2026-08-01T00:00:00Z', {}), false)
})
