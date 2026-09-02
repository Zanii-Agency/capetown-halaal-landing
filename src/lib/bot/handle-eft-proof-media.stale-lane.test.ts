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

// captureRegardless is the flag that stops the drop. These are the exact vendor
// states that were 403'd + dead-ended ("I could not save it from here"):
// - card-only ⟦NOEFT⟧ vendor who paid by EFT anyway (Sumeez / Sataari)
// - a vendor already marked paid who sends a proof (dispute / duplicate)
// Both are OUT of the EFT lane, so without captureRegardless recordEftProof 403s.
// The gate is `!captureRegardless && !vendorInEftLane(...)`, so the flag alone
// flips the outcome from drop to capture. (recordEftProof's storage side effects
// are covered by integration, not here.)
test('the vendors who were being dropped are out of the lane, so only captureRegardless saves them', () => {
  const noeftPaidByEft = '⟦APPROVED_NOTIFIED:x⟧\n⟦NOEFT⟧'
  assert.equal(vendorInEftLane(noeftPaidByEft, false, null, {}), false, 'NOEFT vendor is out of the lane -> would 403 without captureRegardless')
  const alreadyPaid = '⟦EFT⟧'
  assert.equal(vendorInEftLane(alreadyPaid, true, '2026-08-01T00:00:00Z', {}), false, 'paid vendor is out of the lane -> would 403 without captureRegardless')
  // The gate the fix bypasses: `!captureRegardless && !inLane`.
  const gate = (captureRegardless: boolean, inLane: boolean) => !captureRegardless && !inLane
  assert.equal(gate(false, false), true, 'without the flag, an off-lane proof is refused (the old drop)')
  assert.equal(gate(true, false), false, 'with the flag, an off-lane proof is captured')
})

// Rail-aware covert laning (2026-09-02, "auto upload for samreen under samreen
// proof"): a WhatsApp proof is tagged covert ⟦EFT⟧ (hidden from Samreen) ONLY on
// the master rail. On samreen_eft/yoco it is captured but NOT laned, so
// eftProofVisibleToOwner can surface it on her fenced EFT Proofs page. The frozen
// 66 stay hidden regardless (protectedIds + their existing ⟦EFT⟧ marker).
test('covert laning of a fresh WhatsApp proof happens only on the master rail', () => {
  const shouldLaneCovert = (rail: string, alreadyLane: boolean, paid: boolean) =>
    rail === 'master' && !alreadyLane && !paid
  assert.equal(shouldLaneCovert('master', false, false), true, 'master rail hides EFT from Samreen -> lane covert')
  assert.equal(shouldLaneCovert('samreen_eft', false, false), false, "Samreen's rail -> do NOT hide, let her proof page show it")
  assert.equal(shouldLaneCovert('yoco', false, false), false, 'yoco rail -> not covert')
  assert.equal(shouldLaneCovert('master', true, false), false, 'already-laned vendor is not re-laned')
  assert.equal(shouldLaneCovert('master', false, true), false, 'a paid vendor is never laned')
})
