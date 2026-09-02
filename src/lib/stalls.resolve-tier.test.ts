import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTierSlug, TIER_META } from './stalls'

test('passes through an existing slug', () => {
  assert.equal(resolveTierSlug('marquee-full-3x3'), 'marquee-full-3x3')
})

test('resolves the MaterniTee free-text request', () => {
  assert.equal(resolveTierSlug('3x3m Full Marquee'), 'marquee-full-3x3')
})

test('disambiguates the shared 3x3 dimension by type keyword', () => {
  assert.equal(resolveTierSlug('Food Gazebo 3x3'), 'food-gazebo-3x3')
  assert.equal(resolveTierSlug('marquee full 3×3'), 'marquee-full-3x3')
})

test('resolves unambiguous dimensions', () => {
  assert.equal(resolveTierSlug('6x3'), 'marquee-full-double-6x3')
  assert.equal(resolveTierSlug('4x2 double table'), 'marquee-table-double-4x2')
  assert.equal(resolveTierSlug('2x2m'), 'marquee-table-2x2')
  assert.equal(resolveTierSlug('outdoor bedouin 2x3'), 'outdoor-bedouin-2x3')
})

test('resolves truck lengths', () => {
  assert.equal(resolveTierSlug('food truck 6m'), 'food-truck-6m')
  assert.equal(resolveTierSlug('4.5m truck'), 'food-truck-4.5m')
})

test('returns null rather than guess when ambiguous or unparseable', () => {
  assert.equal(resolveTierSlug('3x3'), null) // 3x3 alone: marquee-full vs food-gazebo, no keyword
  assert.equal(resolveTierSlug('a bigger stall please'), null)
  assert.equal(resolveTierSlug(''), null)
  assert.equal(resolveTierSlug(null), null)
})

test('every resolved value is a real TIER_META key', () => {
  for (const s of ['3x3m Full Marquee', '6x3', 'food truck 8m', '2x2']) {
    const r = resolveTierSlug(s)
    if (r !== null) assert.ok(TIER_META[r], `${r} must be a TIER_META key`)
  }
})
