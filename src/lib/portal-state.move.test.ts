import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePortalState, updatePortalStateImpl, type PortalState } from './portal-state'

// The risk: writing a stallMoveRequest must not clobber the ⟦STALL:..⟧
// allocation marker, the human prose, or an existing stallChangeRequest. All
// three live in the same admin_notes string.
test('stallMoveRequest round-trips beside allocation + size request + prose', () => {
  // Start: human note + allocation marker + an existing SIZE request in PORTAL.
  let notes = 'Nice vendor, prioritise.\n\n⟦STALL:FS12⟧'
  notes = updatePortalStateImpl(notes, {
    ...parsePortalState(notes),
    stallChangeRequest: {
      requestedTier: 'marquee-full-double-6x3', currentTier: 'marquee-full-3x3',
      reason: 'need more room', status: 'pending', createdAt: '2026-06-29T00:00:00Z',
    },
  })

  // Add a POSITION request.
  const next: PortalState = {
    ...parsePortalState(notes),
    stallMoveRequest: {
      preferredZone: 'FS', details: 'corner near entrance',
      currentStall: 'FS12', status: 'pending', createdAt: '2026-06-29T01:00:00Z',
    },
  }
  notes = updatePortalStateImpl(notes, next)

  // Allocation marker + prose survive verbatim.
  assert.ok(notes.includes('⟦STALL:FS12⟧'), 'allocation marker preserved')
  assert.ok(notes.includes('Nice vendor, prioritise.'), 'human prose preserved')

  // Both requests parse back intact and independent.
  const parsed = parsePortalState(notes)
  assert.equal(parsed.stallChangeRequest?.requestedTier, 'marquee-full-double-6x3')
  assert.equal(parsed.stallChangeRequest?.status, 'pending')
  assert.equal(parsed.stallMoveRequest?.details, 'corner near entrance')
  assert.equal(parsed.stallMoveRequest?.preferredZone, 'FS')
  assert.equal(parsed.stallMoveRequest?.status, 'pending')

  // Approving the move flips only the move request, not the size request.
  const approved = updatePortalStateImpl(notes, {
    ...parsed,
    stallMoveRequest: { ...parsed.stallMoveRequest!, status: 'approved' },
  })
  const after = parsePortalState(approved)
  assert.equal(after.stallMoveRequest?.status, 'approved')
  assert.equal(after.stallChangeRequest?.status, 'pending', 'size request untouched')
  assert.ok(approved.includes('⟦STALL:FS12⟧'), 'allocation still intact after approve')
})
