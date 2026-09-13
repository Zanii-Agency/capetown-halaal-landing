import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isWithdrawalEmail, withdrawalConfirmText } from './withdrawal-email-autoreply'

// The two real misses (Taona 2026-09-11): a withdrawal must never get money talk.
test('treacle and tart: "unable to commit / not able to make payment until October / do not want to hold onto the space" is a withdrawal, NOT a plan', () => {
  const body = `Thank you for considering Treacle and Tart and especially for the requested payment plan. Unfortunately, due to financial constraints and timing, I am unable to fully commit to the festival at this stage. As it stands, I am not able to make payment until October. I do not want to be inconsiderate and hold onto the space if someone else is able to fully commit.`
  assert.equal(isWithdrawalEmail('Re: your stall', body), true)
})

test('wokness monster: "decided to withdraw from all events" is a withdrawal', () => {  const body = `Our business is undergoing re-structuring. This was also part of the reason we were delaying the payment. So my partner and I decided to withdraw from all events this year so that we can be ready from next year.`
  assert.equal(isWithdrawalEmail('Re: invoice', body), true)
})

test('a vendor who wants to STAY but pay in parts is NOT a withdrawal (stays a plan request)', () => {
  const body = `I would love to be part of the festival but I cannot afford the full amount this month. Could I pay a deposit now and the rest on a payment plan?`
  assert.equal(isWithdrawalEmail('payment help', body), false)
})

test('plain cant-afford with no quit intent is NOT a withdrawal', () => {
  const body = `I cannot afford the full fee right now. Is there any way to arrange paying it off over time?`
  assert.equal(isWithdrawalEmail('stall fee', body), false)
})

test('withdrawal keyword in the QUOTED chain, not the sender own words, is ignored', () => {
  const body = `Just checking the status of my application, thanks.\n\nOn 9 Sept 2026 at 08:28, Capetown Halaal wrote:\n> If you wish to withdraw, let us know and we will release your stall.`
  assert.equal(isWithdrawalEmail('status', body), false)
})

test('no withdrawal content at all is false', () => {
  assert.equal(isWithdrawalEmail('logo upload', 'Here is my logo and my menu as requested.'), false)
})

test('confirm email names the business and has no em-dash', () => {
  const t = withdrawalConfirmText('Aakifah', 'Treacle and Tart')
  assert.match(t, /Treacle and Tart/)
  assert.match(t, /withdrawn/)
  assert.ok(!/[—–]/.test(t))
})
