// Guards the one predicate every payment-chase reader shares. Each case here is
// a vendor who was actually chased wrongly on 2026-07-25.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasPaid, isChaseSuppressed, type PortalState } from './portal-state'

const st = (payment: PortalState['payment']): PortalState => ({ v: 1, payment })
const NOW = new Date('2026-07-26T10:00:00Z')

test('hasPaid: collected counts as paid, the vendor was already acknowledged', () => {
  assert.equal(hasPaid(st({ status: 'collected', amount: 6500 })), true)
  assert.equal(hasPaid(st({ status: 'paid' })), true)
  assert.equal(hasPaid(st({ status: 'waived' })), true)
  assert.equal(hasPaid(st({ paid_at: '2026-07-01T00:00:00Z' })), true)
})

test('hasPaid: unpaid states are not paid, and deferred is NOT payment', () => {
  assert.equal(hasPaid(st({ status: 'none' })), false)
  assert.equal(hasPaid(st({ status: 'pending' })), false)
  assert.equal(hasPaid(st({ status: 'deferred' })), false)
  assert.equal(hasPaid(st(undefined)), false)
  assert.equal(hasPaid({ v: 1 }), false)
})

test('isChaseSuppressed: Saba (collected) is never chased for money already in', () => {
  assert.equal(isChaseSuppressed(st({ status: 'collected', amount: 6500 }), NOW), true)
})

test('isChaseSuppressed: an unlapsed deferral suppresses, a lapsed one does not', () => {
  const arrangement = { until: '2026-08-31', agreed_at: '2026-07-25T18:00:00Z' }
  // En Vogue / CellXpress: told they have until 31 August.
  assert.equal(isChaseSuppressed(st({ status: 'deferred', arrangement }), NOW), true)
  assert.equal(isChaseSuppressed(st({ status: 'deferred', arrangement }), new Date('2026-08-31T20:00:00Z')), true)
  // Lapsed: chaseable again, so a deferral can never become a silent write-off.
  assert.equal(isChaseSuppressed(st({ status: 'deferred', arrangement }), new Date('2026-09-01T06:00:00Z')), false)
})

test('isChaseSuppressed: deferred with no end date is open-ended', () => {
  assert.equal(isChaseSuppressed(st({ status: 'deferred' }), NOW), true)
})

test('isChaseSuppressed: ordinary unpaid vendors stay chaseable', () => {
  assert.equal(isChaseSuppressed(st({ status: 'none' }), NOW), false)
  assert.equal(isChaseSuppressed(st({ status: 'pending' }), NOW), false)
  assert.equal(isChaseSuppressed({ v: 1 }, NOW), false)
})
