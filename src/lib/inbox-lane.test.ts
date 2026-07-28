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
    // ⟦NOEFT⟧ moved OUT of this list on 2026-07-28: excluded from EFT now means
    // hers ("If excluded on master lane, it belongs to samreen"). It has its own
    // test below. A ⟦NOEFT⟧ vendor who HAS touched EFT still belongs here, which
    // the next case covers.
    v({ id: 'noeft-but-collected', admin_notes: withNoEftMarker(updatePortalStateImpl('note', { v: 1, payment: { status: 'collected' } })), email: 'noeftcoll@x.co', phone: '0444444444' }),
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

test('the EFT wall must inspect every field that can carry message text', () => {
  // Regression guard for the messages route. Its accessor read `m.body` alone,
  // which was complete until bodyHtml existed. A real HTML email can have an
  // empty or innocuous plain-text part while the HTML says "I sent the EFT" —
  // that message must not reach the festival owner just because the column the
  // filter happened to read was clean.
  const accessor = (m: { body?: string; subject?: string; bodyHtml?: string }) =>
    [m.body, m.subject, m.bodyHtml].filter(Boolean).join(' ')

  const hidden = [
    { body: '', subject: 'Payment', bodyHtml: '<p>I sent the EFT this morning</p>' },
    { body: 'See attached', subject: 'proof of payment', bodyHtml: '<p>hi</p>' },
    { body: 'done', subject: '', bodyHtml: '<div>bank transfer reference 123</div>' },
  ]
  for (const m of hidden) {
    assert.equal(stripEftMessages([m], accessor, true).length, 0, `must withhold: ${JSON.stringify(m)}`)
  }

  // An ordinary email with none of it stays visible.
  assert.equal(
    stripEftMessages([{ body: 'What time is setup?', subject: 'Saturday', bodyHtml: '<p>Thanks</p>' }], accessor, true).length,
    1,
  )
})

// ---------------------------------------------------------------------------
// The status rule, pinned in BOTH directions.
//
// buildLaneScope's `if (r.status && r.status !== 'approved') continue` looks
// like a missing-null-check, and on 2026-07-28 an analysis agent recommended
// rewriting it to `(r.status || 'pending')`. That opens the wall: a NULL-status
// ⟦EFT⟧ vendor would take the `continue` and never be blocked. These two tests
// exist so that proposal fails by NAME rather than by a puzzling assertion in
// an unrelated test.
// ---------------------------------------------------------------------------

test('a REAL unapproved applicant is visible to the owner (the intended widening)', () => {
  // Schema default, and what the public insert actually produces.
  for (const status of ['pending', 'info_requested', 'rejected']) {
    const s = buildLaneScope([v({ id: `app-${status}`, status })], true, false)
    assert.equal(s.blocksApplicationId(`app-${status}`), false, `${status} must reach her`)
    assert.equal(s.blocksEmail('chef@vendor.co.za'), false, `${status} email must reach her`)
  }
})

test('an UNCLASSIFIABLE row fails CLOSED, even carrying ⟦EFT⟧', () => {
  // status NULL is not "a pending applicant", it is a row nobody can classify.
  // Defaulting it to 'pending' would hand this vendor's payment thread to the
  // festival owner, which is the exact breach this module prevents.
  for (const status of [null, undefined]) {
    const s = buildLaneScope([v({ id: 'unknown', status: status as never, admin_notes: '⟦EFT⟧' })], true, false)
    assert.equal(s.blocksApplicationId('unknown'), true, `status=${status} must stay blocked`)
    assert.equal(s.blocksEmail('chef@vendor.co.za'), true, `status=${status} email must stay blocked`)
    assert.equal(s.blocksPhone('0760712578'), true, `status=${status} phone must stay blocked`)
  }
})

test('an APPROVED unpaid vendor stays blocked regardless of status widening', () => {
  const s = buildLaneScope([v({ id: 'appr', status: 'approved' })], true, false)
  assert.equal(s.blocksApplicationId('appr'), true)
})

test('a ⟦NOEFT⟧ vendor untouched by EFT reaches the festival owner', () => {
  // Taona 2026-07-28: "If excluded on master lane, it belongs to samreen."
  // Telkom, Treacle and Tart, Islamic Relief SA and Call-A-Braai were in this
  // state when the rule changed.
  const s = buildLaneScope([v({ id: 'noeft', admin_notes: withNoEftMarker('note') })], true, false)
  assert.equal(s.blocksApplicationId('noeft'), false, 'excluded-from-EFT is hers')
  assert.equal(s.blocksEmail('chef@vendor.co.za'), false, 'and by email')
  assert.equal(s.blocksPhone('0760712578'), false, 'and by phone')
})
