import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preferWaBound } from '@/lib/bot/identity'

const L9 = '614597867'
const row = (id: string, notes?: string) => ({ id, admin_notes: notes ?? null })

test('an OTP-bound row wins over the ambient phone match', () => {
  // Riyadh, 2026-07-26: two applications on one number, one bound by email-OTP.
  // Before this, applicationCount stayed at 2 and every tool refused him.
  const out = preferWaBound([row('rejected-twin'), row('bound', `⟦WAV${L9}⟧`)], L9)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'bound')
})

test('the binding survives the other markers sharing admin_notes', () => {
  const out = preferWaBound([row('a'), row('b', `⟦EFT⟧ ⟦STALL:F12⟧ ⟦WAV${L9}⟧`)], L9)
  assert.equal(out[0].id, 'b')
})

test('a marker for a DIFFERENT number does not bind', () => {
  const out = preferWaBound([row('a'), row('b', '⟦WAV831234567⟧')], L9)
  assert.equal(out.length, 2)
})

test('no binding leaves the picker intact for two real businesses', () => {
  const out = preferWaBound([row('salty-shack'), row('wok-bar')], L9)
  assert.equal(out.length, 2)
})

test('two bound rows stay ambiguous rather than guessing', () => {
  const out = preferWaBound([row('a', `⟦WAV${L9}⟧`), row('b', `⟦WAV${L9}⟧`)], L9)
  assert.equal(out.length, 2)
})

test('a short number is never treated as a binding', () => {
  // Guards the substring: a 3-digit "last9" would match WAV-anything.
  const out = preferWaBound([row('a', `⟦WAV${L9}⟧`), row('b')], '867')
  assert.equal(out.length, 2)
})
