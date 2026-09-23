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
