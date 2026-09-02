import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTag, encodeTag } from './tag-state'

test('a star survives a write/read round trip', () => {
  assert.deepEqual(parseTag(encodeTag(true, null)), { starred: true, tag: null })
  assert.deepEqual(parseTag(encodeTag(false, null)), { starred: false, tag: null })
})

test('star and operational tag coexist in the one column', () => {
  const encoded = encodeTag(true, 'payment')
  assert.equal(encoded, 'starred|payment')
  assert.deepEqual(parseTag(encoded), { starred: true, tag: 'payment' })
})

test('unstarring keeps the tag, and untagging keeps the star', () => {
  // Read-modify-write: losing the sibling value on either action is the bug
  // this encoding exists to avoid.
  const both = encodeTag(true, 'contract')
  const unstarred = encodeTag(false, parseTag(both).tag)
  assert.deepEqual(parseTag(unstarred), { starred: false, tag: 'contract' })

  const untagged = encodeTag(parseTag(both).starred, null)
  assert.deepEqual(parseTag(untagged), { starred: true, tag: null })
})

test('empty and null decode to a clean state rather than throwing', () => {
  for (const v of [null, undefined, '', '   ', '||']) {
    assert.deepEqual(parseTag(v), { starred: false, tag: null }, `input: ${JSON.stringify(v)}`)
  }
})

test('an empty state encodes to NULL, not an empty string', () => {
  // The column is nullable and "" would read as a tag that is not there.
  assert.equal(encodeTag(false, null), null)
})

test('whitespace and ordering do not change the meaning', () => {
  assert.deepEqual(parseTag(' starred | payment '), { starred: true, tag: 'payment' })
  assert.deepEqual(parseTag('payment|starred'), { starred: true, tag: 'payment' })
})

test('a legacy bare tag written before stars existed still decodes', () => {
  assert.deepEqual(parseTag('payment'), { starred: false, tag: 'payment' })
})
