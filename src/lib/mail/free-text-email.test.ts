import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freeTextParts, renderFreeTextEmail } from './templates'
import { applianceList } from '../vendor-extras'

test('free text keeps paragraphs + line breaks, moves a typed sign-off into the layout', () => {
  const r = freeTextParts('Hi Sam,\n\nLine one\nline two\n\nKind regards,\nSamreen')
  assert.deepEqual(r.paragraphs, ['Hi Sam,', 'Line one\nline two'])
  assert.equal(r.signoff, 'Kind regards,')
  assert.equal(freeTextParts('Just one note').signoff, undefined)
})

test('free text renders inside the branded layout, escaped, with breaks', async () => {
  const html = await renderFreeTextEmail('Hi <b>\n\nA\nB', 'Stall update', 'https://x/u')
  assert.match(html, /Young at Heart Festival Team/)
  assert.match(html, /Stall update/)
  assert.match(html, /A<br\/>B/)
  assert.match(html, /&lt;b&gt;/)
})

test('appliance map renders as a list, not [object Object]', () => {
  assert.equal(applianceList({ 'small-display-fridge': 1, 'deep_fryer': 2, gone: 0 }), 'small display fridge, deep fryer x2')
  assert.equal(applianceList('Kettle'), 'Kettle')
  assert.equal(applianceList(null), '')
})
