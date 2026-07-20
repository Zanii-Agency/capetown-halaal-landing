import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchFaq, FAQ } from './faq'
import { classifyIntent, intentFaqKeys } from './intents'

// Stall-fee payment asks must never be answered with the TICKET-buyer payment
// entry. payment_methods says "we accept Visa, Mastercard and cash at the
// event"; for a stall fee that is false on the cash half, and it is one step
// from the 2026-07-11 incident where the bot volunteered a payment route that
// does not exist. Stall fees are card-only via Yoco in the exhibitor portal.
//
// Two independent things had to be true for a vendor to actually see the wrong
// answer, which is why this sat latent:
//
//   1. matchFaq picked payment_methods over vendor_payment_method. It scores by
//      raw pattern-hit count and payment_methods' /\b(payment|pay)\b/ matches
//      the bare word "pay", so it out-scored the narrower vendor entry and won
//      declaration order on ties.
//   2. The Step-1 intent gate in festival-brain.ts let it through. That gate
//      drops a FAQ hit that is not in intentFaqKeys(intent), so most stall-fee
//      asks classify as vendor_payment and get dropped to the grounded LLM. The
//      leak is the phrasing the classifier reads as ticket_buyer, where
//      payment_methods IS an allowed key and serves as a canned answer.
//
// "can I pay my stall in cash" is that leak: ticket_buyer intent at 0.55, so it
// served canned ticket payment methods to a vendor asking about a stall. Both
// layers are asserted below, because fixing only the gate or only the matcher
// leaves the other half of the hole open.

const VENDOR_PAYMENT_ASKS = [
  'how do I pay my stall fee',
  'how can i pay my stall fee',
  'how do i pay the invoice',
  'how do i pay for my stand',
  'how do i pay for my booth',
  'can i pay my stall in cash',
  'can i pay my exhibitor invoice in cash',
  'do you take visa for the stall fee',
  'is cash ok for the stand fee',
  // Multi-stall is a shipped feature (c96fb91), so a vendor holding two stalls
  // asks in the plural. The singular-only \b closed every alternation, so these
  // fell straight through to payment_methods and its false cash claim.
  'how do i pay for my stalls',
  'can i pay for both stalls',
  'how do i pay my stall fees',
  // Banking asks are decisive on their own: there has never been an EFT option,
  // so the question can only be about a stall fee. "banking details" matched no
  // entry at all before the optional -ing, which is worse than a misroute, it
  // reached the LLM with no vendor grounding pinned.
  'can i get your banking details',
  'what are your eft details',
  'can i do a bank transfer',
]

// Ticket buyers own the generic payment vocabulary. vendor_payment_method now
// carries priority 1, so any pattern of its that fires on these would hijack
// them and answer a ticket question with stall-fee terms. Bare "fee" is the
// trap: "is there a booking fee I need to pay" reads as fee...pay.
const TICKET_PAYMENT_ASKS = [
  'how do i pay',
  'what payment methods do you accept',
  'do you take cash',
  'can i pay by card',
  'is there a booking fee i need to pay',
  'is there a fee to pay online',
  'are there any extra fees',
  // "stand" is a verb and "stalls" is what a ticket buyer calls the food
  // traders. Scoping vendor nouns behind a possessive is what keeps these out;
  // without it they matched the prioritised vendor entry and were answered with
  // stall-fee terms, this rule's own misroute pointed the other way.
  'do i have to pay to stand in the front',
  'can i pay to stand near the stage',
  'do i pay extra to stand at the front',
  'can i pay the food stalls in cash',
]

test('stall-fee payment asks reach the vendor entry, not the ticket one', () => {
  for (const msg of VENDOR_PAYMENT_ASKS) {
    const hit = matchFaq(msg)
    assert.equal(hit?.key, 'vendor_payment_method', `expected vendor_payment_method for: ${msg}`)
  }
})

test('no stall-fee ask can ever serve the ticket payment answer', () => {
  for (const msg of VENDOR_PAYMENT_ASKS) {
    const hit = matchFaq(msg)
    const intent = classifyIntent(msg)
    const allowed = new Set(intentFaqKeys(intent.intent))
    // Mirrors the Step-1 gate in festival-brain.ts.
    const gated = hit && allowed.size > 0 && !allowed.has(hit.key) ? null : hit
    const served = gated && intent.confidence >= 0.55 ? gated.key : null
    assert.notEqual(
      served,
      'payment_methods',
      `"${msg}" served ticket payment methods (intent ${intent.intent}) for a stall fee`,
    )
  }
})

test('ticket payment asks are not hijacked by the prioritised vendor entry', () => {
  for (const msg of TICKET_PAYMENT_ASKS) {
    const hit = matchFaq(msg)
    assert.notEqual(
      hit?.key,
      'vendor_payment_method',
      `"${msg}" is a ticket-buyer ask and must not route to stall-fee payment`,
    )
  }
})

// Priority bands, not just flags. vendor_part_payment sits above
// vendor_payment_method because "pay my stall fee in instalments" hits both,
// and HOW to pay is the wrong answer to WHETHER it can be split. Equal bands
// would hand it to vendor_payment_method on declaration order.
test('part-payment outranks payment-method when an ask hits both', () => {
  assert.ok(
    (FAQ.vendor_part_payment.priority ?? 0) > (FAQ.vendor_payment_method.priority ?? 0),
    'vendor_part_payment must outrank vendor_payment_method',
  )
  for (const msg of ['can i pay my stall fee in instalments', 'can i put down a deposit on my stall']) {
    assert.equal(matchFaq(msg)?.key, 'vendor_part_payment', `expected part-payment for: ${msg}`)
  }
})

test('the vendor payment answer stays card-only and doctrine-clean', () => {
  const { fact, answer } = FAQ.vendor_payment_method
  for (const text of [fact, answer]) {
    assert.match(text, /card only|by card/i)
    assert.match(text, /no EFT|not?\b.{0,20}bank transfer/i)
    assert.doesNotMatch(text, /[—–]/, 'no-em-dashes law (CTH-DOCTRINE 7)')
  }
})
