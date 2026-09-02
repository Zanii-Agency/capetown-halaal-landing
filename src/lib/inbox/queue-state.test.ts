import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCleared, type DoneMark } from '@/lib/inbox/queue-state'

const mark = (at: string, done = true): DoneMark => ({ at, by: 'samreen', done })

test('marking done clears the pin', () => {
  assert.equal(isCleared(mark('2026-07-27T10:00:00Z'), '2026-07-27T09:00:00Z'), true)
})

test('a NEW message after you cleared it puts the thread back', () => {
  // The whole risk of a manual Done: muting someone permanently.
  assert.equal(isCleared(mark('2026-07-27T10:00:00Z'), '2026-07-27T11:00:00Z'), false)
})

test('never marked, or explicitly reopened, stays in the queue', () => {
  assert.equal(isCleared(undefined, '2026-07-27T09:00:00Z'), false)
  assert.equal(isCleared(mark('2026-07-27T10:00:00Z', false), '2026-07-27T09:00:00Z'), false)
})

test('a thread with no inbound at all can still be cleared', () => {
  assert.equal(isCleared(mark('2026-07-27T10:00:00Z'), null), true)
})

test('same instant counts as cleared, not as a race', () => {
  assert.equal(isCleared(mark('2026-07-27T10:00:00Z'), '2026-07-27T10:00:00Z'), true)
})
