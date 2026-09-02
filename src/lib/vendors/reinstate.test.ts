// Run: node --import tsx --test src/lib/vendors/reinstate.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reinstateApplication } from './withdraw'
import { updatePortalStateImpl, parsePortalState } from '@/lib/portal-state'

function fakeDb(row: unknown) {
  const calls: { update: Record<string, unknown> | null; insert: Record<string, unknown> | null } = { update: null, insert: null }
  const b: Record<string, unknown> = {
    select() { return b },
    eq() { return b },
    maybeSingle() { return Promise.resolve({ data: row }) },
    update(patch: Record<string, unknown>) { calls.update = patch; return { eq() { return Promise.resolve({ error: null }) } } },
    insert(r: Record<string, unknown>) { calls.insert = r; return Promise.resolve({ error: null }) },
  }
  return { db: { from() { return b } } as never, calls }
}

test('reinstate clears the withdrawn marker and restores approved status', async () => {
  const notes = updatePortalStateImpl('Priority vendor.\n⟦STALL:FS3⟧', { v: 1, withdrawn: { at: '2026-08-20T00:00:00Z', by: 'sam@x' }, payment: { status: 'none' } } as never)
  const { db, calls } = fakeDb({ id: 'v1', business_name: 'Test Co', status: 'rejected', admin_notes: notes })

  const out = await reinstateApplication(db, { applicationId: 'v1', actorEmail: 'sam@x' })

  assert.equal(out.ok, true)
  assert.equal(calls.update!.status, 'approved')                                   // back to approved
  assert.equal(parsePortalState(calls.update!.admin_notes as string).withdrawn, undefined) // marker gone
  assert.match(calls.update!.admin_notes as string, /Priority vendor/)             // prose preserved
  assert.match(calls.update!.admin_notes as string, /⟦STALL:FS3⟧/)                 // other markers untouched
  assert.equal(calls.insert!.event_type, 'vendor_reinstated')                      // audited
})

test('reinstate refuses a vendor that is not withdrawn', async () => {
  const notes = updatePortalStateImpl('note', { v: 1, payment: { status: 'paid' } } as never)
  const { db } = fakeDb({ id: 'v2', business_name: 'X', status: 'approved', admin_notes: notes })
  const out = await reinstateApplication(db, { applicationId: 'v2' })
  assert.equal(out.ok, false)
  assert.equal((out as { reason: string }).reason, 'not_withdrawn')
})

test('reinstate reports not_found for a missing vendor', async () => {
  const { db } = fakeDb(null)
  const out = await reinstateApplication(db, { applicationId: 'nope' })
  assert.equal(out.ok, false)
  assert.equal((out as { reason: string }).reason, 'not_found')
})
