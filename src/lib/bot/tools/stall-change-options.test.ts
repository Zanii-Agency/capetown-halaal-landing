import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TIER_META } from '@/lib/stalls'

// Taona 2026-07-30: "from now on when they request to change it must only be
// limited to the available options not something custom", and again:
// "basically the vendor should only request to change within the available
// options".
//
// The request that forced this was a "2.4m x 1.8m trailer", which reached the
// approval queue as free text and could not be actioned, because it is not a
// size the festival sells. The portal has validated against TIER_META since it
// shipped. The bot did not, so the bot was the only door custom sizes came in.

const REG = readFileSync(join(process.cwd(), 'src/lib/bot/tools/registry.ts'), 'utf8')
const DEF = REG.slice(REG.indexOf("name: 'request_stall_change'"), REG.indexOf("name: 'get_payment_due_date'"))
const FN = REG.slice(REG.indexOf('async function requestStallChange'), REG.indexOf('async function requestStallChange') + 2400)

function enumSlugs(): string[] {
  const block = DEF.slice(DEF.indexOf('enum: ['), DEF.indexOf(']', DEF.indexOf('enum: [')))
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

test('the tool offers exactly the tiers we actually sell', () => {
  // Drift in EITHER direction breaks a vendor. A tier in TIER_META but not the
  // enum cannot be requested at all; a slug in the enum but not TIER_META is
  // rejected by the executor, which is the dead end we just removed.
  assert.deepEqual(enumSlugs().sort(), Object.keys(TIER_META).sort())
})

test('the model cannot emit a custom size', () => {
  const props = DEF.slice(DEF.indexOf('requested_tier'))
  assert.ok(/enum: \[/.test(props), 'requested_tier must be an enum, never open string')
})

test('the executor validates too, because a schema only binds the model', () => {
  // A model that ignores its own schema would otherwise write free text
  // straight into the approval queue: the exact failure being closed.
  assert.ok(/if \(!TIER_META\[clean\]\)/.test(FN), 'must reject an unknown slug server-side')
  assert.ok(
    FN.indexOf('if (!TIER_META[clean])') < FN.indexOf('updatePortalState'),
    'the check must precede the write, not follow it',
  )
})

test('a refusal names the alternatives instead of dead-ending', () => {
  // The whole bug was a dead end. Refusing without saying what IS available
  // just moves it into the conversation.
  assert.ok(/Object\.entries\(TIER_META\)/.test(FN), 'must build the menu from the real tiers')
  assert.ok(/Which one would you like/.test(FN), 'must ask them to choose')
})

test('the vendor-facing refusal carries no long dash (law 7)', () => {
  const strings = FN.match(/`[^`]*`/g) || []
  assert.equal(/[—–]/.test(strings.join(' ')), false)
})

test('every offered tier has a real price to quote', () => {
  for (const slug of enumSlugs()) {
    assert.ok(TIER_META[slug], `${slug} missing from TIER_META`)
    assert.ok(TIER_META[slug].price > 0, `${slug} has no price`)
  }
})
