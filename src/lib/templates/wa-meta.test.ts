import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  waBroadcastVariables,
  PAID_VENDOR_MESSAGE_TEMPLATE_KEYS,
  PAYMENT_CHECK_MESSAGE_TEMPLATE_KEYS,
  findWaTemplate,
} from './wa-meta'

test('paid-cohort templates map to a strict [first_name, message] pair', () => {
  const out = waBroadcastVariables('paid_vendor_update', {
    firstName: 'Aisha',
    businessName: 'Aisha Eats',
    stallCode: 'F-12',
    message: 'Setup opens Thursday.',
  })
  // business_name / stall_code must NOT leak into the message slot for this suite.
  assert.deepEqual(out, ['Aisha', 'Setup opens Thursday.'])
})

test('a missing first name falls back to "there" (Meta rejects an empty var)', () => {
  const out = waBroadcastVariables('paid_vendor_question', { firstName: '', message: 'When do you arrive?' })
  assert.equal(out[0], 'there')
})

test('raw newlines/tabs in the message are collapsed to one flowing line', () => {
  // Meta rejects newlines inside a body parameter; this flattened a prod digest twice.
  const out = waBroadcastVariables('paid_vendor_action_required', {
    firstName: 'Aisha',
    message: 'Line one.\n\nLine two.\tTabbed.   Spaced.',
  })
  assert.equal(out[1], 'Line one. Line two. Tabbed. Spaced.')
  assert.ok(!/[\r\n\t]/.test(out[1]))
})

test('legacy templates keep [name, business, stall, message] and drop empty slots', () => {
  assert.deepEqual(
    waBroadcastVariables('general_announcement', {
      firstName: 'Aisha',
      businessName: 'Aisha Eats',
      stallCode: '',
      message: 'Hello',
    }),
    ['Aisha', 'Aisha Eats', 'Hello'], // empty stall dropped, not shifted
  )
})

test('every payment-check key is a registered UTILITY 2-var template that maps to [name, message]', () => {
  for (const key of PAYMENT_CHECK_MESSAGE_TEMPLATE_KEYS) {
    const spec = findWaTemplate(key)
    assert.ok(spec, `${key} missing from WA_META_TEMPLATES`)
    assert.equal(spec!.category, 'utility', `${key} must be UTILITY to dodge the marketing cap`)
    assert.equal(spec!.params.length, 2, `${key} must take exactly [first_name, message]`)
    // The var mapper must treat it as a two-var template, not the legacy 4-slot order.
    assert.deepEqual(
      waBroadcastVariables(key, { firstName: 'Aisha', businessName: 'X', stallCode: 'F-1', message: 'Pay please' }),
      ['Aisha', 'Pay please'],
    )
  }
})

test('every paid-cohort key is registered with 2 params and UTILITY, except the one Meta stamped MARKETING', () => {
  // Meta re-categorised good_news to MARKETING on approval; kept by operator
  // decision. The registry must reflect Meta (source of truth), and this guard
  // still catches any OTHER template accidentally shipping as marketing.
  const KNOWN_MARKETING = new Set<string>(['paid_vendor_good_news'])
  for (const key of PAID_VENDOR_MESSAGE_TEMPLATE_KEYS) {
    const spec = findWaTemplate(key)
    assert.ok(spec, `${key} missing from WA_META_TEMPLATES`)
    assert.equal(spec!.params.length, 2, `${key} must take exactly [first_name, message]`)
    const expected = KNOWN_MARKETING.has(key) ? 'marketing' : 'utility'
    assert.equal(spec!.category, expected, `${key} category must match Meta (${expected})`)
  }
})
