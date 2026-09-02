import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reminderWaBody, segFromWeek } from './reminder-copy'

const DUE = new Date('2026-09-15T00:00:00Z')

const forbidden = (s: string) => {
  assert.ok(!/RR/.test(s), `double-R in: ${s}`)
  assert.ok(!/[—–]/.test(s), `em/en-dash in: ${s}`)
  assert.ok(!/\b(eft|yoco|bank|card)\b/i.test(s), `names a payment method: ${s}`)
  assert.ok(/cthalaal\.co\.za\/exhibitor\/portal\/payments/.test(s), `no portal push: ${s}`)
}

test('not-yet-due: correct date, amount, portal push, no RR', () => {
  const b = reminderWaBody({ amount: 6400, due: DUE, daysRemaining: 20, seg: 'intro', arrangementUntil: null })
  forbidden(b)
  assert.ok(/R6\s400/.test(b), b) // formatRand uses a non-breaking space
  assert.ok(/due on 15 September 2026/.test(b), b)
  assert.ok(!/overdue/.test(b), b)
})

test('overdue: states how overdue + waiting list, never "due on <past date>"', () => {
  const b = reminderWaBody({ amount: 3700, due: new Date('2026-07-30T00:00:00Z'), daysRemaining: -11, seg: 'nudge', arrangementUntil: null })
  forbidden(b)
  assert.ok(/11 days overdue/.test(b), b)
  assert.ok(/waiting list/.test(b), b)
  assert.ok(!/due on/.test(b), b)
})

test('firm overdue: escalates to a final notice', () => {
  const b = reminderWaBody({ amount: 8100, due: new Date('2026-07-30T00:00:00Z'), daysRemaining: -11, seg: 'firm', arrangementUntil: null })
  assert.ok(/final notice/i.test(b), b)
})

test('extension: acknowledges the date, asks to pay by it, never a final notice', () => {
  const b = reminderWaBody({ amount: 6500, due: new Date('2026-07-21T00:00:00Z'), daysRemaining: -20, seg: 'firm', arrangementUntil: '2026-08-31' })
  forbidden(b)
  assert.ok(/given until 31 August 2026/.test(b), b)
  assert.ok(!/final notice/i.test(b), b)
})

test('segFromWeek: 1 intro, 2-3 nudge, 4 firm', () => {
  assert.equal(segFromWeek(1), 'intro')
  assert.equal(segFromWeek(3), 'nudge')
  assert.equal(segFromWeek(4), 'firm')
})
