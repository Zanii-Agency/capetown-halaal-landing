import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchFaq, FAQ } from './faq'
import { classifyIntent, intentFaqKeys } from './intents'

const VAT_TRIGGERS = [
  'are you vat registered',
  'can i get a vat invoice',
  'will my invoice show vat',
  'do you charge vat',
  'what is your vat number',
  'i need a tax invoice',
  'invoice for tax purposes',
]

const TABLE_CHAIR_TRIGGERS = [
  'do i get a table',
  'how many chairs do i get',
  'is furniture included',
  'do i need to bring my own table',
  'what size trestle table',
  'is a table and chairs included in the stall price',
]

test('VAT questions reach the invoice/VAT entry', () => {
  for (const msg of VAT_TRIGGERS) {
    const hit = matchFaq(msg)
    assert.equal(hit?.key, 'vendor_invoice_vat', `expected vendor_invoice_vat for: ${msg}`)
  }
})

test('table and chair questions reach the furniture entry', () => {
  for (const msg of TABLE_CHAIR_TRIGGERS) {
    const hit = matchFaq(msg)
    assert.equal(hit?.key, 'vendor_table_chairs', `expected vendor_table_chairs for: ${msg}`)
  }
})

test('VAT entry maps to the vendor_payment intent for grounding', () => {
  for (const msg of VAT_TRIGGERS) {
    const intent = classifyIntent(msg)
    const allowed = new Set(intentFaqKeys(intent.intent))
    assert.ok(allowed.has('vendor_invoice_vat'), `intent ${intent.intent} should carry vendor_invoice_vat for: ${msg}`)
  }
})

test('table/chairs entry maps to the vendor_status intent for grounding', () => {
  for (const msg of TABLE_CHAIR_TRIGGERS) {
    const intent = classifyIntent(msg)
    const allowed = new Set(intentFaqKeys(intent.intent))
    assert.ok(allowed.has('vendor_table_chairs'), `intent ${intent.intent} should carry vendor_table_chairs for: ${msg}`)
  }
})

test('VAT and furniture facts state the operational truth', () => {
  const vat = FAQ.vendor_invoice_vat
  assert.match(vat.fact, /not VAT registered/i)
  assert.match(vat.fact, /invoices do not show VAT/i)
  assert.match(vat.answer, /not VAT registered/i)
  assert.doesNotMatch(vat.answer, /[—–]/, 'no-em-dashes law (CTH-DOCTRINE 7)')

  const furniture = FAQ.vendor_table_chairs
  assert.match(furniture.fact, /1\.8m trestle table/i)
  assert.match(furniture.fact, /2 chairs/i)
  assert.match(furniture.answer, /1\.8m trestle table/i)
  assert.match(furniture.answer, /two chairs/i)
  assert.doesNotMatch(furniture.answer, /[—–]/, 'no-em-dashes law (CTH-DOCTRINE 7)')
})
