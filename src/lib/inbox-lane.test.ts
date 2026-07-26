// Runs under `npm test` (node --import tsx --test 'src/**/!(*.eval).test.ts').
//
// The risk this covers: the unified inbox filters the thread LIST, but ~11 other
// admin endpoints read message content by a caller-supplied phone / email /
// application id. If the scope disagrees with the list filter by even one shape,
// the festival owner can reach an EFT-lane vendor's messages by direct API call.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildLaneScope, phoneKey, hidesEftContent, stripEftMessages, type LaneVendorRow } from './inbox-lane'
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

// Rewritten 2026-07-26: the scope now blocks every vendor the festival owner does
// NOT own, which is every unpaid one plus anyone settled by EFT or manual card.
const paidVia = (method: string) =>
  updatePortalStateImpl('note', { v: 1, payment: { status: 'paid', method } as never })

test('the owner can only reach vendors who paid through HER channel', () => {
  const visible = [
    v({ id: 'yoco', admin_notes: paidVia('yoco'), email: 'yoco@x.co', phone: '0111111111' }),
    v({ id: 'cash', admin_notes: paidVia('cash'), email: 'cash@x.co', phone: '0222222222' }),
    // Legacy paid row: no method recorded (20 of 47 live rows), must stay reachable.
    v({ id: 'legacy', paid_at: '2026-07-19T00:00:00Z', email: 'legacy@x.co', phone: '0333333333' }),
  ]
  const s = buildLaneScope(visible, true, false)
  for (const r of visible) {
    assert.equal(s.blocksApplicationId(r.id), false, `${r.id} must be reachable`)
    assert.equal(s.blocksEmail(r.email), false, `${r.id} email must be reachable`)
    assert.equal(s.blocksPhone(r.phone), false, `${r.id} phone must be reachable`)
  }
})

test('everyone else is blocked — unpaid, EFT-settled, and ⟦NOEFT⟧-but-unpaid alike', () => {
  const blocked = [
    v({ id: 'unpaid', email: 'unpaid@x.co', phone: '0111111111' }),
    v({ id: 'eft-lane', admin_notes: '⟦EFT⟧', email: 'lane@x.co', phone: '0222222222' }),
    // Settled by EFT: used to become hers the moment paid_at was written.
    v({ id: 'eft-paid', admin_notes: paidVia('eft'), paid_at: '2026-07-19T00:00:00Z', email: 'eftpaid@x.co', phone: '0333333333' }),
    // Excluded from the EFT lane is NOT the same as having paid.
    v({ id: 'noeft', admin_notes: withNoEftMarker('note'), email: 'noeft@x.co', phone: '0444444444' }),
    v({ id: 'collected', admin_notes: updatePortalStateImpl('note', { v: 1, payment: { status: 'collected' } }), email: 'coll@x.co', phone: '0555555555' }),
  ]
  const s = buildLaneScope(blocked, true, false)
  for (const r of blocked) {
    assert.equal(s.blocksApplicationId(r.id), true, `${r.id} must be blocked`)
    assert.equal(s.blocksEmail(r.email), true, `${r.id} email must be blocked`)
    assert.equal(s.blocksPhone(r.phone), true, `${r.id} phone must be blocked`)
  }
  // Global mode no longer changes this: unpaid is unpaid either way.
  assert.equal(buildLaneScope([v()], false, false).blocksApplicationId('id-1'), true)
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

// ── CONTENT-level wall (2026-07-26) ─────────────────────────────────────────
// The rule moved from per-vendor to per-content: any admin may open any vendor's
// thread, and only the messages that talk about EFT are withheld. These assert
// the read side matches the alert side (both use mentionsEft), because a
// mismatch means the festival owner gets pinged about a thread she then cannot
// open — or worse, opens one she should not see.

test('hidesEftContent: only the EFT admin sees EFT messages', () => {
  assert.equal(hidesEftContent('dev@cthalaal.co.za'), false)
  assert.equal(hidesEftContent('capetownhalaal@gmail.com'), true)
  assert.equal(hidesEftContent(null), true, 'unknown viewer must not see EFT content')
})

test('stripEftMessages drops only the EFT messages, keeping the rest of the thread', () => {
  const msgs = [
    { body: 'Hi, what time is setup on Saturday?' },
    { body: 'I did the EFT this morning, proof attached.' },
    { body: 'Also can I get a second staff badge?' },
    { body: 'Please confirm the bank transfer went through' },
    { body: 'Thanks!' },
  ]
  const visible = stripEftMessages(msgs, (m) => m.body, true)
  assert.deepEqual(
    visible.map((m) => m.body),
    ['Hi, what time is setup on Saturday?', 'Also can I get a second staff badge?', 'Thanks!'],
    'ordinary questions from an EFT vendor stay visible; only EFT talk is withheld',
  )
  // The EFT admin sees the whole conversation.
  assert.equal(stripEftMessages(msgs, (m) => m.body, false).length, 5)
})

test('stripEftMessages: the phrases that count, and safe handling of empty bodies', () => {
  const hidden = ['EFT sent', 'bank transfer done', 'proof of payment attached']
  for (const body of hidden) {
    assert.equal(stripEftMessages([{ body }], (m) => m.body, true).length, 0, `"${body}" must be withheld`)
  }
  // A media-only message has no text — nothing to match, so it is not withheld
  // by this rule (the media route checks its caption and storage path instead).
  assert.equal(stripEftMessages([{ body: null }], (m) => m.body, true).length, 1)
  assert.equal(stripEftMessages(null, (m: { body: string }) => m.body, true).length, 0)
})
