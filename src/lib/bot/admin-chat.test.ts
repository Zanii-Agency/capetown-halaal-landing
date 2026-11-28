// Tests for the WhatsApp admin-chat surface.
//
// The security-critical property: while global EFT mode is ON, the festival
// owner must receive a neutral reply and no payment/vendor data may leak,
// regardless of what she types. Master-only management commands are parsed and
// drafted for confirmation, but never executed on a single message.
//
// These tests read from the live Supabase project (same pattern as
// vendor-session.eval.test.ts) but do not write.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// Load .env.local BEFORE importing any module that reads env at load time.
for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

import { handleAdminMessage } from './admin-chat'

let originalEftMode: string | undefined

before(() => {
  originalEftMode = process.env.EFT_MODE
})

after(() => {
  if (originalEftMode === undefined) delete process.env.EFT_MODE
  else process.env.EFT_MODE = originalEftMode
})

function setEftMode(on: boolean) {
  // getEftMode() reads site_events when the env var is absent, so an explicit
  // 'off' is needed to force the lane closed in tests.
  process.env.EFT_MODE = on ? 'on' : 'off'
}

function admin(role: 'festival_owner' | 'master', suffix: string) {
  return {
    phone: `+27999999${suffix}`,
    role,
    name: role === 'festival_owner' ? 'Samreen Kumandan' : 'Taona',
  }
}

test('festival owner stats and blasts never include a walled (master-lane) person', async () => {
  // The old whole-surface lock was replaced by a per-recipient wall. Prove it
  // withholds something (a filter that blocks nothing also shows "no leaks") and
  // that nothing it lets through is walled, in EITHER EFT mode.
  const { resolveSegment } = await import('./segments')
  const { loadWalledContacts } = await import('@/lib/broadcast-audience')
  const wall = await loadWalledContacts()
  assert.ok(wall, 'wall must load')
  for (const on of [true, false]) {
    setEftMode(on)
    for (const seg of ['approved', 'approved_unpaid', 'approved_paid'] as const) {
      const full = await resolveSegment(seg)
      const owner = await resolveSegment(seg, { ownerView: true })
      const leaked: typeof owner = owner.filter((r) => wall!.blocks((r as { phone?: string }).phone, r.email))
      assert.equal(leaked.length, 0, `${seg}: ${leaked.length} walled people reachable by the owner`)
      assert.ok(full.length >= owner.length)
    }
    const all = await resolveSegment('approved')
    const ownerAll = await resolveSegment('approved', { ownerView: true })
    assert.ok(all.length - ownerAll.length > 0, 'the wall must withhold at least one master-lane vendor')
  }
})

test('festival owner gets stats in either EFT mode', async () => {
  for (const on of [true, false]) {
    setEftMode(on)
    const r = await handleAdminMessage(admin('festival_owner', '02'), 'give me a stats update')
    assert.equal(r.action, 'stats')
    assert.match(r.reply, /Current numbers/)
  }
})

test('master approve command requires confirmation', async () => {
  setEftMode(false)
  const r = await handleAdminMessage(admin('master', '03'), 'approve Demo Halal Kitchen')
  assert.equal(r.action, 'proposed_action')
  assert.match(r.reply, /Ready to approve/)
  assert.match(r.reply, /CONFIRM/)
  assert.match(r.reply, /CANCEL/)
})

test('master paid command requires confirmation', async () => {
  setEftMode(false)
  const r = await handleAdminMessage(admin('master', '04'), 'paid Demo Halal Kitchen R6500 eft')
  assert.equal(r.action, 'proposed_action')
  assert.match(r.reply, /Ready to mark/)
  assert.match(r.reply, /R6500/)
  assert.match(r.reply, /CONFIRM/)
})

test('master stall command requires confirmation', async () => {
  setEftMode(false)
  const r = await handleAdminMessage(admin('master', '05'), 'stall Demo Halal Kitchen FS12')
  assert.equal(r.action, 'proposed_action')
  assert.match(r.reply, /Ready to allocate/)
  assert.match(r.reply, /FS12/)
})

test('master msg command requires confirmation', async () => {
  setEftMode(false)
  const r = await handleAdminMessage(admin('master', '06'), 'msg Demo Halal Kitchen : please upload your docs')
  assert.equal(r.action, 'proposed_action')
  assert.match(r.reply, /Ready to WhatsApp/)
  assert.match(r.reply, /upload your docs/)
})

test('master stall-change approve command requires confirmation', async () => {
  setEftMode(false)
  const r = await handleAdminMessage(admin('master', '07'), 'change approve Demo Halal Kitchen')
  assert.equal(r.action, 'proposed_action')
  assert.match(r.reply, /Ready to approve/)
  assert.match(r.reply, /size change/)
  assert.match(r.reply, /CONFIRM/)
})

test('master stall-change reject command requires confirmation', async () => {
  setEftMode(false)
  const r = await handleAdminMessage(admin('master', '08'), 'change reject Demo Halal Kitchen because too small')
  assert.equal(r.action, 'proposed_action')
  assert.match(r.reply, /Ready to reject/)
  assert.match(r.reply, /too small/)
})

test('master stall-move approve command requires confirmation', async () => {
  setEftMode(false)
  const r = await handleAdminMessage(admin('master', '09'), 'move approve Demo Halal Kitchen')
  assert.equal(r.action, 'proposed_action')
  assert.match(r.reply, /Ready to approve/)
  assert.match(r.reply, /CONFIRM/)
})

test('master help lists available commands', async () => {
  setEftMode(false)
  const r = await handleAdminMessage(admin('master', '10'), 'what can you do')
  assert.equal(r.action, 'none')
  assert.match(r.reply, /approve <vendor>/i)
  assert.match(r.reply, /change approve/i)
  assert.match(r.reply, /move reject/i)
  assert.match(r.reply, /CONFIRM/)
})

test('festival owner help lists her available commands', async () => {
  setEftMode(false)
  const r = await handleAdminMessage(admin('festival_owner', '11'), 'help')
  assert.equal(r.action, 'none')
  assert.match(r.reply, /stats/)
  assert.doesNotMatch(r.reply, /approve <vendor>/i)
})
