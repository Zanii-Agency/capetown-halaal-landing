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

// ── Master EFT lane exclusion (Taona 2026-09-02) ────────────────────────────
// A lane vendor shows unpaid to Samreen but is chased by the EFT admin from the
// Outreach tab, so the generic pay reminder must skip them. laneHas is the gate.

test('lane: an ⟦EFT⟧-marked vendor is excluded from the pay reminder (but not hard-settled)', () => {
  const eft: ChaseRow = { phone: '0830000001', email: 'eft@x.com', admin_notes: '⟦EFT⟧' }
  const idx = buildSuppressedPeople([eft], NOW)
  assert.equal(idx.laneHas(eft), true, 'on the master lane: no pay email')
  assert.equal(idx.hardHas(eft), false, 'not settled, just handled off-cron')
})

test('lane: a plain unpaid vendor never touched EFT, so is NOT on the lane (still chased)', () => {
  // The 2026-09-02 correction: a merely-unpaid applicant is not the EFT lane. If
  // this returns true again, the pay-reminder cron goes silent for ~130 vendors
  // and the Outreach audience balloons to ~170.
  const unpaid: ChaseRow = { phone: '0830000002', email: 'unpaid@x.com', admin_notes: pay({ status: 'none' }) }
  assert.equal(buildSuppressedPeople([unpaid], NOW).laneHas(unpaid), false)
})

test('lane: a collected-EFT vendor is excluded via HARD suppression (hasPaid), not laneHas', () => {
  // 'collected' counts as paid, so the cron drops it at hardHas before laneHas
  // runs. Either way it never gets a pay reminder. laneHas is for lane vendors who
  // are NOT yet hard-settled (below).
  const collected: ChaseRow = { phone: '0830000007', email: 'collected@x.com', admin_notes: pay({ status: 'collected', amount: 6500 }) }
  assert.equal(buildSuppressedPeople([collected], NOW).hardHas(collected), true)
})

test('lane: a proof-uploaded, not-yet-collected vendor IS caught by laneHas', () => {
  // status still unpaid but a POP is in: hardHas is false, so laneHas is what keeps
  // the pay reminder off them.
  const submitted: ChaseRow = { phone: '0830000008', email: 'pop@x.com', admin_notes: pay({ status: 'pending', eft_submitted_at: '2026-08-20T10:00:00Z' }) }
  const idx = buildSuppressedPeople([submitted], NOW)
  assert.equal(idx.hardHas(submitted), false)
  assert.equal(idx.laneHas(submitted), true)
})

test('lane: a ⟦NOEFT⟧ unpaid vendor is Samreen\'s and stays chaseable', () => {
  const hers: ChaseRow = { phone: '0830000003', email: 'hers@x.com', admin_notes: '⟦NOEFT⟧' }
  assert.equal(buildSuppressedPeople([hers], NOW).laneHas(hers), false)
})

test('lane: a Yoco-settled vendor is off the lane', () => {
  const paid: ChaseRow = { phone: '0830000004', admin_notes: pay({ status: 'paid', method: 'yoco' }), paid_at: '2026-08-01T00:00:00Z' }
  assert.equal(buildSuppressedPeople([paid], NOW).laneHas(paid), false)
})

test('lane person-level: an ⟦EFT⟧ row excludes a ⟦NOEFT⟧ twin that alone would be chased', () => {
  const laneRow: ChaseRow = { phone: '0830000006', email: 'a2@x.com', admin_notes: '⟦EFT⟧' }
  const noeftTwin: ChaseRow = { phone: '0830000006', email: 'b2@x.com', admin_notes: '⟦NOEFT⟧' }
  const idx = buildSuppressedPeople([laneRow, noeftTwin], NOW)
  // The NOEFT twin alone is hers (laneHas false), but sharing a phone with an
  // EFT-lane row puts the PERSON on the lane: do not pay-email them.
  assert.equal(idx.laneHas(noeftTwin), true)
})
