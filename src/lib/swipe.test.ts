import { test } from 'node:test'
import assert from 'node:assert/strict'
import { swipeProgress, isConfirmed, CONFIRM_AT } from './swipe'

test('progress is the fraction of travel covered', () => {
  assert.equal(swipeProgress(0, 100), 0)
  assert.equal(swipeProgress(50, 100), 0.5)
  assert.equal(swipeProgress(100, 100), 1)
})

test('progress clamps, so the handle can never paint outside its track', () => {
  assert.equal(swipeProgress(-40, 100), 0, 'dragging backwards pins at the start')
  assert.equal(swipeProgress(999, 100), 1, 'overshooting pins at the end')
})

test('garbage input yields 0, never a confirmed swipe', () => {
  // A ref read before layout returns width 0. Dividing by it would put
  // "Infinity%" or "NaN%" straight into a style attribute.
  assert.equal(swipeProgress(50, 0), 0)
  assert.equal(swipeProgress(50, -10), 0)
  assert.equal(swipeProgress(NaN, 100), 0)
  assert.equal(swipeProgress(50, NaN), 0)
  // Deliberately 0 and NOT clamped to 1. Clamping a non-finite delta up to full
  // progress would mean a garbage pointer reading REMOVES a vendor from the
  // payment lane. Nonsense in must fail safe, and for a destructive control
  // "safe" is no progress at all.
  assert.equal(swipeProgress(Infinity, 100), 0)
  assert.equal(isConfirmed(swipeProgress(Infinity, 100)), false)
})

test('confirmation fires at the threshold and not before', () => {
  assert.equal(isConfirmed(CONFIRM_AT), true, 'exactly at the line counts')
  assert.equal(isConfirmed(CONFIRM_AT - 0.01), false)
  assert.equal(isConfirmed(1), true)
  assert.equal(isConfirmed(0), false)
})

test('a short or careless drag does NOT remove a vendor from the lane', () => {
  // The whole reason the threshold is high: this action changes a vendor's
  // payment lane, and a stray drag must not be enough to do it.
  for (const dx of [1, 10, 30, 60]) {
    assert.equal(isConfirmed(swipeProgress(dx, 100)), false, `${dx}px must not confirm`)
  }
  assert.equal(isConfirmed(swipeProgress(85, 100)), true, 'a deliberate drag does')
})
