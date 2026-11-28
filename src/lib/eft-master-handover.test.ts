import { test } from 'node:test'
import assert from 'node:assert/strict'
import { masterProofHandedToOwner, eftProofVisibleToOwner } from './eft'
import { updatePortalStateImpl } from './portal-state'

const fullEft = { startedAt: '2026-08-31T00:00:00Z', protectedIds: new Set(['frozen-1']) }
const withProof = (account?: 'master' | 'samreen') =>
  updatePortalStateImpl('', { payment: { eft_submitted_at: '2026-10-01T10:00:00Z', proofs: [{ kind: 'eft_submission', path: 'p/x.png', uploaded_at: '2026-10-01T10:00:00Z', account }] } } as never)

test('master-stamped proof: fenced from owner, handed to her as a row', () => {
  const n = withProof('master')
  assert.equal(eftProofVisibleToOwner('v1', n, fullEft), false)
  assert.equal(masterProofHandedToOwner('v1', n, fullEft), true)
})

test('frozen cohort vendor is handed over', () => {
  assert.equal(masterProofHandedToOwner('frozen-1', withProof(), fullEft), true)
})

test('already-visible proof is not double-listed as handed', () => {
  const n = withProof('samreen')
  assert.equal(eftProofVisibleToOwner('v2', n, fullEft), true)
  assert.equal(masterProofHandedToOwner('v2', n, fullEft), false)
})

test('no proof, nothing handed', () => {
  assert.equal(masterProofHandedToOwner('v3', '', fullEft), false)
})
