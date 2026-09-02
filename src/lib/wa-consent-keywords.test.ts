// The opt-in matcher used to include "yes", so ordinary affirmations fired the
// "You're back in" greeting (El chapo, Soxbox, Koya's, Islamic Relief, 2026-08-10).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStartKeyword, isStopKeyword } from './wa-consent'

test('affirmations that contain "yes" are NOT opt-in commands', () => {
  for (const s of ['Yes please send contract', 'Yes we can sign', "Oh yes I can't open the portal", 'Yes. That is correct. I would like to withdraw', 'yes']) {
    assert.equal(isStartKeyword(s), false, `should not be START: ${s}`)
  }
})

test('real opt-in keywords still work', () => {
  for (const s of ['start', 'START', 'unstop', 'subscribe', 'opt in', 'opt-in']) {
    assert.equal(isStartKeyword(s), true, `should be START: ${s}`)
  }
})

test('a message that is also a STOP is never treated as START', () => {
  assert.equal(isStopKeyword('stop'), true)
  assert.equal(isStartKeyword('stop'), false)
})
