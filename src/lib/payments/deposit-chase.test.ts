import { test } from 'node:test'
import assert from 'node:assert/strict'
import { depositStage, reminderText, finalText, alertText } from './deposit-chase'

test('stages follow the agreed timeline', () => {
  const a = '2026-10-15'
  assert.equal(depositStage(a, '2026-10-16'), null) // day 1
  assert.equal(depositStage(a, '2026-10-17'), null) // day 2, deposit due
  for (const d of ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']) assert.equal(depositStage(a, d), 'reminder')
  assert.equal(depositStage(a, '2026-10-22'), 'final') // day 7
  assert.equal(depositStage(a, '2026-10-23'), 'alert') // day 8
})

test('copy is dash-free and points to the portal, not email', () => {
  for (const t of [reminderText(1300, '2026-10-17'), finalText(1300), alertText('Biz', 1300, '2026-10-17')]) {
    assert.doesNotMatch(t, /[—–]/)
  }
  assert.match(reminderText(1300, '2026-10-17'), /exhibitor portal/)
  assert.doesNotMatch(reminderText(1300, '2026-10-17'), /support@/)
  assert.match(finalText(1300), /24 hours/)
})
