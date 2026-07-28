import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isWindowOpen, hoursUntilClose, SERVICE_WINDOW_MS } from './wa-window'

const NOW = new Date('2026-07-28T12:00:00Z').getTime()
const agoH = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

test('the window is open inside 24h and shut outside it', () => {
  assert.equal(isWindowOpen(agoH(0.5), NOW), true)
  assert.equal(isWindowOpen(agoH(23.9), NOW), true)
  assert.equal(isWindowOpen(agoH(24.1), NOW), false)
  assert.equal(isWindowOpen(agoH(908), NOW), false, "the festival owner's real gap, 38 days")
})

test('unknown fails CLOSED, so an unknown number gets a template', () => {
  // Asymmetric costs: a wrong `true` produces a message Meta accepts with a 200
  // and silently drops, which is invisible. A wrong `false` costs one template
  // send that would have worked anyway.
  for (const v of [null, undefined, '', 'not-a-date']) {
    assert.equal(isWindowOpen(v, NOW), false, JSON.stringify(v))
  }
})

test('the boundary is exclusive, so exactly 24h old is shut', () => {
  assert.equal(isWindowOpen(new Date(NOW - SERVICE_WINDOW_MS).toISOString(), NOW), false)
  assert.equal(isWindowOpen(new Date(NOW - SERVICE_WINDOW_MS + 1000).toISOString(), NOW), true)
})

test('hoursUntilClose counts down, and is null once shut', () => {
  assert.equal(Math.round(hoursUntilClose(agoH(21), NOW)!), 3)
  assert.equal(Math.round(hoursUntilClose(agoH(1), NOW)!), 23)
  assert.equal(hoursUntilClose(agoH(25), NOW), null)
  assert.equal(hoursUntilClose(null, NOW), null)
})
