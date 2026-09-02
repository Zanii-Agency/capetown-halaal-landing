import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A CLASS of vendor questions the bot could not answer: "what stall size did I
// choose", "what's the price", "when did I apply". Rizq & Co asked exactly this
// and the bot replied "I don't see the specific stall type saved yet, it looks
// like it wasn't locked in" while a R6500 Marquee Double Table 4x2m sat on her
// application (2026-08-03).
//
// It was never a data gap: 241 of 242 approved vendors have their tier on file.
// The bot's check_application_status tool simply did not RETURN the size, the
// price or the application date, so the model guessed something was missing.
// Same seam as the master-brain due date: the fact is in the record, absent only
// from the reader the vendor talks to.

const REG = readFileSync(join(process.cwd(), 'src/lib/bot/tools/registry.ts'), 'utf8')
const AGENT = readFileSync(join(process.cwd(), 'src/lib/bot/vendor-agent.ts'), 'utf8')
const FN_START = REG.indexOf('async function checkApplicationStatus')
const FN = REG.slice(FN_START, REG.indexOf('async function', FN_START + 20))

test('the bot reads the size the vendor applied for, not just the floor allocation', () => {
  assert.ok(/tierLabel\(row\.preferred_booth_tier\)/.test(FN), 'must resolve the chosen tier to a label')
  assert.ok(/applied for/i.test(FN), 'must present it as what they applied for')
  // The old bug conflated the chosen SIZE with the allocated FLOOR code. Both
  // must appear, distinctly.
  assert.ok(/Floor stall/.test(FN), 'the allocated floor code stays, separately')
})

test('it states the price, with accessories named not folded into the stall fee', () => {
  // Price comes from the real bill model: vendorBill wraps computeVendorPricing
  // and includes add-ons, then splits stall vs accessories so the accessory
  // portion is never quoted as a bare stall price (the vendor-facing ask).
  assert.ok(/vendorBill\(/.test(FN), 'price comes from the real bill model (incl add-ons)')
  assert.ok(/at R\$\{/.test(FN), 'the price is put in the reply')
  assert.ok(/accessories/i.test(FN), 'accessories are named, not silently folded into the stall price')
  assert.ok(/liveTotal|in total/i.test(FN), 'the combined total is stated')
})

test('it states WHEN they applied', () => {
  assert.ok(/created_at/.test(FN), 'must read the application date')
  assert.ok(/Applied on/.test(FN))
  // and ownRow must actually fetch created_at, or the above is always empty
  const own = REG.slice(REG.indexOf('async function ownRow'), REG.indexOf('async function ownRow') + 900)
  assert.ok(/created_at/.test(own), 'ownRow must SELECT created_at')
})

test('the tool description tells the model it can answer size/price/when', () => {
  const def = REG.slice(REG.indexOf("name: 'check_application_status'"), REG.indexOf("name: 'check_application_status'") + 500)
  assert.ok(/stall size/i.test(def) && /price/i.test(def), 'so the model calls it for those questions')
})

test('the prompt tells the bot this is always on record, never "not saved"', () => {
  assert.ok(/always on their record/i.test(AGENT), 'positive fact: the data exists')
  // Stated positively, not by listing the banned phrase (which would prime it).
  assert.equal(/not saved|wasn't locked in|not locked in/i.test(AGENT), false, 'do not name the bad phrasing in the prompt')
})

test('the new copy carries no long dash (law 7)', () => {
  const strings = FN.match(/`[^`]*`/g) || []
  assert.equal(/[—–]/.test(strings.join(' ')), false)
})
