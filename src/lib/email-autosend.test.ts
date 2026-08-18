// node --import tsx --test src/lib/email-autosend.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoSendDecision } from './email-autosend'
const V = { fromIsVendor: true }

test('a non-vendor sender never auto-sends (spam / system / B2B)', () => {
  const clean = 'Assalamu alaikum, the festival runs 11 to 13 December 2026 at Youngsfield. Cape Town Halaal Festival Team'
  assert.equal(autoSendDecision('dates?', clean, { fromIsVendor: false }).auto, false)
})
test('a deflection / holding reply never auto-sends', () => {
  for (const d of [
    'Thank you. I have flagged this to the team and they will get back to you shortly. Cape Town Halaal Festival Team',
    'Someone from the team will come back to you on this. Cape Town Halaal Festival Team',
    'We will look into this and follow up with you soon. Cape Town Halaal Festival Team',
  ]) assert.equal(autoSendDecision('any', d, V).auto, false, d.slice(0, 30))
})
test('money / EFT / arrangement never auto-sends', () => {
  assert.equal(autoSendDecision('pay in instalments?', 'Yes you can pay in two parts, first now and balance end of August. Cape Town Halaal Festival Team', V).auto, false)
  assert.equal(autoSendDecision('banking details', 'You can pay by EFT to the account on your portal. Cape Town Halaal Festival Team', V).auto, false)
  assert.equal(autoSendDecision('POP attached', 'Thank you, we have received your proof of payment. Cape Town Halaal Festival Team', V).auto, false)
})
test('a system-notification style draft never auto-sends', () => {
  assert.equal(autoSendDecision('x', 'This appears to be a system notification rather than a message for us. Cape Town Halaal Festival Team', V).auto, false)
})
test('a clean self-contained answer from a vendor auto-sends', () => {
  const d = 'Assalamu alaikum, thank you for your interest. You can apply at cthalaal.co.za, all stall options are on the form. Cape Town Halaal Festival Team'
  assert.equal(autoSendDecision('how do I apply?', d, V).auto, true)
  const d2 = 'Assalamu alaikum, the festival runs 11 to 13 December 2026 at Youngsfield Military Base, gates open 10am. Cape Town Halaal Festival Team'
  assert.equal(autoSendDecision('dates and times?', d2, V).auto, true)
})
test('empty or stub drafts never auto-send', () => {
  assert.equal(autoSendDecision('x', '', V).auto, false)
  assert.equal(autoSendDecision('x', 'Noted.', V).auto, false)
})
