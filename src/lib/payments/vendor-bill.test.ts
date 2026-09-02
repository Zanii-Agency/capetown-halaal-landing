import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vendorBill, accEftReference } from '@/lib/payments/vendor-bill'
import { updatePortalStateImpl } from '@/lib/portal-state'

// R6 500 stall + R1 000 free-text electrical (the exact Vanilla Cream shape).
const REQS = JSON.stringify({
  stall_type: 'MARQUEE Full Space — 3m x 3m',
  stall_price: 6500,
  electrical_appliances: '1x Small Display Fridge (R400), 1x Large Display Fridge/Freezer (R600)',
})
const APP = { preferred_booth_tier: 'marquee-full-3x3', special_requirements: REQS }
const notesWith = (payment: Record<string, unknown>) => updatePortalStateImpl('', { payment } as never)

test('unpaid vendor: one combined balance, nothing split off', () => {
  const b = vendorBill({ ...APP, admin_notes: null })
  assert.equal(b.settled, false)
  assert.equal(b.liveTotal, 7500)
  assert.equal(b.owing, 7500)
  assert.equal(b.accessories.total, 1000)
})

test('a reveal click alone is NOT EFT evidence: still class card', () => {
  const b = vendorBill({
    ...APP,
    admin_notes: notesWith({ status: 'paid', method: 'yoco', amount: 6500, paid_at: '2026-08-01T00:00:00Z', eft_revealed_at: '2026-07-30T00:00:00Z' }),
  })
  assert.equal(b.payClass, 'card') // peeked at bank details, then paid by card
})

test('EFT payer who paid stall only: stall PAID, accessories OWING, class eft', () => {
  const b = vendorBill({
    ...APP,
    admin_notes: notesWith({ status: 'paid', method: 'yoco', amount: 6500, paid_at: '2026-08-04T09:23:50Z', eft_submitted_at: '2026-08-04T08:57:17Z' }),
  })
  assert.equal(b.settled, true)
  assert.equal(b.payClass, 'eft') // EFT evidence beats method yoco (Vanilla Cream)
  assert.equal(b.stall.paid, true)
  assert.equal(b.accessories.owing, 1000)
  assert.equal(b.accessories.state, 'owing')
  assert.equal(b.owing, 1000)
})

test('card payer who paid stall only: same owing, class card', () => {
  const b = vendorBill({
    ...APP,
    admin_notes: notesWith({ status: 'paid', method: 'yoco', amount: 6500, paid_at: '2026-08-01T00:00:00Z' }),
  })
  assert.equal(b.payClass, 'card')
  assert.equal(b.accessories.owing, 1000)
})

test('collected (EFT interim) vendor counts as settled with accessories owing', () => {
  const b = vendorBill({ ...APP, admin_notes: notesWith({ status: 'collected', amount: 6500 }) })
  assert.equal(b.settled, true)
  assert.equal(b.payClass, 'eft')
  assert.equal(b.accessories.owing, 1000)
})

test('vendor who paid the full new total owes nothing', () => {
  const b = vendorBill({ ...APP, admin_notes: notesWith({ status: 'paid', amount: 7500, paid_at: '2026-08-05T00:00:00Z' }) })
  assert.equal(b.accessories.state, 'paid')
  assert.equal(b.owing, 0)
})

test('accessory proof uploaded -> pending; collected -> paid; settled -> stays paid (no double count)', () => {
  const base = { status: 'paid', amount: 6500, paid_at: '2026-08-01T00:00:00Z', eft_submitted_at: '2026-07-30T00:00:00Z' }
  const pending = vendorBill({ ...APP, admin_notes: notesWith({ ...base, acc: { submitted_at: '2026-08-05T00:00:00Z' } }) })
  assert.equal(pending.accessories.state, 'pending')
  assert.equal(pending.accessories.owing, 1000) // still owed until collected

  const collected = vendorBill({ ...APP, admin_notes: notesWith({ ...base, acc: { amount: 1000, submitted_at: '2026-08-05T00:00:00Z', collected_at: '2026-08-06T00:00:00Z' } }) })
  assert.equal(collected.accessories.state, 'paid')
  assert.equal(collected.owing, 0)

  // After Yoco settlement the amount lives INSIDE payment.amount (top-up), and
  // acc.settled_at stops the collected amount counting a second time.
  const settled = vendorBill({ ...APP, admin_notes: notesWith({ ...base, amount: 7500, acc: { amount: 1000, submitted_at: '2026-08-05T00:00:00Z', collected_at: '2026-08-06T00:00:00Z', settled_at: '2026-08-07T00:00:00Z' } }) })
  assert.equal(settled.accessories.state, 'paid')
  assert.equal(settled.accessories.paid, 1000)
  assert.equal(settled.owing, 0)
})

test('no appliances: accessories state none, nothing owing', () => {
  const reqs = JSON.stringify({ stall_type: 'MARQUEE Full Space — 3m x 3m', stall_price: 6500 })
  const b = vendorBill({ preferred_booth_tier: 'marquee-full-3x3', special_requirements: reqs, admin_notes: notesWith({ status: 'paid', amount: 6500, paid_at: '2026-08-01T00:00:00Z' }) })
  assert.equal(b.accessories.state, 'none')
  assert.equal(b.owing, 0)
})

test('accessory EFT reference is the vendor reference with -ACC', () => {
  const id = '13e664c3-3b28-4f3f-b8c7-db7069e0249b'
  assert.equal(accEftReference({ id, admin_notes: null }), 'CTHE0249B-ACC')
})
