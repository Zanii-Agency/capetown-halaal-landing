import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientIp } from './abuse-guard'
import { verifySignature } from '@/lib/whatsapp'

// Regression guards for the account-takeover / drain hardening pass.

test('clientIp: trusted edge header wins over spoofable x-forwarded-for (MED-1)', () => {
  const h = new Headers({
    'x-forwarded-for': '6.6.6.6',          // attacker-controlled
    'cf-connecting-ip': '1.2.3.4',          // edge-set, trusted
  })
  assert.equal(clientIp(h), '1.2.3.4')
})

test('clientIp: vercel header trusted over xff', () => {
  const h = new Headers({ 'x-forwarded-for': '6.6.6.6', 'x-vercel-forwarded-for': '9.9.9.9, 1.1.1.1' })
  assert.equal(clientIp(h), '9.9.9.9')
})

test('clientIp: falls back to xff only when no trusted header (local dev)', () => {
  const h = new Headers({ 'x-forwarded-for': '5.5.5.5, 1.1.1.1' })
  assert.equal(clientIp(h), '5.5.5.5')
})

test('clientIp: undefined when nothing present', () => {
  assert.equal(clientIp(new Headers()), undefined)
})

// verifySignature captures WHATSAPP_APP_SECRET at module load. The bare node
// test runner doesn't load .env, so the secret is unset here and we exercise the
// no-secret branch — exactly the HIGH-2 fail-closed regression we care about.
const SECRET_UNSET = !process.env.WHATSAPP_APP_SECRET

test('verifySignature: rejects an empty/missing signature header', () => {
  assert.equal(verifySignature('body', null), false)
  assert.equal(verifySignature('body', ''), false)
})

test('verifySignature: FAILS CLOSED when secret missing and no explicit dev opt-in (HIGH-2)', { skip: !SECRET_UNSET }, () => {
  delete process.env.WHATSAPP_ALLOW_UNSIGNED
  // Even a well-formed-looking signature is rejected with no secret configured.
  assert.equal(verifySignature('body', 'sha256=deadbeef'), false)
})

test('verifySignature: dev opt-in only via explicit WHATSAPP_ALLOW_UNSIGNED=1', { skip: !SECRET_UNSET }, () => {
  process.env.WHATSAPP_ALLOW_UNSIGNED = '1'
  assert.equal(verifySignature('body', null), true)
  process.env.WHATSAPP_ALLOW_UNSIGNED = '0'
  assert.equal(verifySignature('body', null), false)
  delete process.env.WHATSAPP_ALLOW_UNSIGNED
})
