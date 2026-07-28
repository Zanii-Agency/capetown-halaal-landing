// Runs under `node --import tsx --test src/lib/bot/master-agent.test.ts`.
//
// The security-critical property: the master tool registry reads ACROSS vendors,
// so executeMasterTool MUST refuse every caller whose role is not 'master'
// BEFORE it touches the database. That gate is the wall; these tests hold it.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { executeMasterTool } from './tools/master-registry'
import { masterBrainEnabled } from './master-agent'

test('executeMasterTool refuses every role except master and the festival owner', async () => {
  // 'festival_owner' was in this list until 2026-07-28. Taona: "whenever she
  // texts the bot u an help her with info sh needs as long as it deosnt open
  // eft lane". She is now admitted to three allow-listed tools, each of which
  // runs owner-scoped; see owner-scope.test.ts for what that scoping withholds.
  // Everyone else is still refused before a single query runs.
  for (const role of ['vendor', 'viewer', 'operator', '', 'MASTER ', 'FESTIVAL_OWNER']) {
    const r = await executeMasterTool(role, 'find_vendors', { query: 'anything' })
    assert.equal(r.isError, true, `role ${JSON.stringify(role)} must be refused`)
    assert.match(r.content, /not authorised/i)
  }
})

test('the festival owner is refused the EFT tool specifically, while keeping the others', async () => {
  const eft = await executeMasterTool('festival_owner', 'eft_lane_activity', {})
  assert.equal(eft.isError, true)
  assert.match(eft.content, /not authorised/i)
  // And an unknown tool name cannot be used to smuggle past the allow-list.
  const bogus = await executeMasterTool('festival_owner', 'no_such_tool', {})
  assert.equal(bogus.isError, true)
  assert.match(bogus.content, /not authorised/i)
})

test('a master caller passes the gate (unknown tool still rejected, no throw)', async () => {
  const r = await executeMasterTool('master', 'no_such_tool', {})
  assert.equal(r.isError, true)
  assert.match(r.content, /unknown tool/i)
})

test('masterBrainEnabled defaults ON and honours the kill switch', () => {
  const prev = process.env.CTH_MASTER_BRAIN
  try {
    delete process.env.CTH_MASTER_BRAIN
    assert.equal(masterBrainEnabled(), true, 'default is on')
    for (const off of ['off', 'OFF', '0', 'false']) {
      process.env.CTH_MASTER_BRAIN = off
      assert.equal(masterBrainEnabled(), false, `${off} disables`)
    }
    process.env.CTH_MASTER_BRAIN = 'on'
    assert.equal(masterBrainEnabled(), true)
  } finally {
    if (prev === undefined) delete process.env.CTH_MASTER_BRAIN
    else process.env.CTH_MASTER_BRAIN = prev
  }
})
