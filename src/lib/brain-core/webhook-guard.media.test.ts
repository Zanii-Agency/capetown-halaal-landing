import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldProcess, _resetForTest } from '@/lib/brain-core/webhook-guard.js'

const noop = { seenByWamid: async () => false, logToChat: async () => {} }

test('two DISTINCT media messages from one sender within 2s are BOTH processed (proof not dropped)', async () => {
  _resetForTest()
  // Stalia 2026-09-01: a screenshot then the real bank proof, seconds apart.
  const a = await shouldProcess('cth', '+27718702167', 'wamid.A', '', noop, { hasMedia: true })
  const b = await shouldProcess('cth', '+27718702167', 'wamid.B', '', noop, { hasMedia: true })
  assert.equal(a.action, 'process')
  assert.equal(b.action, 'process') // was 'skip'/concurrent_duplicate before the fix -> proof lost
})

test('two rapid TEXT webhooks within 2s: the second is still skipped (dedup unchanged)', async () => {
  _resetForTest()
  const a = await shouldProcess('cth', '+27000000000', 'wamid.1', 'hi', noop, {})
  const b = await shouldProcess('cth', '+27000000000', 'wamid.2', 'hi again', noop, {})
  assert.equal(a.action, 'process')
  assert.equal(b.action, 'skip')
})

test('a re-delivered SAME media wamid is still deduped (no double capture)', async () => {
  _resetForTest()
  const seen = { seenByWamid: async (id: string) => id === 'wamid.DUP', logToChat: async () => {} }
  const r = await shouldProcess('cth', '+27111111111', 'wamid.DUP', '', seen, { hasMedia: true })
  assert.equal(r.action, 'skip')
})
