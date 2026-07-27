import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupThreads, WAITING_CAP } from './thread-groups'
import type { ChannelThread } from './channel-threads'

/** A thread carrying only the three fields the grouping actually reads. */
function t(id: string, needs_response: boolean, unread = false): ChannelThread {
  return {
    id, channel: 'whatsapp', peer_name: null, business_name: null, phone: null,
    email: null, application_id: null, subject: null, last_message_at: null,
    last_preview: null, last_direction: null, unread, needs_response,
    bot_paused: false, starred: false, is_vendor: false,
  }
}

/** The production shape: sortPinned has already put every pin at the front. */
function pinnedFirst(waiting: number, answered: number): ChannelThread[] {
  return [
    ...Array.from({ length: waiting }, (_, i) => t(`w${i}`, true)),
    ...Array.from({ length: answered }, (_, i) => t(`a${i}`, false)),
  ]
}

const ids = (rows: ChannelThread[]) => rows.map((r) => r.id)

// ---------------------------------------------------------------------------
// The reported bug, as an assertion.
//
// Gmail on 2026-07-28: All 50, Waiting 31, and the two tabs rendered an
// identical screen because sortPinned made Waiting a prefix of All. This test
// fails if that ever comes back.
// ---------------------------------------------------------------------------

test('All and Waiting do not render the same rows', () => {
  const threads = pinnedFirst(31, 19)
  const all = groupThreads(threads, 'all')
  const waiting = groupThreads(threads, 'waiting')

  assert.notDeepEqual(
    ids([...all.waitingRows, ...all.answered]).slice(0, 10),
    ids([...waiting.waitingRows, ...waiting.answered]).slice(0, 10),
    'the first screenful of All must differ from Waiting',
  )
})

test('All caps the waiting run and reports the remainder', () => {
  const g = groupThreads(pinnedFirst(31, 19), 'all')
  assert.equal(g.waitingRows.length, WAITING_CAP)
  assert.equal(g.hiddenWaiting, 31 - WAITING_CAP)
  assert.equal(g.waitingTotal, 31, 'the divider still names the true total')
  assert.equal(g.answered.length, 19)
})

test('answered threads are reachable in All without scrolling past every pin', () => {
  // The whole point of the cap: 19 answered threads sat below 31 pins, so the
  // "Answered" divider was permanently below the fold.
  const g = groupThreads(pinnedFirst(31, 19), 'all')
  assert.ok(g.waitingRows.length + 1 < 10, 'answered starts within the first screen')
})

test('Waiting shows every pin, uncapped', () => {
  const g = groupThreads(pinnedFirst(31, 19), 'waiting')
  assert.equal(g.waitingRows.length, 31)
  assert.equal(g.hiddenWaiting, 0)
  assert.equal(g.answered.length, 0)
})

test('Unread keeps both groups so its dividers still mean something', () => {
  const threads = [t('w0', true, true), t('w1', true, false), t('a0', false, true)]
  const g = groupThreads(threads, 'unread')
  assert.deepEqual(ids(g.waitingRows), ['w0'])
  assert.deepEqual(ids(g.answered), ['a0'])
  assert.equal(g.total, 2)
})

test('a short waiting run is not capped, so nothing is hidden needlessly', () => {
  const g = groupThreads(pinnedFirst(WAITING_CAP, 5), 'all')
  assert.equal(g.hiddenWaiting, 0)
  assert.equal(g.waitingRows.length, WAITING_CAP)
})

test('empty in means empty out, not a crash', () => {
  for (const f of ['all', 'waiting', 'unread'] as const) {
    const g = groupThreads([], f)
    assert.equal(g.total, 0)
    assert.equal(g.hiddenWaiting, 0)
  }
})

// ---------------------------------------------------------------------------
// The tabs added for #16 and #17.
// ---------------------------------------------------------------------------

function tagged(id: string, o: Partial<ChannelThread>): ChannelThread {
  return { ...t(id, false), ...o }
}

test('Starred keeps only starred threads, waiting or not', () => {
  const rows = [
    tagged('a', { starred: true, needs_response: true }),
    tagged('b', { starred: true }),
    tagged('c', { starred: false }),
  ]
  const g = groupThreads(rows, 'starred')
  assert.equal(g.total, 2)
  assert.deepEqual([...g.waitingRows, ...g.answered].map((r) => r.id).sort(), ['a', 'b'])
})

test('Vendors and People partition the list with nothing lost', () => {
  const rows = [
    tagged('vendor-approved', { is_vendor: true }),
    tagged('vendor-unapproved', { is_vendor: true }),
    tagged('supplier', { is_vendor: false }),
    tagged('press', { is_vendor: false }),
  ]
  const v = groupThreads(rows, 'vendors')
  const p = groupThreads(rows, 'people')
  assert.equal(v.total, 2)
  assert.equal(p.total, 2)
  // A partition: every thread lands in exactly one of the two, so switching
  // between them can never hide a conversation from both.
  assert.equal(v.total + p.total, rows.length)
})

test('the Vendors tab includes UNAPPROVED applicants', () => {
  // Taona: "vendors (which includes approved and unapprovd) and generic people".
  // is_vendor is deliberately not an approval test.
  const g = groupThreads([tagged('pending-applicant', { is_vendor: true })], 'vendors')
  assert.equal(g.total, 1)
})
