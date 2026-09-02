import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDemoRow, type EftRowish } from './eft-rows'

const row = (business_name: string | null, email: string | null = null): EftRowish =>
  ({ business_name, email })

// ---------------------------------------------------------------------------
// The crash this module exists to prevent.
//
// isDemoRow used to be a `const` declared BELOW the sort that calls it, so the
// comparator hit the temporal dead zone and every render of /admin/eft threw.
// A sort only invokes its comparator with two or more rows, which is why a
// one-row page would have looked fine.
// ---------------------------------------------------------------------------

test('sorting demo rows to the bottom does not throw', () => {
  const rows = [
    row('Sweet Treats Demo'),
    row('Real Vendor A'),
    row('Demo Halal Kitchen'),
    row('Real Vendor B'),
  ]
  const sorted = [...rows].sort((a, b) =>
    isDemoRow(a) !== isDemoRow(b) ? (isDemoRow(a) ? 1 : -1) : 0)

  assert.deepEqual(
    sorted.map((r) => r.business_name),
    ['Real Vendor A', 'Real Vendor B', 'Sweet Treats Demo', 'Demo Halal Kitchen'],
  )
})

test('catches the two demo vendors Taona named', () => {
  assert.ok(isDemoRow(row('Sweet Treats Demo')))
  assert.ok(isDemoRow(row('Demo Halal Kitchen')))
})

test('catches internal @cthalaal.co.za addresses whatever the name is', () => {
  assert.ok(isDemoRow(row('Anything', 'dev@cthalaal.co.za')))
  assert.ok(isDemoRow(row(null, 'TAONA@CTHALAAL.CO.ZA')), 'case insensitive')
})

test('never swallows a real vendor', () => {
  for (const r of [
    row('Farfashions Apparel', 'hello@farfashions.co.za'),
    row('Kulfi Krush & That Kebab Place'),
    row('Democratic Catering'),          // "demo" only as a substring, not a word
    row('The Flower Sisters', 'x@gmail.com'),
    row(null, null),
  ]) {
    assert.equal(isDemoRow(r), false, `${r.business_name ?? r.email} must count`)
  }
})

test('an @cthalaal.co.za lookalike domain still counts as real', () => {
  assert.equal(isDemoRow(row('Real', 'someone@notcthalaal.co.za.example.com')), false)
})
