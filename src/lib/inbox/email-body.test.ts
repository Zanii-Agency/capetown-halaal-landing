import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripMimeMultipart, cleanEmailText } from '@/lib/inbox/email-body'

// The support inbox showed raw MIME boundaries ("--000...Content-Type:") and
// ⟦ATTACH:…⟧ markers in previews/bodies. cleanEmailText must return plain text.

test('plain text passes through unchanged', () => {
  assert.equal(cleanEmailText('Hi, can I still pay my stall fee?'), 'Hi, can I still pay my stall fee?')
})

test('multipart body extracts the text/plain part', () => {
  const raw = [
    '--000000000000f9eeb1065adf5b02',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Hello, please send my invoice.',
    '--000000000000f9eeb1065adf5b02',
    'Content-Type: text/html; charset="UTF-8"',
    '',
    '<div>Hello, please send my invoice.</div>',
    '--000000000000f9eeb1065adf5b02--',
  ].join('\n')
  assert.equal(stripMimeMultipart(raw), 'Hello, please send my invoice.')
  const cleaned = cleanEmailText(raw)
  assert.ok(!cleaned.includes('--000000000000'), 'no boundary')
  assert.ok(!/Content-Type/i.test(cleaned), 'no part headers')
  assert.ok(cleaned.includes('Hello, please send my invoice.'))
})

test('multipart with only text/html strips tags', () => {
  const raw = [
    '--BOUND_ARY_1234',
    'Content-Type: text/html; charset="UTF-8"',
    '',
    '<p>See you at the <b>festival</b>.</p>',
    '--BOUND_ARY_1234--',
  ].join('\n')
  const cleaned = cleanEmailText(raw)
  assert.ok(!cleaned.includes('<'), 'tags stripped')
  assert.ok(cleaned.includes('festival'))
})

test('NESTED multipart (mixed > alternative > plain) is unwrapped', () => {
  const raw = [
    '--OUTER_00000000',
    'Content-Type: multipart/alternative; boundary="INNER_11111111"',
    '',
    '--INNER_11111111',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Salaam, is my stall confirmed?',
    '--INNER_11111111',
    'Content-Type: text/html; charset="UTF-8"',
    '',
    '<p>Salaam, is my stall confirmed?</p>',
    '--INNER_11111111--',
    '--OUTER_00000000--',
  ].join('\n')
  const cleaned = cleanEmailText(raw)
  assert.ok(!cleaned.includes('--'), 'no boundary leaks')
  assert.ok(!/Content-Type/i.test(cleaned), 'no headers leak')
  assert.equal(cleaned, 'Salaam, is my stall confirmed?')
})

test('⟦ATTACH:…⟧ marker is dropped from the text', () => {
  const raw = 'Sent from my iPhone\n\n⟦ATTACH:W3siZmlsZW5hbWUiOiJ4In1d⟧'
  const cleaned = cleanEmailText(raw)
  assert.ok(!cleaned.includes('ATTACH'), 'no ATTACH marker')
  assert.ok(cleaned.includes('Sent from my iPhone'))
})

test('RFC822 header block is stripped', () => {
  const raw = 'Return-Path: <x@y.com>\r\nReceived: from mail\r\nSubject: hi\r\n\r\nThe actual message.'
  assert.equal(cleanEmailText(raw), 'The actual message.')
})
