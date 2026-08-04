import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeVendorPricing } from '@/lib/payments/pricing'

// electrical_appliances is stored as a human-readable STRING for 218 of 242
// approved vendors ("1x Charger/Lighting (R400)"). computeVendorPricing only
// parsed the object form used by 7 vendors, so for everyone else the accessories
// dropped out of the total and they were billed the bare stall fee. The portal,
// the invoice and the EFT "collected" amount all read this total, so the money
// was actually under-collected (2026-08-04 audit: R9,250 short across 10 paid
// EFT vendors). Fixed to parse the string; guarded so electrical_custom (the
// admin's version of the same appliances) does not double-charge.

const TIER = 'marquee-full-3x3' // R6500 base

test('string-form electrical is added to the total (the 218-vendor case)', () => {
  const p = computeVendorPricing({
    preferred_booth_tier: TIER,
    special_requirements: { stall_price: 6500, electrical_appliances: '1x Charger/Lighting (R400)', total_estimate: 6900 },
  })
  assert.equal(p.electricalTotal, 400)
  assert.equal(p.total, 6900) // base 6500 + 400, exactly the quoted total
  assert.equal(p.electricalItems.length, 1)
})

test('multiple comma-separated items sum correctly', () => {
  const p = computeVendorPricing({
    preferred_booth_tier: 'mini-dessert-truck-3.5m', // R5000
    special_requirements: { stall_price: 5000, electrical_appliances: '1x Charger/Lighting (R400), 1x Double Fryer (R800), 1x Small Display Fridge (R400)' },
  })
  assert.equal(p.electricalTotal, 1600)
  assert.equal(p.total, 6600)
})

test('the (R…) is the LINE total, so a quantity is not multiplied again', () => {
  // "5x Waffle/Pancake Maker (R2500)" is 5 units at R500 = R2500, not 5 x 2500.
  const p = computeVendorPricing({
    preferred_booth_tier: TIER,
    special_requirements: { stall_price: 6500, electrical_appliances: '5x Waffle/Pancake Maker (R2500)' },
  })
  assert.equal(p.electricalTotal, 2500)
})

test('"1x None (R0)" means no power, not a R0 line', () => {
  const p = computeVendorPricing({
    preferred_booth_tier: TIER,
    special_requirements: { stall_price: 6500, electrical_appliances: '1x None (R0)' },
  })
  assert.equal(p.electricalTotal, 0)
  assert.equal(p.total, 6500)
})

test('electrical_custom SUPERSEDES the string, no double-charge', () => {
  // Royal Nuts shape: the string and the admin custom name the same charger, so
  // only the custom (the admin's authoritative list) must count.
  const p = computeVendorPricing({
    preferred_booth_tier: TIER,
    special_requirements: {
      stall_price: 6500,
      electrical_appliances: '1x Charger/Lighting (R400)',
      electrical_custom: [{ label: 'Charger and Lighting', amount: 400, qty: 1 }, { label: 'Nut roasting machine', amount: 1200, qty: 1 }],
    },
  })
  // 400 + 1200 from custom only, NOT 400 (string) + 400 + 1200
  assert.equal(p.electricalTotal, 1600)
  assert.equal(p.total, 8100)
})

test('object-form electrical still works (the 7-vendor case, unchanged)', () => {
  const p = computeVendorPricing({
    preferred_booth_tier: 'marquee-full-double-6x3', // R12000
    special_requirements: { stall_price: 12000, electrical_appliances: { 'large-display-fridge-freezer': 1, 'electric-stove': 1 } },
  })
  assert.equal(p.electricalTotal, 600 + 750)
})

test('no electrical means base only', () => {
  const p = computeVendorPricing({ preferred_booth_tier: TIER, special_requirements: { stall_price: 6500 } })
  assert.equal(p.electricalTotal, 0)
  assert.equal(p.total, 6500)
})
