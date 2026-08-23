import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { vendorInOwnerScope, vendorCommsInOwnerScope, rosterPaid } from '@/lib/eft'

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

test('a presented vendor stays paid + operationally visible, but comms route to master until reconciled', () => {
  const paid = { status: 'paid', method: 'yoco', paid_at: '2026-08-23T00:00:00Z' }
  const at = '2026-08-23T00:00:00Z'
  const presented = withPayment({ ...paid, presented_eft: { at, reference: 'YAH-1' } })
  const reconciled = withPayment({ ...paid, presented_eft: { at, reference: 'YAH-1' }, reconciled_at: '2026-08-23T01:00:00Z' })
  // Operational visibility (roster / stalls / finance) is UNCHANGED: she still sees paid.
  assert.equal(vendorInOwnerScope(presented, at), true)
  assert.equal(rosterPaid(presented, at), true)
  // But COMMS route to the master lane until the operator reconciles.
  assert.equal(vendorCommsInOwnerScope(presented, at), false)
  assert.equal(vendorCommsInOwnerScope(reconciled, at), true)
  // A plain paid-Yoco vendor (not presented) is fully hers, comms included.
  assert.equal(vendorCommsInOwnerScope(withPayment(paid), at), true)
})
