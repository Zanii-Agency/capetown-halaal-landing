import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tierPricingFields } from './pricing'

test('syncs the pricing snapshot to the new tier', () => {
  const f = tierPricingFields('marquee-full-3x3', { stall_price: 12000, total_estimate: 12000 })
  assert.deepEqual(f, { stall_type: 'Marquee Full 3×3m', stall_price: 6500, total_estimate: 6500 })
})

test('preserves the add-on delta (total minus base) across a tier change', () => {
  // 6x3 base 12000 + 800 add-ons = 12800 total -> move to 3x3 (6500) keeps +800
  const f = tierPricingFields('marquee-full-3x3', { stall_price: 12000, total_estimate: 12800 })
  assert.equal(f?.stall_price, 6500)
  assert.equal(f?.total_estimate, 7300)
})

test('returns null for an unknown tier so callers do not corrupt the snapshot', () => {
  assert.equal(tierPricingFields('not-a-tier', { stall_price: 6500 }), null)
  assert.equal(tierPricingFields('3x3m Full Marquee', {}), null) // free text is not a slug here
})
