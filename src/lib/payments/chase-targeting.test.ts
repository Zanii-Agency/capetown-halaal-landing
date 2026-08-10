// Person-level suppression + send de-dup. Each case is a real vendor who was
// wrongly chased on 2026-08-10 because the decision was made per application
// ROW instead of per person.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSuppressedPeople, newSendDeduper, type ChaseRow } from './chase-targeting'

// Encode a portal state into an admin_notes marker exactly as portal-state does.
const notes = (payment: Record<string, unknown>): string =>
  '⟦PORTAL:' + Buffer.from(JSON.stringify({ v: 1, payment })).toString('base64') + '⟧'

const NOW = new Date('2026-08-10T10:00:00Z')

test('Melonscape: a collected row suppresses the empty twin on the same phone', () => {
  const paidTwin: ChaseRow = { phone: '0769157856', email: 'rabiamocho@gmail.com', admin_notes: notes({ status: 'collected', amount: 3700 }) }
  const emptyTwin: ChaseRow = { phone: '0769157856', email: 'adnanc2008@gmail.com', admin_notes: '' }
  const idx = buildSuppressedPeople([paidTwin, emptyTwin], NOW)
  assert.equal(idx.has(emptyTwin), true, 'empty twin must be suppressed by the paid twin (shared phone)')
  assert.equal(idx.has(paidTwin), true)
})

test('Chocotag: a paid_at DB column suppresses the empty twin even without a portal marker', () => {
  const paidTwin: ChaseRow = { phone: '0685054510', email: 'a@x.com', admin_notes: '', paid_at: '2026-08-08T22:11:08Z' }
  const emptyTwin: ChaseRow = { phone: '0685054510', email: 'b@x.com', admin_notes: '' }
  const idx = buildSuppressedPeople([paidTwin, emptyTwin], NOW)
  assert.equal(idx.has(emptyTwin), true)
})

test('a genuinely unpaid solo vendor is NOT suppressed', () => {
  const solo: ChaseRow = { phone: '0820000001', email: 'solo@x.com', admin_notes: notes({ status: 'none' }) }
  const idx = buildSuppressedPeople([solo], NOW)
  assert.equal(idx.has(solo), false)
})

test('different people are not cross-suppressed', () => {
  const paid: ChaseRow = { phone: '0820000002', email: 'paid@x.com', admin_notes: notes({ status: 'paid' }) }
  const other: ChaseRow = { phone: '0820000003', email: 'other@x.com', admin_notes: '' }
  const idx = buildSuppressedPeople([paid, other], NOW)
  assert.equal(idx.has(other), false)
})

test('a lapsed deferral no longer suppresses; an in-force one does', () => {
  const lapsed: ChaseRow = { phone: '0820000004', admin_notes: notes({ status: 'deferred', arrangement: { until: '2026-07-01' } }) }
  const inForce: ChaseRow = { phone: '0820000005', admin_notes: notes({ status: 'deferred', arrangement: { until: '2026-08-31' } }) }
  const idx = buildSuppressedPeople([lapsed, inForce], NOW)
  assert.equal(idx.has(lapsed), false, 'deferral ended 2026-07-01, chaseable again')
  assert.equal(idx.has(inForce), true, 'deferral until 2026-08-31 still holds')
})

test('send de-dup: a person with two unpaid rows is claimed once', () => {
  const rowA: ChaseRow = { phone: '0821111111', email: 'dup@x.com' }
  const rowB: ChaseRow = { phone: '0821111111', email: 'dup2@x.com' } // same phone, different email
  const dd = newSendDeduper()
  assert.equal(dd.claim(rowA), true, 'first row claims the person')
  assert.equal(dd.claim(rowB), false, 'second row for same phone is skipped')
})

test('send de-dup: distinct people each get claimed', () => {
  const dd = newSendDeduper()
  assert.equal(dd.claim({ phone: '0822222221' }), true)
  assert.equal(dd.claim({ phone: '0822222222' }), true)
})
