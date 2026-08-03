import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFestivalSender } from './route'

// 2026-08-01: the Resend account is shared with other apps, and the first
// outbound-sync version imported their sends into the festival inbox. Louis's
// AdPilot / account-health alerts (from ads@zanii.agency) appeared as outbound
// festival threads. The sync now imports festival senders only.

test('the festival sender is imported', () => {
  assert.equal(isFestivalSender('Young at Heart Festival <support@youngatheart.co.za>'), true)
  assert.equal(isFestivalSender('support@youngatheart.co.za'), true)
  assert.equal(isFestivalSender('SUPPORT@youngatheart.co.za'), true)
})

test('foreign app senders are not imported', () => {
  assert.equal(isFestivalSender('AdPilot <ads@zanii.agency>'), false)
  assert.equal(isFestivalSender('AdPilot Alerts <ads@zanii.agency>'), false)
  assert.equal(isFestivalSender('noreply@some-other-app.com'), false)
})

test('a missing or empty from fails closed', () => {
  assert.equal(isFestivalSender(null), false)
  assert.equal(isFestivalSender(undefined), false)
  assert.equal(isFestivalSender(''), false)
})

test('a lookalike address does not slip through', () => {
  assert.equal(isFestivalSender('support@youngatheart.co.za.evil.com'), false)
})
