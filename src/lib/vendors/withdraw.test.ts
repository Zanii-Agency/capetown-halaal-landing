import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Withdrawal is the first thing the bot can do that REMOVES a vendor from the
// festival and frees their booth for someone else. It is not reversible by the
// vendor, so the gates matter more than the happy path.
//
// Built because six vendors escalated a withdrawal in nine days and one read
// "Layali Haus has already requested withdrawal via WhatsApp and email, but is
// still" being chased. The request reached a human queue and stopped there, so
// we kept dunning people who had already quit.

const SRC = readFileSync(join(process.cwd(), 'src/lib/vendors/withdraw.ts'), 'utf8')
const REG = readFileSync(join(process.cwd(), 'src/lib/bot/tools/registry.ts'), 'utf8')
const FN = REG.slice(REG.indexOf('async function withdrawSelf'), REG.indexOf('async function escalateToHuman'))

test('a PAID vendor is never withdrawn automatically', () => {
  // Their money raises a refund question no rule here can answer, and silently
  // cancelling a paid stall is worse than asking.
  assert.ok(/paid_needs_human/.test(SRC), 'the lib must have a paid guard')
  assert.ok(/paid_at.*\|\|.*hasPaid|hasPaid.*\|\|.*paid_at/.test(SRC.replace(/\n/g, ' ')), 'must check both paid_at and portal state')
  assert.ok(/paid_needs_human/.test(FN), 'the tool must handle that outcome')
  assert.ok(/escalateToHuman/.test(FN), 'and escalate rather than proceed')
})

test('no reason means no withdrawal, the bot asks first', () => {
  assert.ok(/if \(!reason\)/.test(FN), 'must refuse without a reason')
  const askBlock = FN.slice(FN.indexOf('if (!reason)'), FN.indexOf('if (args?.confirmed'))
  assert.equal(/withdrawApplication\(/.test(askBlock), false, 'must not withdraw before asking why')
})

test('no explicit confirmation means no withdrawal', () => {
  assert.ok(/confirmed !== true/.test(FN), 'must require explicit confirmation')
  // The confirm prompt must come BEFORE any call that writes.
  assert.ok(FN.indexOf('confirmed !== true') < FN.indexOf('withdrawApplication('), 'confirmation gate precedes the write')
})

test('withdrawing twice is safe', () => {
  assert.ok(/already_withdrawn/.test(SRC))
  assert.ok(/already_withdrawn/.test(FN), 'the tool answers it plainly instead of erroring')
})

test('the stall is released, not left occupied', () => {
  // parseAllocation().human strips the stall marker; without this a vendor
  // leaves and their booth stays blocked for everyone else.
  assert.ok(/parseAllocation\(notes\)/.test(SRC))
  assert.ok(/freedStalls/.test(SRC))
})

test('it is reversible and audited', () => {
  assert.ok(/withdrawn = \{|withdrawn: unknown/.test(SRC), 'stamps a marker rather than deleting')
  assert.ok(/status: 'rejected'/.test(SRC), 'drops out of approved lists in one write')
  assert.ok(/vendor_withdrawn/.test(SRC), 'writes an audit row')
})

test('all three parties are told, per the instruction', () => {
  // Taona: "sends an email to them, samreen and also inform me master".
  assert.ok(/sendEmail\(/.test(FN), 'emails the vendor')
  assert.ok(/notifyOwners\(/.test(FN), 'notifies the owners')
  assert.ok(/audience: 'all'/.test(FN), "audience 'all' reaches Samreen AND the master")
})

test('vendor-facing withdrawal copy carries no long dash (law 7)', () => {
  const strings = FN.match(/`[^`]*`/g) || []
  assert.equal(/[—–]/.test(strings.join(' ')), false)
})
