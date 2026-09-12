import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlan, planApprovedMsg, planLastDateFor } from './payment-plan'

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

test('a date after the plan cap (31 Oct 2026) is rejected', () => {
  // The cap moved to END OF OCTOBER (Taona 2026-09-09): no instalment past 31 Oct.
  const r = validatePlan([{ date: '2026-10-15', amount: 3000 }, { date: '2026-11-30', amount: 3500 }], OWING, TODAY)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /paid by 31 October 2026/i)
  // the last valid day is 31 Oct: a plan that lands exactly on it still passes
  assert.equal(validatePlan([{ date: '2026-10-10', amount: 3000 }, { date: '2026-10-31', amount: 3500 }], OWING, TODAY).ok, true)
})

test('new-vendor cohort (⟦NEWVENDOR⟧) is capped at 10 Oct, everyone else at 31 Oct', () => {
  assert.equal(planLastDateFor('⟦NEWVENDOR⟧'), '2026-10-10')
  assert.equal(planLastDateFor('ordinary notes'), '2026-10-31')
  assert.equal(planLastDateFor(null), '2026-10-31')
  const cap = planLastDateFor('⟦NEWVENDOR⟧')
  // a fresher's 15 Oct instalment is too late and the error names 10 Oct
  const late = validatePlan([{ date: '2026-09-30', amount: 3000 }, { date: '2026-10-15', amount: 3500 }], OWING, TODAY, cap)
  assert.equal(late.ok, false)
  if (!late.ok) assert.match(late.error, /paid by 10 October 2026/i)
  // all instalments on/before 10 Oct pass for a fresher
  assert.equal(validatePlan([{ date: '2026-09-30', amount: 3000 }, { date: '2026-10-10', amount: 3500 }], OWING, TODAY, cap).ok, true)
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

test('nextInstalment: the first instalment the money so far has not covered, with what is still due on it', async () => {
  const { nextInstalment, planSummary } = await import('./payment-plan')
  const plan = { plan_status: 'approved', installments: [{ date: '2026-10-02', amount: 2500 }, { date: '2026-09-06', amount: 5000 }] }
  // nothing paid: instalment 1 (sorted by date), R5 000
  assert.deepEqual(nextInstalment(plan, 0), { index: 0, amount: 5000, date: '2026-09-06', total: 5000, count: 2 })
  // R5 000 confirmed: instalment 2, R2 500
  assert.deepEqual(nextInstalment(plan, 5000), { index: 1, amount: 2500, date: '2026-10-02', total: 7500, count: 2 })
  // a short first payment (R3 000): the rest of instalment 1 is still due
  assert.equal(nextInstalment(plan, 3000)?.amount, 2000)
  // fully paid, pending plan, or no plan: nothing
  assert.equal(nextInstalment(plan, 7500), null)
  assert.equal(nextInstalment({ ...plan, plan_status: 'pending' }, 0), null)
  assert.equal(nextInstalment(undefined, 0), null)
  // locale thousands separator is a non-breaking space; assert on the words, not the byte
  assert.match(planSummary(plan.installments), /^R5.000 by 6 September 2026, then R2.500 by 2 October 2026$/)
})
