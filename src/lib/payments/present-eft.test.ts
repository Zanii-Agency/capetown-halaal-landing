import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { vendorInOwnerScope } from '@/lib/eft'

const withPayment = (pay: Record<string, unknown>) =>
  `⟦PORTAL:${Buffer.from(JSON.stringify({ v: 1, payment: pay })).toString('base64')}⟧`

// presentEftAsPaid + markEftReconciled are DB-backed (exercised end-to-end in the
// live verification). These assert the load-bearing CONTRACT by source, so a future
// edit cannot quietly break the money-integrity / privacy guarantees the feature rests on.
const SRC = readFileSync(join(process.cwd(), 'src/lib/payments/confirm.ts'), 'utf8')
const PRESENT = SRC.slice(
  SRC.indexOf('export async function presentEftAsPaid'),
  SRC.indexOf('export async function markEftReconciled'),
)
const RECON = SRC.slice(
  SRC.indexOf('export async function markEftReconciled'),
  SRC.indexOf('export async function markAccessoriesCollected'),
)

test('present acts ONLY on a collected vendor (money in, not yet paid)', () => {
  assert.match(PRESENT, /status !== 'collected'/)
})

test('present reaches paid-Yoco through the single settlement authority, vendor not re-notified', () => {
  assert.match(PRESENT, /confirmPayment\(/)
  assert.match(PRESENT, /method: 'yoco'/)
  assert.match(PRESENT, /notifyVendor: false/)
})

test('present stamps the present marker + the reused YAH- reference', () => {
  assert.match(PRESENT, /const reference = paymentReference\(applicationId\)/)
  assert.match(PRESENT, /presented_eft:/)
})

test('mark-reconciled is owner-inert: guards on presented_eft, only stamps reconciled_at', () => {
  assert.match(RECON, /presented_eft/)
  assert.match(RECON, /reconciled_at: new Date/)
  // The tracking flag must never touch the paid transition or the method.
  assert.equal(/confirmPayment|paid_at:|method:/.test(RECON), false)
})

test('a presented vendor keeps comms on the master lane until reconciled (roster still paid)', () => {
  const paid = { status: 'paid', method: 'yoco', paid_at: '2026-08-23T00:00:00Z' }
  const at = '2026-08-23T00:00:00Z'
  // plain paid-Yoco (not presented) is hers
  assert.equal(vendorInOwnerScope(withPayment(paid), at), true)
  // presented, not yet reconciled => comms route to the master lane
  assert.equal(vendorInOwnerScope(withPayment({ ...paid, presented_eft: { at, reference: 'YAH-1' } }), at), false)
  // reconciled => comms hand over to the owner
  assert.equal(vendorInOwnerScope(withPayment({ ...paid, presented_eft: { at, reference: 'YAH-1' }, reconciled_at: '2026-08-23T01:00:00Z' }), at), true)
})
