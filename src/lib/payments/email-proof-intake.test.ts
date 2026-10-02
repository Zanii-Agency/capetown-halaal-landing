// Runs under `npm test`. Pure part of the shared emailed-proof intake.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gmailKey, isEligiblePayer, type IntakeVendor } from './email-proof-intake'
import { updatePortalStateImpl } from '@/lib/portal-state'

test('gmailKey ignores dots and plus-suffixes so a vendor mailing from shameemakhan87@ matches shameemakhan.87@', () => {
  assert.equal(gmailKey('shameemakhan87@gmail.com'), gmailKey('Shameemakhan.87@gmail.com'))
  assert.equal(gmailKey('a.b.c+yah@googlemail.com'), 'abc@gmail.com')
  // non-gmail domains are left alone (dots are significant there)
  assert.equal(gmailKey('josh.l@retailinsight.co.za'), 'josh.l@retailinsight.co.za')
})

// Taona 2026-09-14: a PENDING applicant replied to a blast with the event POSTER
// attached; the email intake had no status gate, filed the poster as an EFT proof,
// and hid the applicant from Samreen. Only an approved, owing vendor can have an
// emailed proof auto-filed: a proof presupposes a fee to pay.
function v(over: Partial<IntakeVendor>): IntakeVendor {
  return { id: 'x', status: 'approved', paid_at: null, ...over }
}

test('approved + unpaid is an eligible payer', () => {
  assert.equal(isEligiblePayer(v({ status: 'approved', paid_at: null })), true)
  assert.equal(isEligiblePayer(v({ status: 'APPROVED', paid_at: null })), true) // case-insensitive
})

test('a non-approved applicant is never an eligible payer', () => {
  assert.equal(isEligiblePayer(v({ status: 'pending' })), false)
  assert.equal(isEligiblePayer(v({ status: 'rejected' })), false)
  assert.equal(isEligiblePayer(v({ status: null })), false)
  assert.equal(isEligiblePayer(v({ status: undefined })), false)
})

test('an already-settled vendor is not owing, so not an auto-file target', () => {
  assert.equal(isEligiblePayer(v({ status: 'approved', paid_at: '2026-09-01T00:00:00Z' })), false)
})

// Zayaan Wellness 2026-09-16: EFT-collected (no paid_at column), emailed both
// duplicate-payment proofs + bank details for a REFUND; it was filed as a new
// master payment because only paid_at was checked.
test('an EFT-collected vendor (no paid_at) is settled, not an auto-file target', () => {
  const notes = updatePortalStateImpl('', { v: 1, payment: { status: 'collected', amount: 3700 } })
  assert.equal(isEligiblePayer(v({ status: 'approved', paid_at: null, admin_notes: notes })), false)
  const owing = updatePortalStateImpl('', { v: 1, payment: { status: 'deferred' } })
  assert.equal(isEligiblePayer(v({ status: 'approved', paid_at: null, admin_notes: owing })), true)
})
