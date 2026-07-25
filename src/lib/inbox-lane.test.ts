// Runs under `npm test` (node --import tsx --test 'src/**/!(*.eval).test.ts').
//
// The risk this covers: the unified inbox filters the thread LIST, but ~11 other
// admin endpoints read message content by a caller-supplied phone / email /
// application id. If the scope disagrees with the list filter by even one shape,
// the festival owner can reach an EFT-lane vendor's messages by direct API call.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildLaneScope, phoneKey, type LaneVendorRow } from './inbox-lane'
import { updatePortalStateImpl } from './portal-state'
import { withNoEftMarker } from './eft'

const v = (o: Partial<LaneVendorRow> = {}): LaneVendorRow =>
  ({ id: 'id-1', phone: '0760712578', email: 'chef@vendor.co.za', admin_notes: null, paid_at: null, ...o })

test('phoneKey collapses every ZA format to the same 9-digit subscriber key', () => {
  assert.equal(phoneKey('+27760712578'), '760712578')
  assert.equal(phoneKey('0760712578'), '760712578')
  assert.equal(phoneKey('+27 76 071 2578'), '760712578')
  assert.equal(phoneKey(null), '')
})

test('an EFT-lane vendor is blocked by phone, email AND application id', () => {
  const s = buildLaneScope([v({ admin_notes: '⟦EFT⟧' })], false, false)
  assert.equal(s.blocksApplicationId('id-1'), true)
  assert.equal(s.blocksEmail('chef@vendor.co.za'), true)
  assert.equal(s.blocksEmail('CHEF@VENDOR.CO.ZA'), true, 'email match is case-insensitive')
  // Stored local-format, requested E.164 — the join that leaked in 09ced95.
  assert.equal(s.blocksPhone('+27760712578'), true)
  assert.equal(s.blocksPhone('0760712578'), true)
  // A crafted request pairing a benign email with the lane vendor's phone.
  assert.equal(s.blocks({ email: 'someone@else.com', phone: '+27760712578' }), true)
})

test('the owner KEEPS every vendor who is not on the lane', () => {
  const rows = [
    v({ id: 'paid', admin_notes: '⟦EFT⟧', paid_at: '2026-07-19T00:00:00Z', email: 'paid@x.co', phone: '0111111111' }),
    v({ id: 'noeft', admin_notes: withNoEftMarker('note'), email: 'noeft@x.co', phone: '0222222222' }),
    v({ id: 'internal', admin_notes: '⟦EFT⟧', email: 'samreenkumandan1@gmail.com', phone: '0723803393' }),
  ]
  const s = buildLaneScope(rows, true, false) // global mode ON — still not blocked
  for (const r of rows) {
    assert.equal(s.blocksApplicationId(r.id), false, `${r.id} must stay visible`)
    assert.equal(s.blocksEmail(r.email), false, `${r.id} email must stay visible`)
    assert.equal(s.blocksPhone(r.phone), false, `${r.id} phone must stay visible`)
  }
})

test("'collected' stays hidden, and global mode sweeps unmarked unpaid vendors", () => {
  const collected = updatePortalStateImpl('note', { v: 1, payment: { status: 'collected' } })
  assert.equal(buildLaneScope([v({ admin_notes: collected })], true, false).blocksApplicationId('id-1'), true)
  // Unmarked + unpaid: swept while global is on, released when it goes off.
  assert.equal(buildLaneScope([v()], true, false).blocksApplicationId('id-1'), true)
  assert.equal(buildLaneScope([v()], false, false).blocksApplicationId('id-1'), false)
})

test('a WhatsApp-verified alternate number is blocked too', () => {
  // Threads arrive on the ⟦WAV…⟧ alternate, which is not the `phone` column.
  const s = buildLaneScope([v({ admin_notes: '⟦EFT⟧ ⟦WAV27831234567⟧' })], false, false)
  assert.equal(s.blocksPhone('+27831234567'), true)
  assert.equal(s.blocksPhone('0831234567'), true)
})

test('the EFT admin is unrestricted', () => {
  const s = buildLaneScope([v({ admin_notes: '⟦EFT⟧' })], true, true)
  assert.equal(s.unrestricted, true)
  assert.equal(s.blocksApplicationId('id-1'), false)
  assert.equal(s.blocks({ phone: '+27760712578', email: 'chef@vendor.co.za' }), false)
})

test('unknown identifiers are never blocked (fail-open on non-vendors)', () => {
  const s = buildLaneScope([v({ admin_notes: '⟦EFT⟧' })], false, false)
  assert.equal(s.blocksPhone('+27999999999'), false)
  assert.equal(s.blocksEmail('stranger@nowhere.com'), false)
  assert.equal(s.blocks({}), false)
  assert.equal(s.blocksPhone(null), false)
  assert.equal(s.blocksEmail(''), false)
})
