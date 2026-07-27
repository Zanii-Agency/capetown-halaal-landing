import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VENDOR_FACTS, VENDOR_FACTS_NO_PAYMENT } from '@/lib/festival-brain/system-prompt'

test('the EFT-lane facts assert no payment METHOD', () => {
  // The contradiction that produced "where to pay via bank transfer": the agent
  // was told to name no method, while these facts named one.
  assert.match(VENDOR_FACTS, /pay their stall fee by card \(Yoco\)/)
  assert.doesNotMatch(VENDOR_FACTS_NO_PAYMENT, /Yoco/)
  assert.doesNotMatch(VENDOR_FACTS_NO_PAYMENT, /by card/)
})

test('everything a vendor actually needs survives the strip', () => {
  for (const keep of ['Halaal Certificate', 'cthalaal.co.za/apply', 'R6,500', 'gate passes', 'tax invoice']) {
    assert.ok(VENDOR_FACTS_NO_PAYMENT.includes(keep), `lost: ${keep}`)
  }
})

test('neither variant has ever contained a vendor pack', () => {
  for (const v of [VENDOR_FACTS, VENDOR_FACTS_NO_PAYMENT]) {
    assert.doesNotMatch(v, /vendor pack|welcome pack|info pack/i)
  }
})
