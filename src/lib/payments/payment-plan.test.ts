import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlan, planApprovedMsg } from './payment-plan'

// Fixed "today" so this never rots like a date-relative test.
const TODAY = '2026-09-04'
const OWING = 6500
const ok2 = [{ date: '2026-09-30', amount: 3000 }, { date: '2026-10-31', amount: 3500 }]

test('a valid 2-instalment plan that covers the fee is accepted', () => {
  const r = validatePlan(ok2, OWING, TODAY)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.plan.length, 2)
})

test('instalments summing to MORE than owing are fine', () => {
  assert.equal(validatePlan([{ date: '2026-09-30', amount: 4000 }, { date: '2026-10-31', amount: 4000 }], OWING, TODAY).ok, true)
})

test('instalments summing to LESS than owing are rejected', () => {
  const r = validatePlan([{ date: '2026-09-30', amount: 1000 }, { date: '2026-10-31', amount: 2000 }], OWING, TODAY)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /cover the full amount/i)
})

test('fewer than 2 instalments is rejected', () => {
  assert.equal(validatePlan([{ date: '2026-09-30', amount: 6500 }], OWING, TODAY).ok, false)
})

test('more than 6 instalments is rejected', () => {
  const many = ['09-05', '09-06', '09-07', '09-08', '09-09', '09-10', '09-11'].map((d) => ({ date: `2026-${d}`, amount: 1000 }))
  assert.equal(validatePlan(many, OWING, TODAY).ok, false)
})

test('a past or today date is rejected', () => {
  assert.equal(validatePlan([{ date: '2026-09-04', amount: 3000 }, { date: '2026-10-31', amount: 3500 }], OWING, TODAY).ok, false)
  assert.equal(validatePlan([{ date: '2026-08-01', amount: 3000 }, { date: '2026-10-31', amount: 3500 }], OWING, TODAY).ok, false)
})

test('a date after the festival cap (12 Dec 2026) is rejected', () => {
  const r = validatePlan([{ date: '2026-11-30', amount: 3000 }, { date: '2026-12-13', amount: 3500 }], OWING, TODAY)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /before the festival/i)
})

test('out-of-order dates are rejected', () => {
  const r = validatePlan([{ date: '2026-10-31', amount: 3000 }, { date: '2026-09-30', amount: 3500 }], OWING, TODAY)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /in order/i)
})

test('a zero or non-numeric amount is rejected', () => {
  assert.equal(validatePlan([{ date: '2026-09-30', amount: 0 }, { date: '2026-10-31', amount: 6500 }], OWING, TODAY).ok, false)
  assert.equal(validatePlan([{ date: '2026-09-30', amount: 'lots' }, { date: '2026-10-31', amount: 6500 }], OWING, TODAY).ok, false)
})

test('a malformed date is rejected', () => {
  assert.equal(validatePlan([{ date: '30 September', amount: 3000 }, { date: '2026-10-31', amount: 3500 }], OWING, TODAY).ok, false)
  assert.equal(validatePlan([{ date: '2026-13-45', amount: 3000 }, { date: '2026-10-31', amount: 3500 }], OWING, TODAY).ok, false)
})

test('non-array input is rejected, not thrown', () => {
  assert.equal(validatePlan(undefined, OWING, TODAY).ok, false)
  assert.equal(validatePlan('two payments', OWING, TODAY).ok, false)
})

test('the approval message is dash-free (Law 7) and lists the dates', () => {
  const msg = planApprovedMsg(ok2)
  assert.ok(!/[—–]/.test(msg), 'no em or en dashes')
  assert.match(msg, /30 September 2026/)
  assert.match(msg, /support@youngatheart\.co\.za/)
})
