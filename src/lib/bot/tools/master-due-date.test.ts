import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vendorSummary, type VRow } from '@/lib/bot/tools/master-registry'

// Taona asked the master brain when Barfi Bliss (Shereen, approved 2026-07-26,
// unpaid) must pay. It answered "there's no due date field for her to see... it
// genuinely isn't there yet" and "I don't have a standard days-to-pay rule
// stored anywhere", while her OWN dashboard was showing 25 August 2026.
//
// Root cause: this tool read pay?.due from portal state, which nothing writes,
// instead of computePaymentDue (reviewed_at + 30 days), the one rule the vendor
// dashboard and the vendor bot both run on. The master brain was a reader that
// did not know the rule. Same seam class as the owner-cutoff and sender-scope
// leaks: a rule wired into some readers and absent in this one.

function row(over: Partial<VRow>): VRow {
  return {
    id: 'v1', business_name: 'Barfi Bliss', contact_name: 'Shereen', email: null, phone: null,
    status: 'approved', admin_notes: null, paid_at: null, preferred_booth_tier: 'marquee-full-3x3',
    special_requirements: null, reviewed_at: null, payment_due_date: null, ...over,
  }
}

test('an approved unpaid vendor now carries a computed due date', () => {
  // reviewed_at + 30 = the exact date her dashboard shows. Without this the
  // master brain says she has none.
  const s = vendorSummary(row({ reviewed_at: '2026-07-26T14:08:26Z' }))
  assert.match(s, /stall fee due 25 August 2026/)
  assert.match(s, /days left/)
})

test('a vendor past their window reads as overdue, not blank', () => {
  const s = vendorSummary(row({ reviewed_at: '2026-01-01T00:00:00Z' }))
  assert.match(s, /overdue/)
  assert.doesNotMatch(s, /days left/)
})

test('a paid vendor shows no due date at all', () => {
  const s = vendorSummary(row({ reviewed_at: '2026-07-26T14:08:26Z', paid_at: '2026-07-28T00:00:00Z' }))
  assert.match(s, /PAID/)
  assert.doesNotMatch(s, /due/)
})

test('a vendor never reviewed genuinely has no date, and says so plainly', () => {
  // The honest null case: no reviewed_at means no rule input, so no invented
  // date. This is the ONLY case where "no due date" is a true answer.
  const s = vendorSummary(row({ reviewed_at: null }))
  assert.doesNotMatch(s, /stall fee due/)
})

test('the summary carries no long dash (law 7)', () => {
  const s = vendorSummary(row({ reviewed_at: '2026-07-26T14:08:26Z' }))
  assert.equal(/[—–]/.test(s), false)
})

test('a vendor with no reviewed_at but an APPROVED_NOTIFIED marker gets a due date', () => {
  // Thaaniyah Malander scenario: reviewed_at is empty but the approval template
  // went out on 2026-07-26. The master brain should still say 25 August 2026.
  const s = vendorSummary(row({
    reviewed_at: null,
    admin_notes: '⟦APPROVED_NOTIFIED:2026-07-26T14:17:31.081Z⟧ Some note.',
  }))
  assert.match(s, /stall fee due 25 August 2026/)
})
