// Person-level targeting. Each case is a real vendor wrongly handled on
// 2026-08-10 because the decision was made per application ROW, not per person.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSuppressedPeople, newSendDeduper, type ChaseRow } from './chase-targeting'

// Encode a portal state into an admin_notes marker exactly as portal-state does.
const notes = (state: Record<string, unknown>): string =>
  '⟦PORTAL:' + Buffer.from(JSON.stringify({ v: 1, ...state })).toString('base64') + '⟧'
const pay = (payment: Record<string, unknown>) => notes({ payment })

const NOW = new Date('2026-08-10T10:00:00Z')

test('Melonscape: a collected row hard-suppresses the empty twin on the same phone', () => {
  const paidTwin: ChaseRow = { phone: '0769157856', email: 'rabiamocho@gmail.com', admin_notes: pay({ status: 'collected', amount: 3700 }) }
  const emptyTwin: ChaseRow = { phone: '0769157856', email: 'adnanc2008@gmail.com', admin_notes: '' }
  const idx = buildSuppressedPeople([paidTwin, emptyTwin], NOW)
  assert.equal(idx.hardHas(emptyTwin), true, 'empty twin suppressed by the paid twin (shared phone)')
  assert.equal(idx.hardHas(paidTwin), true)
})

test('Chocotag: a paid_at DB column hard-suppresses the empty twin even without a portal marker', () => {
  const paidTwin: ChaseRow = { phone: '0685054510', email: 'a@x.com', admin_notes: '', paid_at: '2026-08-08T22:11:08Z' }
  const emptyTwin: ChaseRow = { phone: '0685054510', email: 'b@x.com', admin_notes: '' }
  assert.equal(buildSuppressedPeople([paidTwin, emptyTwin], NOW).hardHas(emptyTwin), true)
})

test('a withdrawn row hard-suppresses the person', () => {
  const gone: ChaseRow = { phone: '0820000009', admin_notes: notes({ withdrawn: { at: '2026-08-08T00:00:00Z', by: null } }) }
  assert.equal(buildSuppressedPeople([gone], NOW).hardHas(gone), true)
})

test('a genuinely unpaid solo vendor is neither suppressed nor on an arrangement', () => {
  const solo: ChaseRow = { phone: '0820000001', email: 'solo@x.com', admin_notes: pay({ status: 'none' }) }
  const idx = buildSuppressedPeople([solo], NOW)
  assert.equal(idx.hardHas(solo), false)
  assert.equal(idx.arrangementFor(solo), null)
})

test('different people are not cross-suppressed', () => {
  const paid: ChaseRow = { phone: '0820000002', email: 'paid@x.com', admin_notes: pay({ status: 'paid' }) }
  const other: ChaseRow = { phone: '0820000003', email: 'other@x.com', admin_notes: '' }
  assert.equal(buildSuppressedPeople([paid, other], NOW).hardHas(other), false)
})

test('an in-force extension surfaces as an arrangement (gentle), NOT hard-suppression', () => {
  const ext: ChaseRow = { phone: '0820000005', admin_notes: pay({ status: 'deferred', arrangement: { until: '2026-08-31' } }) }
  const idx = buildSuppressedPeople([ext], NOW)
  assert.equal(idx.hardHas(ext), false, 'extension holders are still reminded, gently')
  assert.deepEqual(idx.arrangementFor(ext), { until: '2026-08-31' })
})

test('a lapsed extension is neither an arrangement nor suppression (chaseable again)', () => {
  const lapsed: ChaseRow = { phone: '0820000004', admin_notes: pay({ status: 'deferred', arrangement: { until: '2026-07-01' } }) }
  const idx = buildSuppressedPeople([lapsed], NOW)
  assert.equal(idx.hardHas(lapsed), false)
  assert.equal(idx.arrangementFor(lapsed), null)
})

test('send de-dup: a person with two unpaid rows is claimed once', () => {
  const rowA: ChaseRow = { phone: '0821111111', email: 'dup@x.com' }
  const rowB: ChaseRow = { phone: '0821111111', email: 'dup2@x.com' } // same phone, different email
  const dd = newSendDeduper()
  assert.equal(dd.claim(rowA), true)
  assert.equal(dd.claim(rowB), false)
})

test('send de-dup: distinct people each get claimed', () => {
  const dd = newSendDeduper()
  assert.equal(dd.claim({ phone: '0822222221' }), true)
  assert.equal(dd.claim({ phone: '0822222222' }), true)
})
