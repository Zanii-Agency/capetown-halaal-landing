import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { matchFaq, FAQ } from './faq'
import { classifyIntent, intentFaqKeys } from './intents'
import { BASE_PROMPT } from './system-prompt'

// The part-payment rule is a two-part contract and both halves are load bearing:
//
//   1. Every trigger phrase must REACH the vendor_part_payment entry, otherwise
//      the ask falls through to vendor_payment_method and gets answered with
//      card-only payment methods (the misroute logged at festival-brain.ts:272).
//   2. The entry must NEVER be allowed to short-circuit as a canned answer. The
//      Step-1 gate in festival-brain.ts only lets a FAQ key serve canned text if
//      intentFaqKeys(intent) contains it. Keeping the key out of that map is what
//      forces the grounded-LLM path, which is what makes the reply personal.
//      Adding 'vendor_part_payment' to intentFaqKeys() would silently turn this
//      back into the canned policy notice the rule exists to avoid.

const TRIGGERS = [
  'can I do a part payment',
  'can I pay in parts',
  'do you allow instalments',
  'can I pay in installments',
  'can I pay half now',
  'can I pay some now and the rest later',
  'is it possible to split the payment',
  'can I pay it in bits',
  'do you do layby',
  'do you offer laybye',
  'can I pay a portion now',
  'can I pay it off over a few months',
  'can I put down a deposit',
  'can I pay monthly',
]

test('every trigger phrase reaches the part-payment entry', () => {
  for (const msg of TRIGGERS) {
    const hit = matchFaq(msg)
    assert.equal(hit?.key, 'vendor_part_payment', `expected vendor_part_payment for: ${msg}`)
  }
})

test('the entry can never short-circuit as a canned answer', () => {
  for (const msg of TRIGGERS) {
    const intent = classifyIntent(msg)
    const allowed = new Set(intentFaqKeys(intent.intent))
    // Mirrors the Step-1 gate: a non-empty allow-list that excludes the key
    // drops the hit and hands the turn to the grounded LLM.
    assert.ok(allowed.size > 0, `intent ${intent.intent} has an empty allow-list for: ${msg}`)
    assert.ok(
      !allowed.has('vendor_part_payment'),
      `vendor_part_payment became short-circuitable via intent ${intent.intent}`,
    )
  }
})

test('the stated deadline is 31 August 2026 and carries no stall prices', () => {
  const { fact, answer } = FAQ.vendor_part_payment
  for (const text of [fact, answer]) {
    assert.match(text, /31 August 2026/)
    assert.doesNotMatch(text, /R\s?\d/, 'part-payment copy must not state stall prices')
    assert.doesNotMatch(text, /[—–]/, 'no-em-dashes law (CTH-DOCTRINE 7)')
  }
})

// 31 August is an on-request concession layered ON TOP of the vendor's own
// due date, NOT a replacement for it. The per-vendor due date
// (reviewed_at + 30 days, api/cron/payment-reminders/route.ts:72) and its
// reminders keep running untouched. Copy that reads as "your deadline is now
// August" would contradict the reminder emails those vendors still receive, so
// both the grounding fact and the prompt must keep the due date alive.
test('the August date never reads as replacing the vendor due date', () => {
  const { fact, answer } = FAQ.vendor_part_payment
  for (const text of [fact, answer]) {
    assert.match(text, /still (stands|show)|still receive|still get/i)
    assert.match(text, /reminder/i)
    assert.doesNotMatch(text, /extend(ed)? your due date|due date has (been )?(moved|changed)/i)
  }
})

// The weekly reminder email is the other half of this rule's contract. Reminders
// now run to 31 Aug 2026 (api/cron/payment-reminders), and weekNumber caps at 4,
// so the week-4 tone repeats for months. Any countdown or payment method it names
// gets asserted to that vendor over and over, and would contradict what the bot
// tells the same person. These two strings have both already caused that.
test('the reminder email promises nothing the system will not honour', () => {
  const src = readFileSync(
    join(import.meta.dirname, '../email/templates/VendorPaymentReminder.tsx'),
    'utf8',
  )
  // Strip comments first, otherwise the comments explaining these very rules
  // trip the assertions they document.
  const body = src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  assert.doesNotMatch(
    body,
    /\bEFT\b/,
    'stall fees are card-only via Yoco, naming EFT recreates the 2026-07-11 incident',
  )
  assert.doesNotMatch(
    body,
    /released within \d+ days?|within \d+ days?.{0,30}releas/i,
    'week-4 tone repeats weekly, so it must not promise a release countdown it does not run',
  )
})

test('the reply-shape rule is present and bans notice language', () => {
  assert.match(BASE_PROMPT, /PART PAYMENTS/)
  assert.match(BASE_PROMPT, /31 August 2026/)
  // The banned words appear only inside the NEVER-use instruction itself.
  assert.match(BASE_PROMPT, /NEVER use the words "policy", "rules", "not allowed"/)
  // Reactive-only, and the due date must survive the concession.
  assert.match(BASE_PROMPT, /never mention 31 August to anyone who has not asked/)
  assert.match(BASE_PROMPT, /NEVER tell them to ignore a reminder/)
  assert.match(BASE_PROMPT, /the due date on their account stays as it is/)
})
