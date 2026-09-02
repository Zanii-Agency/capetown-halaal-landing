// The risk: a merge marker that eats the other markers sharing admin_notes, or
// a lookup that forgets to skip subordinates. The second one is what broke a
// paid vendor's WhatsApp chat on 2026-07-26.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mergedInto, isMerged, withMergedMarker, withoutMergedMarker, emailKey, withoutMerged } from './merge'
import { hasEftMarker } from './eft'
import { parseAllocation } from './stalls'
import { updatePortalStateImpl, parsePortalState } from './portal-state'

const PRIMARY = '53a7e574-e91a-48fb-931b-034c32358d0e'

test('the marker round-trips and is idempotent', () => {
  const once = withMergedMarker('', PRIMARY)
  assert.equal(mergedInto(once), PRIMARY)
  assert.ok(isMerged(once))
  // Applying twice must not stack two markers.
  const twice = withMergedMarker(once, PRIMARY)
  assert.equal((twice.match(/⟦MERGED:/g) || []).length, 1)
  assert.equal(mergedInto(twice), PRIMARY)
  // Un-merging leaves nothing behind.
  assert.equal(withoutMergedMarker(twice), '')
  assert.equal(mergedInto(''), null)
  assert.equal(isMerged(null), false)
})

test('merging preserves prose, ⟦STALL⟧, ⟦EFT⟧ and ⟦PORTAL⟧', () => {
  // admin_notes is shared by every marker plus human prose — the whole reason
  // this is a marker and not a column (Doctrine Law 8, DDL blocked).
  let notes = 'Priority vendor, called twice.\n\n⟦STALL:FS12⟧\n\n⟦EFT⟧'
  notes = updatePortalStateImpl(notes, { ...parsePortalState(notes), v: 1, payment: { status: 'paid' } })

  const merged = withMergedMarker(notes, PRIMARY)
  assert.equal(mergedInto(merged), PRIMARY)
  assert.match(merged, /Priority vendor, called twice\./)
  assert.equal(parseAllocation(merged).stall, 'FS12')
  assert.ok(hasEftMarker(merged))
  assert.equal(parsePortalState(merged).payment?.status, 'paid')

  // And un-merging gives everything back untouched.
  const back = withoutMergedMarker(merged)
  assert.equal(mergedInto(back), null)
  assert.match(back, /Priority vendor, called twice\./)
  assert.equal(parseAllocation(back).stall, 'FS12')
  assert.ok(hasEftMarker(back))
})

test('withoutMerged drops subordinates and keeps the primary', () => {
  const rows = [
    { id: 'primary', admin_notes: '⟦EFT⟧' },
    { id: 'dupe', admin_notes: withMergedMarker('', PRIMARY) },
    { id: 'other', admin_notes: null },
  ]
  assert.deepEqual(withoutMerged(rows).map((r) => r.id), ['primary', 'other'])
  // THE regression this exists for: two rows on one email used to make the bot
  // answer "email_multiple" and refuse to verify a paid vendor. After the merge
  // exactly one row survives, so the lookup is unambiguous again.
  assert.equal(withoutMerged(rows).length, 2)
  assert.equal(withoutMerged([rows[0], rows[1]]).length, 1)
  assert.deepEqual(withoutMerged(null), [])
})

test('emailKey collapses the capitalisation that CAUSED these duplicates', () => {
  // Six of the seven live clusters differ only by case: Israarahman91@ vs
  // israarahman91@, Shamillasfashions@ vs shamillasfashions@.
  assert.equal(emailKey('Israarahman91@gmail.com'), 'israarahman91@gmail.com')
  assert.equal(emailKey('  Shamillasfashions@Gmail.com  '), 'shamillasfashions@gmail.com')
  assert.equal(emailKey('israarahman91@gmail.com'), emailKey('Israarahman91@gmail.com'))
  assert.equal(emailKey(null), '')
  assert.equal(emailKey(undefined), '')
})

test('a malformed marker is ignored rather than half-matched', () => {
  assert.equal(mergedInto('⟦MERGED:not-a-uuid⟧'), null)
  assert.equal(mergedInto('⟦MERGED:⟧'), null)
  assert.equal(mergedInto('MERGED:53a7e574-e91a-48fb-931b-034c32358d0e'), null, 'needs the brackets')
})
