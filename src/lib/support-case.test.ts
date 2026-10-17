import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openCase } from './support-case'

const m = (from: 'vendor' | 'admin', at: string, body = 'x') => ({ id: at, from, body, at })
const NOW = Date.parse('2026-09-23T12:00:00Z')

test('no vendor asks, no case', () => {
  assert.equal(openCase({ support: [] }, NOW), null)
  assert.equal(openCase({ support: [m('admin', '2026-09-20T00:00:00Z')] }, NOW), null)
})

test('a hand-over opens a case with a 72h clock; a chase joins it, not a new one', () => {
  const c = openCase({ support: [m('vendor', '2026-09-22T10:00:00Z', 'stall position?'), m('vendor', '2026-09-23T09:00:00Z', 'any news?')] }, NOW)!
  assert.equal(c.asks, 2)
  assert.equal(c.firstAsk, 'stall position?')
  assert.equal(c.dueAt, '2026-09-25T10:00:00.000Z')
  assert.equal(c.overdue, false)
})

test('past 72h is overdue', () => {
  assert.equal(openCase({ support: [m('vendor', '2026-09-14T10:00:00Z')] }, NOW)!.overdue, true)
})

test('a team reply in the portal thread closes it; a later ask opens a NEW case', () => {
  const s = { support: [m('vendor', '2026-09-10T00:00:00Z'), m('admin', '2026-09-11T00:00:00Z'), m('vendor', '2026-09-22T00:00:00Z', 'new')] }
  const c = openCase(s, NOW)!
  assert.equal(c.asks, 1)
  assert.equal(c.firstAsk, 'new')
})

test('a human answer on WhatsApp/email (supportResolvedAt) closes it too', () => {
  const s = { support: [m('vendor', '2026-09-20T00:00:00Z')], supportResolvedAt: '2026-09-21T00:00:00Z' }
  assert.equal(openCase(s, NOW), null)
})

import { settledBy } from './support-case'
import { updatePortalStateImpl } from '@/lib/portal-state'
const notes = (payment: Record<string, unknown>, extra: Record<string, unknown> = {}) => updatePortalStateImpl('', { v: 1, payment, ...extra } as never)

test('a payment question is settled by a later payment', () => {
  assert.equal(settledBy('Can I get an extension to pay?', '2026-08-31T09:00:00Z', { admin_notes: notes({ status: 'paid', paid_at: '2026-08-31T16:47:00Z' }) }), 'paid')
})

test('a later payment does NOT settle an unrelated request (El chapo: remove appliances)', () => {
  assert.equal(settledBy('Remove the blender and display fridge from my booking', '2026-09-21T08:33:00Z', { admin_notes: notes({ status: 'paid', paid_at: '2026-09-23T08:00:00Z' }) }), null)
})

test('a payment BEFORE the question settles nothing', () => {
  assert.equal(settledBy('Where do I pay?', '2026-09-10T00:00:00Z', { admin_notes: notes({ status: 'paid', paid_at: '2026-09-01T00:00:00Z' }) }), null)
})

test('"was I accepted?" is settled by a later decision; a withdrawal settles anything', () => {
  assert.equal(settledBy('Was my application accepted?', '2026-07-22T14:00:00Z', { status: 'approved', reviewed_at: '2026-07-26T14:47:00Z' }), 'decided')
  assert.equal(settledBy('Any question at all', '2026-08-31T07:39:00Z', { admin_notes: notes({}, { withdrawn: { at: '2026-09-01T00:00:00Z' } }) }), 'withdrew')
})

test('a stall-size request is settled once the stall change is decided', () => {
  assert.equal(settledBy('I want to change to the Bedouin 2x3 size', '2026-08-31T07:24:00Z', { admin_notes: notes({}, { stallChangeRequest: { requestedTier: 'b', currentTier: 'a', reason: '', status: 'rejected', createdAt: '2026-08-29T00:00:00Z' } }) }), 'stall change decided')
})
