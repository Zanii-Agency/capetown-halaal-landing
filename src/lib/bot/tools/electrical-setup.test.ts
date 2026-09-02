import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// get_electrical_setup lets a vendor ask the bot what power, appliances and gas
// they booked. Taona 2026-08-03, after the size/price fix: "build electricity/
// gas/setup into the bot". A vendor arriving with a freezer they never booked
// power for is the festival-day failure this closes.
//
// THE TRAP (caught before shipping): electrical_appliances is a human-readable
// STRING for 218 of 242 approved vendors ("1x Charger/Lighting (R400)") and an
// object for only 7. computeVendorPricing parses only the object form, so a
// first cut that read power from pricing.electricalItems told 83 string-form
// vendors "you have no power" while they had booked it. The tool must read the
// RAW field, not the pricing line items.

const REG = readFileSync(join(process.cwd(), 'src/lib/bot/tools/registry.ts'), 'utf8')
const S = REG.indexOf('async function getElectricalSetup')
const FN = REG.slice(S, REG.indexOf('async function', S + 20))

test('the tool is registered and dispatched', () => {
  assert.ok(/name: 'get_electrical_setup'/.test(REG), 'must be in TOOL_DEFS')
  assert.ok(/case 'get_electrical_setup':/.test(REG), 'must be wired in the executor')
})

test('power is read from the RAW string field, not only the pricing parser', () => {
  // The exact regression: 218/242 vendors store it as a string. Reading that
  // string is the only correct source.
  assert.ok(/reqs\.electrical_appliances/.test(FN), 'reads the raw field')
  assert.ok(/typeof elec === 'string'/.test(FN), 'handles the string form (the 218-vendor majority)')
})

test('the "no power" verdict comes from the raw value, not pricing item count', () => {
  // If noPower were derived from computeVendorPricing(...).electricalItems.length
  // it would be wrong for every string-form vendor. It must key off the raw
  // string being empty or "None".
  assert.ok(/const noPower = !power/.test(FN), 'no-power keys off the raw power string')
  assert.ok(/none/i.test(FN), 'treats "1x None (R0)" / "None" as no power')
  assert.equal(/noPower\s*=.*electricalItems\.length/.test(FN), false, 'must NOT decide no-power from pricing items')
})

test('it also reports appliances and gas, with the gas certificate reminder', () => {
  assert.ok(/appliance_details/.test(FN), 'reads the appliance list they are bringing')
  assert.ok(/uses_gas/.test(FN), 'reads the gas flag')
  assert.ok(/gas compliance certificate/i.test(FN), 'reminds about the required gas cert')
})

test('the no-power case is stated plainly so a vendor is not caught out', () => {
  assert.ok(/NOT booked any electrical power/.test(FN))
  assert.ok(/no power point/.test(FN))
})

test('the copy carries no long dash (law 7)', () => {
  const strings = FN.match(/`[^`]*`/g) || []
  const single = FN.match(/'[^']*'/g) || []
  assert.equal(/[—–]/.test([...strings, ...single].join(' ')), false)
})
