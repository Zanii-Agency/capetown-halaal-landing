import { test } from 'node:test'
import assert from 'node:assert/strict'
import { availableKeysFor } from '@/lib/inbox/send-library'

test('a signed vendor is offered the contract FILE, never the sign-it link', () => {
  const k = availableKeysFor({
    preferred_booth_tier: '3x3', contract_signed_at: '2026-06-14T09:57:36Z',
    contract_pdf_path: 'signed-contracts/x.pdf',
  })
  assert.ok(k.includes('contract'))
  assert.ok(!k.includes('contract_link'))
})

test('an unsigned vendor is offered the link, never a file that does not exist', () => {
  // This is the bug the library exists to kill: the bot offered to "send your
  // contract to sign" when no such document had ever been produced.
  const k = availableKeysFor({ preferred_booth_tier: '3x3', contract_signed_at: null })
  assert.ok(k.includes('contract_link'))
  assert.ok(!k.includes('contract'))
})

test('signed but with no stored PDF offers neither a file nor a false promise', () => {
  // Real rows look like this: contract_signed_at set, contract_pdf_path null.
  const k = availableKeysFor({ preferred_booth_tier: '3x3', contract_signed_at: '2026-06-10T08:30:00Z', contract_pdf_path: null })
  assert.ok(!k.includes('contract'))
  assert.ok(!k.includes('contract_link'))
})

test('no tier means no invoice, because pricing would throw', () => {
  assert.ok(!availableKeysFor({ preferred_booth_tier: null }).includes('invoice'))
  assert.ok(availableKeysFor({ preferred_booth_tier: '3x3' }).includes('invoice'))
})

test('the links every vendor can always be sent', () => {
  const k = availableKeysFor({})
  for (const key of ['payments', 'portal', 'logo_upload']) assert.ok(k.includes(key), key)
})
