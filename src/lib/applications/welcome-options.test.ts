import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The approval flow fired a WhatsApp template `vendor_welcome_options` that was
// never registered in Meta, so it 404'd (#132001) on EVERY approval, a
// guaranteed-failing API call that reached no one. Its intent (tell a new vendor
// the two ways to manage their stall) now lives in the approval EMAIL, which
// always delivers and needs no Meta approval. Taona 2026-08-04: "fix the
// welcome_options template issue".

const NOTIFY = readFileSync(join(process.cwd(), 'src/lib/applications/decision-notify.ts'), 'utf8')
const EMAIL = readFileSync(join(process.cwd(), 'src/lib/email/templates/ApplicationApproved.tsx'), 'utf8')

test('the dead vendor_welcome_options template is no longer SENT', () => {
  // A mention in a comment is fine; an actual sendTemplate call is the bug.
  assert.equal(/sendTemplate\([^)]*vendor_welcome_options/.test(NOTIFY), false, 'must not call the unregistered template')
})

test('the approval email carries the WhatsApp + portal self-serve message instead', () => {
  assert.ok(/Manage your stall anytime/.test(EMAIL), 'the section the template used to convey')
  assert.ok(/WhatsApp/i.test(EMAIL), 'names the WhatsApp channel')
  assert.ok(/portal/i.test(EMAIL), 'names the portal channel')
})

test('the new email copy carries no long dash (law 7)', () => {
  // Isolate the added section and check it.
  const start = EMAIL.indexOf('Manage your stall anytime')
  const section = EMAIL.slice(start, start + 400)
  assert.equal(/[—–]/.test(section), false)
})
