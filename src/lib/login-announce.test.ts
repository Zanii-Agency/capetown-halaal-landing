import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Taona 2026-07-29: "make sure when any vendor logs in you tell me including
// samreen and everyone".
//
// The failure this guards is a MISSED DOOR, not broken logic. Four paths could
// create a session and only two announced it:
//
//   /api/exhibitor/login   vendor form         announced
//   /admin/login           admin form          announced, but gated on an
//                                              unusual location or new IP
//   /auth/callback         reset / magic link  SILENT
//   /login                 second vendor form  SILENT
//
// Raeesa Jenkins signed in through /auth/callback minutes after her email was
// repaired and nothing said so. Same shape as the inbox sender rule that was
// applied to thirteen readers while a fourteenth surface leaked for hours.
//
// So this test walks the source tree and asserts that ANY file establishing a
// session also announces it. A fifth door fails here on the day it is written.

const ROOT = join(process.cwd(), 'src/app')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

// Establishing a session, as opposed to merely reading one.
const CREATES_SESSION = /signInWithPassword|verifyOtp|exchangeCodeForSession|setSession\(/
const ANNOUNCES = /announceLogin|login-log/

// The reset endpoint MINTS a link, it does not establish a session; the browser
// then follows that link into /auth/callback, which does announce.
const EXEMPT = new Set(['api/exhibitor/send-password-reset/route.ts'])

test('every path that establishes a session also announces it', () => {
  const offenders: string[] = []
  for (const f of walk(ROOT)) {
    const src = readFileSync(f, 'utf8')
    if (!CREATES_SESSION.test(src)) continue
    const rel = f.slice(ROOT.length + 1)
    if (EXEMPT.has(rel)) continue
    if (!ANNOUNCES.test(src)) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], `these create a session without announcing it:\n${offenders.join('\n')}`)
})

test('the announcer alerts on EVERY login, with no gate in front of it', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/login-announce.ts'), 'utf8')
  // The admin path used to fire only on an unusual location. Taona overruled
  // that. The unusual signal must survive as a LINE, never as a condition
  // wrapped around the notify call.
  assert.ok(/notifyOwners\(/.test(src), 'must notify')
  const notifyAt = src.indexOf('notifyOwners({ event:')
  const before = src.slice(0, notifyAt)
  // No `if (!expected)` or `if (shouldAlert` guarding the notify itself.
  assert.equal(/if \(!expected\) \{[^}]*notifyOwners/.test(src), false, 'notify must not be gated on the location')
  assert.ok(before.includes("if (!expected) lines.push"), 'unusual location should be a line in the body')
})

test('the master is the audience, because the summary carries payment posture', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/login-announce.ts'), 'utf8')
  assert.ok(/audience: 'master'/.test(src))
})

test('telemetry can never fail a sign-in', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/login-announce.ts'), 'utf8')
  assert.ok(/try \{/.test(src) && /catch \(e\)/.test(src), 'must be wrapped')
  assert.ok(/\.catch\(\(\) => \{\}\)/.test(src), 'the notify itself must swallow its own failure')
})
