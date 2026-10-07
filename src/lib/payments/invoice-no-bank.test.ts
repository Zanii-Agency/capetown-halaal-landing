import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInvoiceHtml } from './invoice-pdf'
import { computeVendorPricing } from './pricing'

// Taona 2026-09-28: "never let them show the bank details, just the amount and
// what they are paying for". An invoice must never carry ANY account number, for
// either rail, paid or unpaid, and whatever a caller tries to pass.
const ACCOUNTS = ['63168769629', '63141269191', '63170873351', '63152829728']

const base = (status: string) => ({
  businessName: 'Tasca Mozambique',
  contactName: 'Mikaeel',
  email: 'x@example.com',
  pricing: computeVendorPricing({ preferred_booth_tier: 'food-truck-6m', special_requirements: JSON.stringify({ stall_type: 'Food Truck 6m' }) }),
  totalAmount: 7500,
  status,
  reference: 'YAH-8EF5FD1B',
  issuedAt: '28 September 2026',
})

test('an unpaid invoice shows the item and amount, DUE, and no bank details', () => {
  const html = buildInvoiceHtml(base('none'))
  assert.match(html, /Food Truck 6m/)
  assert.match(html, /R7\s?500/)
  assert.match(html, />DUE</)
  assert.doesNotMatch(html, />NONE</)
  assert.doesNotMatch(html, /How to pay/i)
  assert.doesNotMatch(html, /Account number|Branch code/i)
  for (const a of ACCOUNTS) assert.ok(!html.includes(a), `account ${a} must never appear`)
})

test('a caller cannot smuggle bank details in (extra fields are ignored)', () => {
  const html = buildInvoiceHtml({ ...base('pending'), bank: { accountName: 'Halaal Hub', bank: 'FNB', accountNumber: '63141269191', branchCode: '250655' }, payReference: 'X' } as never)
  for (const a of ACCOUNTS) assert.ok(!html.includes(a), `account ${a} must never appear`)
  assert.doesNotMatch(html, /Branch code|250655/)
})

test('a paid invoice shows the receipt, still no bank details', () => {
  const html = buildInvoiceHtml({ ...base('paid'), paidAt: '20 September 2026', method: 'yoco' } as never)
  assert.match(html, /PAID/)
  for (const a of ACCOUNTS) assert.ok(!html.includes(a), `account ${a} must never appear`)
})
