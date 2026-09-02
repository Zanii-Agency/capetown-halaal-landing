import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The bot must never claim a password reset was sent when it was not.
//
// Raeesa Jenkins (MaterniTee) was told "I have sent a password reset link" on
// 19 Jun, 5 Jul and 29 Jul while every one of those emails bounced off a typo
// on her application: raeesajenkjns@ where raeesajenkins@ belonged. Her auth
// account showed last_sign_in NEVER for five weeks. Mias Chill Station hit the
// same failure on 2026-07-27.
//
// Detection was never the problem. The endpoint already ran confirmDelivery and
// already alerted the master, and those alerts were delivered. The tool simply
// threw the response away and reported success regardless, so the one person
// who could have spotted the typo was the one person kept in the dark.
//
// This is a source assertion on purpose. The failure is a DISCARDED RETURN
// VALUE, which no runtime test of the happy path can catch: everything
// "succeeds" either way. What must not regress is that the code reads the
// result and branches on it.

const SRC = readFileSync(join(process.cwd(), 'src/lib/bot/tools/registry.ts'), 'utf8')
const FN = SRC.slice(SRC.indexOf('async function requestPasswordReset'), SRC.indexOf('async function startVerification'))

test('the reset tool reads the response instead of discarding it', () => {
  assert.ok(/const\s+res\s*=\s*await\s+fetch\(/.test(FN), 'must capture the fetch response')
  assert.ok(/await\s+res\.json\(\)/.test(FN), 'must read the body')
  assert.ok(/j\.delivered\s*===\s*true/.test(FN), 'must branch on delivered')
})

test('success is only claimed inside the delivered branch', () => {
  const claim = 'I have sent a password reset link'
  assert.ok(FN.includes(claim), 'the success line should still exist')
  // lastIndexOf, not indexOf: the comment above the code quotes this same
  // sentence while explaining the bug, and matching the comment would let a
  // regression pass. The RETURN is the last occurrence.
  assert.ok(FN.indexOf('if (delivered)') < FN.lastIndexOf(claim), 'success claim must be guarded by delivered')
})

test('an unverified result is treated as failure, not success', () => {
  // `delivered` is absent when CRON_SECRET is unset or an older deploy answers.
  // Absent must NOT read as success, so the default is false.
  assert.ok(/let\s+delivered\s*=\s*false/.test(FN), 'delivered must default to false')
})

test('the failure reply names the address in full and escalates', () => {
  // A typo is invisible behind asterisks, so the failure path prints the real
  // address, unlike the success path which masks it.
  assert.ok(/could not get that email through to \$\{row\.email\}/.test(FN), 'must show the unmasked address on failure')
  assert.ok(/escalateToHuman\(session,/.test(FN), 'must put a human on it')
  // And it must not promise delivery in the same breath.
  const failTail = FN.slice(FN.indexOf('could not get that email through'))
  assert.equal(/I have sent a password reset link/.test(failTail), false)
})

test('the masked address is still used for the success message', () => {
  // Masking remains correct when the mail genuinely left: no reason to expose
  // an address back to a channel the vendor already controls.
  assert.ok(/link to \$\{masked\}/.test(FN))
})

test('vendor-facing copy in this tool carries no long dash (law 7)', () => {
  const lines = FN.split('\n').filter((l) => /return `/.test(l) || /^\s{4}`/.test(l))
  assert.equal(/[—–]/.test(lines.join('\n')), false)
})
