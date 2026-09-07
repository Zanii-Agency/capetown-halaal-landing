import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cancellationTermsText } from '@/lib/contract/copy'

// The bot tells a withdrawing PAID vendor how it works per the terms they
// signed. This proves the copy actually carries the refund tiers (so the bot
// never sends an empty/partial policy) and stays Law-7 clean (no em/en dashes).

test('cancellation terms carry all three refund tiers', () => {
  const t = cancellationTermsText()
  assert.match(t, /100% refund/)
  assert.match(t, /50% refund/)
  assert.match(t, /0% refund/)
  // The intro that frames the tiers must be present, not just bare bullets.
  assert.match(t, /paid their fees/i)
})

test('cancellation terms are Law-7 clean (no em/en dashes)', () => {
  const t = cancellationTermsText()
  assert.ok(!/[—–]/.test(t), 'must contain no em-dash or en-dash')
})
