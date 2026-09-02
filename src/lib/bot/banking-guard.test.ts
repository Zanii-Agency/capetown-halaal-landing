import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mentionsBanking, guardBankingTalk, PORTAL_PAYMENT_LINE } from '@/lib/bot/banking-guard'

test('the actual message that caused this', () => {
  // Mias Chill Station, 2026-07-27 09:14.
  const real =
    "Wa alaikum assalam Sulaimaan, you don't need to wait for that pack. Your banking " +
    'details for the stall fee are already available now, just log into your portal at ' +
    "cthalaal.co.za/exhibitor/login and go to Payments, you'll see the amount and account " +
    'details there ready to go.'
  assert.equal(mentionsBanking(real), true)
  assert.equal(guardBankingTalk(real).reply, PORTAL_PAYMENT_LINE)
})

test('every way the bot might raise banking', () => {
  for (const s of [
    'Here are the banking details for your stall fee.',
    'The account number is on your invoice.',
    'Use branch code 250655 when you pay.',
    'The beneficiary is Halaal Hub.',
    'Pay into the account and send proof.',
    'You can deposit into our FNB cheque account.',
    'Our bank account info is in the pack.',
    'Send the EFT to the account details below.',
  ]) {
    assert.equal(mentionsBanking(s), true, `expected caught: ${s}`)
  }
})

test('the replacement never leaks the topic it replaced', () => {
  const out = guardBankingTalk('Our account number is 63168769629 at FNB, branch 250655.')
  assert.equal(out.replaced, true)
  assert.match(out.reply, /cthalaal\.co\.za\/exhibitor\/login/)
  assert.doesNotMatch(out.reply, /63168769629|FNB|250655|account number/i)
})

test('normal replies are untouched, byte for byte', () => {
  for (const s of [
    'Your stall is F12 and load-in starts at 6am on the Friday.',
    'You can pay in your portal at cthalaal.co.za/exhibitor/login under Payments.',
    'Your contract is signed, nothing more needed from you.',
    'The festival runs 12 to 14 December at the Athlone Stadium.',
    'I have passed this to the team, someone will come back to you here.',
  ]) {
    const out = guardBankingTalk(s)
    assert.equal(out.replaced, false, `wrongly replaced: ${s}`)
    assert.equal(out.reply, s)
  }
})

test('a stall code or order reference is not an account number', () => {
  // The digit-shape rule only applies in a payment sentence, and must not fire
  // on the numbers a vendor conversation is legitimately full of.
  assert.equal(mentionsBanking('Your stall F12 is confirmed, 3 badges allocated.'), false)
  assert.equal(mentionsBanking('Order 12345678901 was collected.'), false)
  assert.equal(mentionsBanking('Your payment of R6,500 is received, thank you.'), false)
})

test('a phone number in a payment sentence is not an account number', () => {
  assert.equal(mentionsBanking('If your payment fails call us on +27659435012.'), false)
})

test('empty input is safe', () => {
  assert.equal(mentionsBanking(''), false)
  assert.equal(mentionsBanking(null), false)
  assert.equal(guardBankingTalk('').replaced, false)
})

test('the EMAIL drafter sentence, and the phrasings the first guard missed', () => {
  // The guard was wired into the WhatsApp reply path only, so the email
  // concierge wrote this to a vendor whose payment had failed:
  assert.equal(mentionsBanking(
    'The banking details and your unique payment reference are available on your exhibitor portal.'), true)
  // And "bank transfer" was not in the original term list at all, which is how
  // "it'll show you the exact amount and where to pay via bank transfer" shipped.
  for (const s of [
    "it'll show you the exact amount and where to pay via bank transfer",
    'You can pay via bank transfer.',
    'Vendors pay the stall fee by bank transfer.',
    'Please make an EFT to the details on your portal.',
  ]) {
    assert.equal(mentionsBanking(s), true, `expected caught: ${s}`)
  }
})
