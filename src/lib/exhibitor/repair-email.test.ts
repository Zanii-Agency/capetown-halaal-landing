import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// update_my_email lets a vendor change the email on their own account, which is
// an account-takeover primitive in general. It is safe here for exactly one
// reason, and these tests exist so that reason cannot be removed by accident.
//
// THE FAILURE GATE. The tool refuses unless mail to the CURRENT address has a
// recorded delivery failure. You cannot point it at a healthy account, because
// there is nothing to repair. It can only rescue an account that is already
// unreachable, which is precisely the state where email-based proof of identity
// does not exist.
//
// Built after Raeesa Jenkins (MaterniTee) spent five weeks locked out by a
// one-letter typo, raeesajenkjns@ for raeesajenkins@, while the bot reported
// "sent" each time.

const SRC = readFileSync(join(process.cwd(), 'src/lib/exhibitor/repair-email.ts'), 'utf8')
const REG = readFileSync(join(process.cwd(), 'src/lib/bot/tools/registry.ts'), 'utf8')

test('THE GATE: a repair is refused unless the current address provably failed', () => {
  assert.ok(/hasKnownDeliveryFailure/.test(SRC), 'the failure check must exist')
  const gate = SRC.indexOf('if (!(await hasKnownDeliveryFailure(oldEmail)))')
  assert.ok(gate > 0, 'the gate must be a hard early return')
  // It must come BEFORE anything is written.
  const firstWrite = SRC.indexOf(".update({ email: newEmail })")
  assert.ok(gate < firstWrite, 'the gate must run before any write')
})

test('BOTH RECORDS or a loud partial failure, never a silent one', () => {
  // Raeesa's earlier repair fixed the application and left the auth user on the
  // dead address, so she still could not log in.
  assert.ok(/from\('vendor_applications'\)\s*\.update\(\{ email: newEmail \}\)/.test(SRC.replace(/\s+/g, ' ').replace(/ \./g, '\n.')) || /update\(\{ email: newEmail \}\)/.test(SRC), 'must update the application')
  assert.ok(/updateUserById\(mine\.id, \{ email: newEmail/.test(SRC), 'must update the auth user')
  assert.ok(/the application was updated but the portal account was not/.test(SRC), 'a half-done repair must say so')
})

test('a repair cannot collide with another vendor or another portal account', () => {
  assert.ok(/another application already uses that address/.test(SRC))
  assert.ok(/another portal account already uses that address/.test(SRC))
})

test('every repair is audited and alerts the master', () => {
  // The gate makes hijacking hard; the alert makes a wrong repair reversible.
  assert.ok(/vendor_application_events/.test(SRC), 'must write an audit row')
  assert.ok(/before_value: \{ email: oldEmail \}/.test(SRC), 'must record what it changed FROM')
  assert.ok(/audience: 'master'/.test(SRC), 'must alert the master')
  assert.ok(/Reverse it on the vendor profile/.test(SRC), 'the alert must say how to undo it')
})

test('the re-sent reset reports the real outcome, not an assumption', () => {
  assert.ok(/j\.delivered === true/.test(SRC), 'must read delivered from the truthful endpoint')
  assert.ok(/let resetDelivered = false/.test(SRC), 'unverified must default to false')
})

test('the tool is verified-session scoped, like every other vendor tool', () => {
  const scoped = REG.slice(REG.indexOf('const SCOPED_TOOLS'), REG.indexOf('export interface ToolOutcome'))
  assert.ok(scoped.includes("'update_my_email'"), 'must be in SCOPED_TOOLS or it is reachable unverified')
})

test('the model is told when NOT to call it', () => {
  const def = REG.slice(REG.indexOf("name: 'update_my_email'"), REG.indexOf("name: 'request_stall_change'"))
  assert.ok(/ONLY after request_password_reset reported it could not deliver/.test(def))
  assert.ok(/cannot be used for a routine address change/.test(def))
})

test('vendor-facing replies carry no long dash (law 7)', () => {
  const fn = REG.slice(REG.indexOf('async function updateMyEmail'), REG.indexOf('async function startVerification'))
  assert.equal(/[—–]/.test(fn), false)
  assert.equal(/[—–]/.test(SRC), false)
})
