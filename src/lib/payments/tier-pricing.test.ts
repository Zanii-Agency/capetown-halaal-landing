import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tierPricingFields, computeVendorPricing } from './pricing'

test('no tier = custom-only: base 0, total is just the custom charges (the flower sisters)', () => {
  const p = computeVendorPricing({
    preferred_booth_tier: null,
    special_requirements: { stall_type: 'Outdoor Bedouin 2×3m', stall_price: 3750, electrical_custom: [{ label: 'OUTDOOR 2*2', amount: 2000, qty: 1 }] },
  })
  assert.equal(p.stallPrice, 0)   // stale 3750 base is NOT charged when there is no tier
  assert.equal(p.total, 2000)     // only the custom charge
})

test('tiered vendor keeps their stored/agreed price (negotiated rate not overwritten)', () => {
  const p = computeVendorPricing({
    preferred_booth_tier: 'marquee-full-3x3',
    special_requirements: { stall_price: 4800 }, // Telkom-style negotiated rate under the R6500 standard
  })
  assert.equal(p.stallPrice, 4800)
  assert.equal(p.total, 4800)
})

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
