import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  rosterPaymentStatus,
  teamPaidRecord,
  vendorInOwnerScope,
  withTeamPaid,
} from './eft'
import { parsePortalState, updatePortalStateImpl } from './portal-state'

test('withTeamPaid round-trips and replaces the previous marker', () => {
  const first = withTeamPaid('Human note.', {
    amount: 1200,
    method: 'eft',
    at: '2026-10-13T08:00:00.000Z',
  })

  assert.deepEqual(teamPaidRecord(first), {
    amount: 1200,
    method: 'eft',
    at: '2026-10-13T08:00:00.000Z',
  })

  const replaced = withTeamPaid(first, {
    amount: 2400,
    method: 'cash',
    at: '2026-10-13T09:00:00.000Z',
  })

  assert.equal((replaced.match(/⟦TEAMPAID:/g) || []).length, 1)
  assert.deepEqual(teamPaidRecord(replaced), {
    amount: 2400,
    method: 'cash',
    at: '2026-10-13T09:00:00.000Z',
  })
  assert.match(replaced, /Human note\./)
})

test('team paid is display-only and does not move the owner wall', () => {
  let notes = updatePortalStateImpl('Master lane.', {
    ...parsePortalState('Master lane.'),
    v: 1,
    payment: { status: 'collected' },
  })
  notes = withTeamPaid(notes, {
    amount: 1200,
    method: 'eft',
    at: '2026-10-13T08:00:00.000Z',
  })

  assert.equal(rosterPaymentStatus(notes, null, 'abdusamee@example.com'), 'paid')
  assert.equal(vendorInOwnerScope(notes, null), false)
})
