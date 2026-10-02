// log_team_arrangement alert audience: a covert master-lane vendor's claimed
// arrangement (payment details) must never reach the festival owner (Law 2).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamArrangementAudience } from './registry'
import { onCovertMasterLane, withEftMarker, withOwnerVisibleMarker, withNewVendorMarker } from '@/lib/eft'

test('claimed-arrangement alert: covert vendors go to the master only, hers to everyone', () => {
  const frozen = { protectedIds: new Set(['f1']) }
  const aud = (id: string, notes: string, rail: 'master' | 'samreen_eft') => teamArrangementAudience(id, notes, rail, frozen, onCovertMasterLane)
  assert.equal(aud('x', withEftMarker(''), 'samreen_eft'), 'master', '⟦EFT⟧ vendor')
  assert.equal(aud('x', withNewVendorMarker(''), 'samreen_eft'), 'master', 'fresher')
  assert.equal(aud('f1', 'plain', 'samreen_eft'), 'master', 'frozen set')
  assert.equal(aud('x', 'plain unpaid', 'master'), 'master', 'master rail sweeps an unpaid vendor')
  assert.equal(aud('x', withOwnerVisibleMarker(withEftMarker('')), 'master'), 'all', 'handed back to Samreen')
  assert.equal(aud('x', 'plain unpaid', 'samreen_eft'), 'all', 'ordinary Samreen vendor')
})
