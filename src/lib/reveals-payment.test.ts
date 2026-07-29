import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mentionsEft, revealsPaymentArrangement as reveals } from './eft'

// Taona 2026-07-29: "what guard can u put that says when someone mentioned paid
// via eft, trasnfered, sent pop, etc".
//
// TWO PREDICATES, ON PURPOSE. mentionsEft stays narrow: four write paths feed it
// to markVendorToldEft, which MOVES A VENDOR ONTO THE MASTER LANE. Widening it
// would mean an admin typing "your transfer came through" silently pulls a
// vendor out of the festival owner's world. This one only ever hides.

test('the wide predicate catches what the narrow one missed', () => {
  const wasMissed = [
    'I did the transfer this morning, please check.',
    'Transferred R3700 today, please confirm.',
    'I deposited into your account yesterday.',
    'Paid it directly into the FNB account.',
    'sent POP',
    'POP attached, please confirm receipt.',
    'Here are the banking details: FNB 62...',
    'Sending you the bank details now.',
    'Please use account number 6301234567',
    'branch code 250655',
    'Did the payshap this morning',
    'sent the money already',
  ]
  for (const s of wasMissed) {
    assert.equal(mentionsEft(s), false, `narrow one should still miss: ${s}`)
    assert.equal(reveals(s), true, `wide one must catch: ${s}`)
  }
})

test('the explicit vocabulary is still caught', () => {
  for (const s of ['I paid via eft yesterday', 'Proof of payment attached.', 'can we do a bank transfer']) {
    assert.equal(reveals(s), true, s)
  }
})

// ---------------------------------------------------------------------------
// The carve-outs. Each one is a false positive that was MEASURED on live data
// and then designed out, not imagined.
// ---------------------------------------------------------------------------

test('a card-only refusal stays visible, because it is the answer to the question above it', () => {
  // Hiding these leaves her a question with no answer, which reads as a broken
  // bot and invites her to answer it herself, possibly wrongly.
  for (const s of [
    'Sorry, stall fees are paid by card only through Yoco in the portal, so there are no banking details.',
    "I'm not able to give out payment or bank details directly, payment for your stall is by card only.",
    'Payment is done by card only through the Yoco gateway.',
  ]) {
    assert.equal(reveals(s), false, s)
  }
})

test('a vendor ASKING is not a vendor being told', () => {
  // "Please send banking details" does not reveal that a lane exists. Hiding it
  // while showing the refusal would be the worst of both.
  for (const s of ['Please send banking details', 'Can I get account details so I can pay kanala', 'I need bank details']) {
    assert.equal(reveals(s), false, s)
  }
})

test('"deposit" means part-payment in this business, not a bank deposit', () => {
  // Bare \bdeposit\b was tried and hid a pile of legitimate "do we need to pay a
  // deposit" traffic. Only "deposited into" / "bank deposit" count.
  for (const s of ['Aslm, do we need to pay a deposit?', 'Are we allowed to make a 50% deposit ?', "you don't need a deposit"]) {
    assert.equal(reveals(s), false, s)
  }
  assert.equal(reveals('I deposited it into your account'), true)
  assert.equal(reveals('made a bank deposit this morning'), true)
})

test('a phone number is not an account number', () => {
  // A bare \d{9,} rule was tried and hid EVERY "WA opt-in ... subscribed at
  // +2767..." alert, because SA mobile numbers are 11 digits with the code.
  assert.equal(reveals('WA opt-in: Junaid Maroof (Krispy Corn Dog) subscribed at +27670805453.'), false)
  assert.equal(reveals('call me on 0824871879'), false)
})

test('POP is only POP in a payment context', () => {
  assert.equal(reveals('the pop up stall looked great'), false)
  assert.equal(reveals('it popped up on my screen'), false)
  assert.equal(reveals('POP attached'), true)
  assert.equal(reveals('sent pop'), true)
})

test('ordinary festival traffic is untouched', () => {
  for (const s of [
    'Your stall is confirmed, see you in December.',
    'Wa alaikum assalam, jazakallah for your patience.',
    'Can I change my stall size?',
    'What time is setup on the Friday?',
    '',
  ]) {
    assert.equal(reveals(s), false, JSON.stringify(s))
  }
})

test('null and undefined are safe', () => {
  assert.equal(reveals(null), false)
  assert.equal(reveals(undefined), false)
})
