import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getRequiredDocs, extraRequiredDocs, withExtraRequiredDoc } from './required-docs'

test('REQDOC marker add/remove round-trips and merges into required list', () => {
  const base = '⟦STALL:FS12⟧ note'
  const added = withExtraRequiredDoc(base, 'gas_cert', true)
  assert.match(added, /⟦STALL:FS12⟧/)
  assert.deepEqual(extraRequiredDocs(withExtraRequiredDoc(added, 'gas_cert', true)), ['gas_cert'])
  assert.deepEqual(getRequiredDocs({ productCategories: ['Fashion'], admin_notes: added }), ['gas_cert'])
  assert.deepEqual(extraRequiredDocs('⟦REQDOC:bogus⟧'), [])
  const removed = withExtraRequiredDoc(added, 'gas_cert', false)
  assert.equal(removed, base)
})
