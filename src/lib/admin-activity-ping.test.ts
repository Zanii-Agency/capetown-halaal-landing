import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldPing, PING_WINDOW_MS } from '@/lib/admin-activity-ping'

// 2026-08-01: Samreen was working on the admin panel and Taona got no alert,
// because the login announcer only fires on a FRESH sign-in and her session
// from 28 July was still alive. The activity ping fires once per 12h window.

test('no prior ping pings', () => {
  assert.equal(shouldPing(null), true)
  assert.equal(shouldPing(undefined), true)
})

test('a ping inside the window does not ping again', () => {
  const now = Date.now()
  const recent = new Date(now - 60 * 60 * 1000).toISOString() // 1h ago
  assert.equal(shouldPing(recent, now), false)
})

test('a ping older than the window pings', () => {
  const now = Date.now()
  const old = new Date(now - PING_WINDOW_MS - 1000).toISOString()
  assert.equal(shouldPing(old, now), true)
})

test('the exact boundary pings (window is inclusive-past)', () => {
  const now = Date.now()
  const edge = new Date(now - PING_WINDOW_MS).toISOString()
  assert.equal(shouldPing(edge, now), true)
})

test('an unparseable timestamp pings rather than hiding activity', () => {
  assert.equal(shouldPing('not a date'), true)
})
