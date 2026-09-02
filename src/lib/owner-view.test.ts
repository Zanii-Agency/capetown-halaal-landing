import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ownerCutoff, withOwnerCutoff, withoutOwnerCutoff, hiddenByCutoff, applyOwnerCutoff,
} from './owner-view'

const CUT = '2026-07-28T04:32:15.000Z'

test('the cutoff round-trips and is removable', () => {
  const n = withOwnerCutoff('some prose', CUT)
  assert.equal(ownerCutoff(n), CUT)
  assert.equal(ownerCutoff(withoutOwnerCutoff(n)), null)
})

test('setting a cutoff preserves every other marker and the prose', () => {
  // admin_notes is shared by ⟦EFT⟧, ⟦STALL⟧, ⟦PORTAL⟧, ⟦OWNERVIS⟧ and human
  // notes. Clobbering any of them here would be a far worse bug than the one
  // this feature fixes.
  const before = '⟦APPROVED_NOTIFIED:2026-06-27T19:51:45.985Z⟧ Priority vendor. ⟦STALL:FS12⟧ ⟦PORTAL:eyJ2IjoxfQ==⟧ ⟦OWNERVIS⟧'
  const after = withOwnerCutoff(before, CUT)
  for (const marker of ['⟦APPROVED_NOTIFIED:', '⟦STALL:FS12⟧', '⟦PORTAL:eyJ2IjoxfQ==⟧', '⟦OWNERVIS⟧', 'Priority vendor.']) {
    assert.ok(after.includes(marker), `lost ${marker}`)
  }
  assert.equal(ownerCutoff(after), CUT)
})

test('re-setting replaces rather than stacking', () => {
  const twice = withOwnerCutoff(withOwnerCutoff('note', CUT), '2026-07-29T00:00:00.000Z')
  assert.equal((twice.match(/⟦OWNERCUT:/g) || []).length, 1)
  assert.equal(ownerCutoff(twice), '2026-07-29T00:00:00.000Z')
})

test('messages before the cutoff are shown, at-or-after are withheld', () => {
  assert.equal(hiddenByCutoff('2026-07-28T04:32:14.000Z', CUT), false, 'one second before')
  // At the cutoff is withheld: that is the real confirmation being replaced.
  assert.equal(hiddenByCutoff(CUT, CUT), true, 'exactly at')
  assert.equal(hiddenByCutoff('2026-07-28T04:32:16.000Z', CUT), true, 'after')
})

test('anything the vendor sends LATER is withheld automatically', () => {
  // The requirement: "any further coms will show only to master lane". Time-based
  // means nobody has to remember to add new message ids to a list.
  assert.equal(hiddenByCutoff('2026-08-15T09:00:00.000Z', CUT), true)
})

test('the EFT admin sees everything, cutoff or not', () => {
  const msgs = [{ at: '2026-07-01T00:00:00Z' }, { at: '2026-08-01T00:00:00Z' }]
  assert.equal(applyOwnerCutoff(msgs, (m) => m.at, CUT, false).length, 2)
})

test('a scoped viewer sees only what precedes the cutoff', () => {
  const msgs = [
    { id: 'old', at: '2026-07-01T00:00:00Z' },
    { id: 'confirmation', at: CUT },
    { id: 'later', at: '2026-08-01T00:00:00Z' },
  ]
  const seen = applyOwnerCutoff(msgs, (m) => m.at, CUT, true)
  assert.deepEqual(seen.map((m) => m.id), ['old'])
})

test('no cutoff means no filtering at all', () => {
  const msgs = [{ at: '2026-08-01T00:00:00Z' }]
  assert.equal(applyOwnerCutoff(msgs, (m) => m.at, null, true).length, 1)
})

test('unparseable timestamps are never hidden by accident', () => {
  // Failing open here is right: hiding a message because its date did not parse
  // would silently drop real conversation from her inbox.
  assert.equal(hiddenByCutoff('not a date', CUT), false)
  assert.equal(hiddenByCutoff(null, CUT), false)
  assert.equal(ownerCutoff('⟦OWNERCUT:garbage⟧'), null)
})
