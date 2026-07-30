import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolDefsForRole, executeMasterTool, MASTER_TOOL_DEFS } from './master-registry'
import { guard } from '@/lib/bot/master-agent'
import type { BotAdmin } from '@/lib/bot/admins'

const OWNER: BotAdmin = { phone: '+27723803393', role: 'festival_owner', name: 'Samreen Kumandan' }
const MASTER: BotAdmin = { phone: '+971501168462', role: 'master', name: 'Taona' }

// ---------------------------------------------------------------------------
// Wall 1: she is never TOLD the EFT tool exists. A model cannot call a tool
// that is absent from its schema, so this stands in front of the authorisation
// check rather than restating it.
// ---------------------------------------------------------------------------

test('the festival owner is never offered the EFT tool', () => {
  const names = toolDefsForRole('festival_owner').map((t) => t.name)
  assert.equal(names.includes('eft_lane_activity'), false)
  assert.deepEqual(names.sort(), ['find_vendors', 'pipeline_numbers', 'vendor_conversation'])
})

test('the master still gets every tool', () => {
  assert.equal(toolDefsForRole('master').length, MASTER_TOOL_DEFS.length)
  assert.equal(toolDefsForRole('master').map((t) => t.name).includes('eft_lane_activity'), true)
})

test('a NEW tool is invisible to her until someone names it, because the list is an ALLOW-list', () => {
  // The regression this encodes: on 2026-07-28 a sender rule was added to 13
  // inbox readers by hand and the 14th surface leaked bank notices for hours.
  // A deny-list here would repeat that shape, exposing every future tool to her
  // by default. If this assertion ever fails, someone widened her access.
  const ownerNames = new Set(toolDefsForRole('festival_owner').map((t) => t.name))
  for (const t of MASTER_TOOL_DEFS) {
    if (!['find_vendors', 'pipeline_numbers', 'vendor_conversation'].includes(t.name)) {
      assert.equal(ownerNames.has(t.name), false, `${t.name} leaked into the owner tool set`)
    }
  }
})

// ---------------------------------------------------------------------------
// Wall 2: the executor refuses, even if the tool name is supplied directly.
// ---------------------------------------------------------------------------

test('calling the EFT tool by name is refused for her, with no query run', async () => {
  const out = await executeMasterTool('festival_owner', 'eft_lane_activity', {})
  assert.equal(out.isError, true)
  assert.equal(out.content, 'Not authorised.')
})

test('every other role is refused outright', async () => {
  for (const role of ['vendor', 'unknown', '', 'admin', 'FESTIVAL_OWNER']) {
    const out = await executeMasterTool(role, 'find_vendors', { query: 'a' })
    assert.equal(out.isError, true, role)
  }
})

// ---------------------------------------------------------------------------
// Wall 3: the composed sentence. The tools can be perfectly scoped and the
// model can still say the word.
// ---------------------------------------------------------------------------

test('an EFT mention in her composed reply is replaced, not sent', () => {
  const leak = 'Aurelia opened the EFT bank details this morning.'
  const out = guard(OWNER, leak)
  assert.notEqual(out, leak)
  assert.equal(/eft/i.test(out), false)
  assert.equal(/[—–]/.test(out), false, 'law 7: no em-dashes in her copy either')
})

test('the deflection is an answer she can act on, never silence', () => {
  // A blank reply reads as the bot being broken and costs her a support call.
  const out = guard(OWNER, 'They paid by EFT yesterday.')
  assert.ok(out.trim().length > 0)
  assert.match(out, /Taona/)
})

test('her ordinary replies pass through untouched', () => {
  for (const ok of [
    'Aurelia is approved and paid, stall B12.',
    'Draft: Wa alaikum assalam Fatima, jazakallah for your patience.',
    '47 approved, 21 paid, 3 pending review.',
  ]) {
    assert.equal(guard(OWNER, ok), ok)
  }
})

test('the master is never guarded, nothing is hidden from him', () => {
  const s = 'Aurelia opened the EFT bank details this morning.'
  assert.equal(guard(MASTER, s), s)
})

// ---------------------------------------------------------------------------
// New master-only read tools: stall_occupancy, vendor_documents, vendor_staff.
// They are never offered to the festival owner and are refused at the executor.
// ---------------------------------------------------------------------------

const NEW_MASTER_TOOLS = ['stall_occupancy', 'vendor_documents', 'vendor_staff', 'pending_stall_changes'] as const

for (const toolName of NEW_MASTER_TOOLS) {
  test(`${toolName} is not in the festival owner's tool set`, () => {
    const ownerNames = new Set(toolDefsForRole('festival_owner').map((t) => t.name))
    assert.equal(ownerNames.has(toolName), false)
  })

  test(`${toolName} is refused to the festival owner at the executor`, async () => {
    const args = toolName === 'stall_occupancy' ? {} : { vendor_id: '00000000-0000-0000-0000-000000000000' }
    const out = await executeMasterTool('festival_owner', toolName, args)
    assert.equal(out.isError, true)
    assert.equal(out.content, 'Not authorised.')
  })
}
