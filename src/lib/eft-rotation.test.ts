import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tierRotationSaysEft } from '@/lib/eft'
import { SMALL_EFT_ROTATION_TIERS } from '@/lib/stalls'

// Taona 2026-08-04: steer the Yoco/EFT mix per tier. Cheap stalls (2×2, 2×3)
// rotate 2 Yoco : 1 EFT; every other tier rotates 2 EFT : 1 Yoco. The slot of
// the next payer = payments already received in that tier since activation.

const SMALL = 'marquee-table-2x2'
const BIG = 'marquee-full-3x3'

test('the two small tiers, and only those, are in the small set', () => {
  assert.deepEqual([...SMALL_EFT_ROTATION_TIERS].sort(), ['marquee-table-2x2', 'outdoor-bedouin-2x3'])
})

test('small tier rotates 2 Yoco then 1 EFT', () => {
  // slots 0,1 -> Yoco (false), slot 2 -> EFT (true), then repeat.
  assert.equal(tierRotationSaysEft(0, SMALL), false)
  assert.equal(tierRotationSaysEft(1, SMALL), false)
  assert.equal(tierRotationSaysEft(2, SMALL), true)
  assert.equal(tierRotationSaysEft(3, SMALL), false)
  assert.equal(tierRotationSaysEft(4, SMALL), false)
  assert.equal(tierRotationSaysEft(5, SMALL), true)
  // outdoor bedouin is small too
  assert.equal(tierRotationSaysEft(2, 'outdoor-bedouin-2x3'), true)
  assert.equal(tierRotationSaysEft(0, 'outdoor-bedouin-2x3'), false)
})

test('big tiers rotate 2 EFT then 1 Yoco (the mirror)', () => {
  // slots 0,1 -> EFT (true), slot 2 -> Yoco (false).
  assert.equal(tierRotationSaysEft(0, BIG), true)
  assert.equal(tierRotationSaysEft(1, BIG), true)
  assert.equal(tierRotationSaysEft(2, BIG), false)
  assert.equal(tierRotationSaysEft(3, BIG), true)
  assert.equal(tierRotationSaysEft(5, BIG), false)
  // a couple more big ones
  assert.equal(tierRotationSaysEft(2, 'food-truck-8m'), false)
  assert.equal(tierRotationSaysEft(0, 'marquee-full-double-6x3'), true)
})

test('an unknown / missing tier is treated as big (leans EFT)', () => {
  assert.equal(tierRotationSaysEft(0, 'no-such-tier'), true)
  assert.equal(tierRotationSaysEft(2, null), false)
  assert.equal(tierRotationSaysEft(0, undefined), true)
})

test('the slot math is stable for large and negative counts', () => {
  assert.equal(tierRotationSaysEft(300, SMALL), false) // 300 % 3 = 0
  assert.equal(tierRotationSaysEft(302, SMALL), true)  // 302 % 3 = 2
  assert.equal(tierRotationSaysEft(-1, SMALL), true)   // -1 normalizes to slot 2; never throws / NaNs
})

// The resolver is async + DB-backed; assert its precedence ORDER by source so a
// future edit can't reorder the guards (a rotation that ran before the paid or
// ⟦NOEFT⟧ checks would be a real routing/privacy bug).
const SRC = readFileSync(join(process.cwd(), 'src/lib/eft.ts'), 'utf8')
const FN = SRC.slice(SRC.indexOf('export async function resolveInEftLane'), SRC.indexOf('export async function resolveInEftLane') + 1400)

test('resolver overrides win before the rotation, in the right order', () => {
  const order = ['isInternalAccount', 'app.paid_at', 'hasNoEftMarker', "status === 'paid'", 'hasEftMarker', 'eft_revealed_at', "status === 'pending'", '!globalOn', 'getRotationStartAt', 'tierReceivedCount']
  let last = -1
  for (const token of order) {
    const at = FN.indexOf(token)
    assert.ok(at > -1, `resolver must contain guard: ${token}`)
    assert.ok(at > last, `guard out of order: ${token}`)
    last = at
  }
})

test('the rotation is inert until activated (no start line -> old behaviour)', () => {
  // globalOn with no start line returns the prior all-EFT behaviour (true), so a
  // deploy does nothing until the start line is set.
  assert.ok(/if \(!startAt\) return true/.test(FN))
})
