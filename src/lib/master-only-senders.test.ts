import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMasterOnlySender } from './master-only-senders'

// ---------------------------------------------------------------------------
// The three that actually reached the festival owner on 2026-07-28.
// ---------------------------------------------------------------------------

test('the bank payment notifications she could read are blocked', () => {
  assert.equal(isMasterOnlySender('ibreply@absa.co.za'), true, 'Notice of payment: Halaal Hub')
  assert.equal(isMasterOnlySender('noreply@standardbank.co.za'), true, 'Payment confirmation 1041')
  assert.equal(isMasterOnlySender('no-reply@investec.co.za'), true, 'Confirmation of Payment')
})

test("the EFT admin's own alerts are blocked", () => {
  // Preview read: "Le Sucre Artisanal Treats uploaded their E[FT proof]".
  assert.equal(isMasterOnlySender('dev@cthalaal.co.za'), true)
  assert.equal(isMasterOnlySender('DEV@CTHALAAL.CO.ZA'), true, 'case insensitive')
  assert.equal(isMasterOnlySender('  dev@cthalaal.co.za  '), true, 'trimmed')
})

test('operator preview addresses are blocked', () => {
  assert.equal(isMasterOnlySender('taonac96@gmail.com'), true)
})

// ---------------------------------------------------------------------------
// The over-blocking this rule must NOT do. A wall that eats her real mail gets
// switched off, and then it protects nothing.
// ---------------------------------------------------------------------------

test('ordinary bank correspondence still reaches her', () => {
  // A real partnership pitch from a human at a bank. Blocking every bank domain
  // would have hidden this, and it is genuinely her business.
  assert.equal(isMasterOnlySender('corporatesocialinvestment@capitecbank.co.za'), false)
})

test('her own address and the support mailbox are not blocked', () => {
  assert.equal(isMasterOnlySender('capetownhalaal@gmail.com'), false)
  // The [YAH] payment-succeeded alert is what she is SUPPOSED to get.
  assert.equal(isMasterOnlySender('support@youngatheart.co.za'), false)
})

test('vendors and suppliers are untouched', () => {
  for (const e of [
    'Ysumsodien786@gmail.com',
    'sammy@printex.co.za',
    'ronald.claasen@capetown.gov.za',
    'yusrah@reidlaw.co.za',
    'no-reply@fooevents.com',
  ]) {
    assert.equal(isMasterOnlySender(e), false, e)
  }
})

test('empty and malformed input is not blocked', () => {
  // Failing open here is right: this rule hides mail, and hiding on a parse
  // failure would silently shrink her inbox with no way to notice.
  for (const e of [null, undefined, '', '   ', 'not-an-email']) {
    assert.equal(isMasterOnlySender(e), false, JSON.stringify(e))
  }
})

test('a notification SUBDOMAIN blocks new senders, the bank domain does not', () => {
  assert.equal(isMasterOnlySender('anything@fnbstatements.co.za'), true, 'statements subdomain')
  assert.equal(isMasterOnlySender('a.human@fnb.co.za'), false, 'the bank itself stays reachable')
})
