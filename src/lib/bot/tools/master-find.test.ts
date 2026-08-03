import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeVendorText, vendorMatchesQuery } from '@/lib/bot/tools/master-registry'
import { vendorInOwnerScope } from '@/lib/eft'

// 2026-08-01: a login alert for "It's SnackTime (Hoosain Allie)" fired, Taona
// asked "how much is their stall snacktime", and the master brain answered that
// the vendor does not exist. The row is stored as "It’s SnackTime" with a CURLY
// apostrophe (U+2019); the search used a straight one (U+0027) and the literal
// ilike returned zero rows. The brain then disowned the platform's own alerts.
// These tests pin the normalisation that closes that class of miss for good.

const snacktime = {
  business_name: 'It’s SnackTime',
  contact_name: 'Hoosain Allie',
  email: 'hoosain@example.com',
  phone: '0821234567',
}

test('a straight-apostrophe query matches a curly-apostrophe business name', () => {
  // The exact miss that caused the incident.
  assert.equal(vendorMatchesQuery(snacktime, normalizeVendorText("It's SnackTime")), true)
  assert.equal(vendorMatchesQuery(snacktime, normalizeVendorText('It’s SnackTime')), true)
})

test('case, padding and punctuation variants all match', () => {
  assert.equal(vendorMatchesQuery(snacktime, normalizeVendorText('  ITS   SNACKTIME ')), true)
  assert.equal(vendorMatchesQuery(snacktime, normalizeVendorText('its snacktime')), true)
  assert.equal(vendorMatchesQuery(snacktime, normalizeVendorText('snacktime')), true)
})

test('a distinctive contact-name token finds the vendor', () => {
  assert.equal(vendorMatchesQuery(snacktime, normalizeVendorText('hoosain')), true)
  assert.equal(vendorMatchesQuery(snacktime, normalizeVendorText('Hoosain Allie')), true)
})

test('diacritics are stripped on both sides', () => {
  const v = { business_name: 'Café Lütt', contact_name: 'Renée', email: null, phone: null }
  assert.equal(vendorMatchesQuery(v, normalizeVendorText('cafe lutt')), true)
  assert.equal(vendorMatchesQuery(v, normalizeVendorText('renee')), true)
})

test('phone and email fields match too', () => {
  assert.equal(vendorMatchesQuery(snacktime, normalizeVendorText('0821234567')), true)
  assert.equal(vendorMatchesQuery(snacktime, normalizeVendorText('hoosain@example.com')), true)
})

test('a genuine non-match still returns false', () => {
  assert.equal(vendorMatchesQuery(snacktime, normalizeVendorText('turkish grand bazaar')), false)
  assert.equal(vendorMatchesQuery(snacktime, normalizeVendorText('xylophone')), false)
})

test('empty query never matches', () => {
  assert.equal(vendorMatchesQuery(snacktime, ''), false)
})

test('an EFT-lane vendor matched fuzzily is STILL outside the owner scope', () => {
  // The fallback widens recall, never the lane. "It’s SnackTime" carries
  // eft_revealed/submitted/collected stamps; the owner must not see her.
  const portal = Buffer.from(JSON.stringify({
    payment: {
      eft_revealed_at: '2026-07-29T08:00:00Z',
      eft_submitted_at: '2026-07-29T09:00:00Z',
      eft_collected_at: '2026-07-30T10:00:00Z',
    },
  })).toString('base64')
  const row = { ...snacktime, admin_notes: `⟦PORTAL:${portal}⟧`, paid_at: null }
  assert.equal(vendorMatchesQuery(row, normalizeVendorText("It's SnackTime")), true)
  assert.equal(vendorInOwnerScope(row.admin_notes, row.paid_at), false)
})
