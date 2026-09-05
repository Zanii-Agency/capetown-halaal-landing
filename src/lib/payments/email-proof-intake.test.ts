// Runs under `npm test`. Pure part of the shared emailed-proof intake.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gmailKey } from './email-proof-intake'

test('gmailKey ignores dots and plus-suffixes so a vendor mailing from shameemakhan87@ matches shameemakhan.87@', () => {
  assert.equal(gmailKey('shameemakhan87@gmail.com'), gmailKey('Shameemakhan.87@gmail.com'))
  assert.equal(gmailKey('a.b.c+yah@googlemail.com'), 'abc@gmail.com')
  // non-gmail domains are left alone (dots are significant there)
  assert.equal(gmailKey('josh.l@retailinsight.co.za'), 'josh.l@retailinsight.co.za')
})
