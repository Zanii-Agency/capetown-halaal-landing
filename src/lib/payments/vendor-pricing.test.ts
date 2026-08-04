import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vendorFacingPricing, REPRICE_ACK_IDS } from '@/lib/payments/vendor-pricing'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { updatePortalStateImpl } from '@/lib/portal-state'

// A vendor whose free-text electrical would add R1 000 to a R6 500 stall.
const REQS = JSON.stringify({
  stall_type: 'MARQUEE Full Space — 3m x 3m',
  stall_price: 6500,
  electrical_appliances: '1x Small Display Fridge (R400), 1x Large Display Fridge/Freezer (R600)',
})
const APP = { preferred_booth_tier: 'marquee-full-3x3', special_requirements: REQS }

const notesWith = (payment: Record<string, unknown>) =>
  updatePortalStateImpl('', { payment } as never)

test('unpaid vendor sees the LIVE repriced total (the under-quote was the bug)', () => {
  assert.equal(vendorFacingPricing({ ...APP, admin_notes: null }).total, 7500)
})

test('paid vendor is frozen at the pre-reprice computation', () => {
  const p = vendorFacingPricing({
    ...APP,
    admin_notes: notesWith({ status: 'paid', amount: 6500, paid_at: '2026-08-01T00:00:00Z' }),
  })
  assert.equal(p.total, 6500)
  assert.equal(p.electricalItems.length, 0)
})

test('collected (EFT interim) vendor is frozen too', () => {
  const p = vendorFacingPricing({ ...APP, admin_notes: notesWith({ status: 'collected', amount: 6500 }) })
  assert.equal(p.total, 6500)
})

test('top-level paid_at alone freezes even without marker status', () => {
  assert.equal(vendorFacingPricing({ ...APP, admin_notes: null, paid_at: '2026-08-01T00:00:00Z' }).total, 6500)
})

test('an acknowledged vendor (Vanilla Cream) keeps the live total', () => {
  const id = [...REPRICE_ACK_IDS][0]
  const p = vendorFacingPricing({
    ...APP,
    id,
    admin_notes: notesWith({ status: 'paid', amount: 6500, paid_at: '2026-08-04T00:00:00Z' }),
  })
  assert.equal(p.total, 7500)
})

test('a vendor who PAID the repriced total is never shown less than they paid', () => {
  const p = vendorFacingPricing({
    ...APP,
    admin_notes: notesWith({ status: 'paid', amount: 7500, paid_at: '2026-08-05T00:00:00Z' }),
  })
  assert.equal(p.total, 7500)
})

test('admin truth is untouched: computeVendorPricing still returns the live total', () => {
  assert.equal(computeVendorPricing(APP).total, 7500)
})
