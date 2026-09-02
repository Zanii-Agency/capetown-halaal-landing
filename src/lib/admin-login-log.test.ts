import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientIp, loginFacts, placeLabel, isExpectedPlace, shouldAlert, alertBody } from './admin-login-log'

/** Minimal stand-in for the Headers object the route passes in. */
const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null })

test('the client IP is the FIRST entry in x-forwarded-for, not the last', () => {
  // Each proxy hop APPENDS itself, so the last entry is Vercel's own edge
  // address. Reading the last would stamp every login with the same IP and
  // make the whole log useless while looking like it worked.
  assert.equal(clientIp(h({ 'x-forwarded-for': '41.13.7.22, 10.0.0.1, 76.76.21.1' })), '41.13.7.22')
  assert.equal(clientIp(h({ 'x-forwarded-for': '  41.13.7.22  ' })), '41.13.7.22')
})

test('the IP falls back to x-real-ip, and is null when neither is present', () => {
  assert.equal(clientIp(h({ 'x-real-ip': '41.13.7.22' })), '41.13.7.22')
  assert.equal(clientIp(h({})), null)
  assert.equal(clientIp(h({ 'x-forwarded-for': '' })), null)
})

test('the city is percent-decoded, and a malformed escape does not lose the login', () => {
  assert.equal(loginFacts(h({ 'x-vercel-ip-city': 'Cape%20Town' })).city, 'Cape Town')
  // decodeURIComponent throws on a lone '%'. Keeping the raw value beats
  // throwing away the whole record over a cosmetic field.
  assert.equal(loginFacts(h({ 'x-vercel-ip-city': 'Cape%Town' })).city, 'Cape%Town')
  assert.equal(loginFacts(h({})).city, null)
})

test('Cape Town is the expected place, by region code or by city name', () => {
  assert.equal(isExpectedPlace({ ip: '1', city: 'Cape Town', region: 'WC', country: 'ZA' }), true)
  // Vercel occasionally omits the region on mobile networks; the city carries it.
  assert.equal(isExpectedPlace({ ip: '1', city: 'cape town', region: null, country: 'ZA' }), true)
  assert.equal(isExpectedPlace({ ip: '1', city: null, region: 'WC', country: 'ZA' }), true)
})

test('anywhere else is not expected, including elsewhere in South Africa', () => {
  assert.equal(isExpectedPlace({ ip: '1', city: 'Johannesburg', region: 'GP', country: 'ZA' }), false)
  assert.equal(isExpectedPlace({ ip: '1', city: 'Dubai', region: 'DU', country: 'AE' }), false)
  // No geo at all must NOT read as expected: unknown is a reason to look, not
  // a reason to stay quiet.
  assert.equal(isExpectedPlace({ ip: '1', city: null, region: null, country: null }), false)
})

const CT = { ip: '41.13.7.22', city: 'Cape Town', region: 'WC', country: 'ZA' }

test('a familiar Cape Town login does not alert', () => {
  // The whole point of the seenBefore check: she signs in most days, and an
  // alert that fires daily is one he stops reading.
  assert.equal(shouldAlert(CT, true), false)
})

test('a NEW IP alerts even from Cape Town', () => {
  assert.equal(shouldAlert(CT, false), true)
})

test('anywhere outside Cape Town alerts even on a familiar IP', () => {
  assert.equal(shouldAlert({ ...CT, city: 'Johannesburg', region: 'GP' }, true), true)
  assert.equal(shouldAlert({ ...CT, city: 'Lagos', region: null, country: 'NG' }, true), true)
})

test('the alert says who, where and why', () => {
  const body = alertBody('capetownhalaal@gmail.com', CT, true)
  assert.match(body, /capetownhalaal@gmail\.com/)
  assert.match(body, /Cape Town, ZA/)
  assert.match(body, /41\.13\.7\.22/)
  assert.match(body, /a new IP/)
  // Law 7: no em-dashes or en-dashes in any copy this project emits.
  assert.equal(/[—–]/.test(body), false)
})

test('an unknown location still produces a readable alert', () => {
  const f = { ip: null, city: null, region: null, country: null }
  assert.equal(placeLabel(f), 'an unknown location')
  const body = alertBody('someone@example.com', f, false)
  assert.match(body, /an unknown location/)
  assert.match(body, /IP unknown/)
  assert.equal(/[—–]/.test(body), false)
})
