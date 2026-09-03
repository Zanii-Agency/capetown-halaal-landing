import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBedouinEligible, BEDOUIN_TIER } from '@/lib/stalls'

// The Outdoor Bedouin tent is reserved for arts / crafts / toy vendors
// (operator rule, 2026-09-03). There is no arts-and-craft product_category in
// the data, so eligibility matches free-text business_name/description. These
// cases are real vendors from production: the block must catch craft/toy
// vendors and MUST NOT catch food vendors whose copy says "artisanal".

test('BEDOUIN_TIER is the outdoor bedouin slug', () => {
  assert.equal(BEDOUIN_TIER, 'outdoor-bedouin-2x3')
})

test('eligible: crafts / toys / handmade / henna art', () => {
  for (const v of [
    { business_name: 'Calm Crafters', business_description: 'handmade goods' },
    { business_name: 'Moonbunny Crafters', business_description: 'Handcrafted customisable designs' },
    { business_name: 'Chantel Toys', business_description: 'Novelties and glows' },
    { business_name: 'Baitul Hikmah', business_description: 'Islamic books and toys' },
    { business_name: 'Lucky Art and crafts', business_description: '' },
    { business_name: 'Shifa henna art', business_description: 'I am a henna artist' },
    { business_name: 'Ancient Days', business_description: 'a collection of handmade craft items' },
  ]) {
    assert.equal(isBedouinEligible(v), true, `${v.business_name} should be eligible`)
  }
})

test('NOT eligible: food vendors (never match bare "art" in "artisanal")', () => {
  for (const v of [
    { business_name: 'Le Sucre Artisanal Treats', business_description: 'artisanal desserts' },
    { business_name: 'Cophia Coffee Co', business_description: 'Hot and Iced Artisanal Coffees' },
    { business_name: 'jimmalos trading', business_description: 'general goods' },
    { business_name: 'Shawarmas all types', business_description: 'shawarma' },
    // Deliberate conservative boundary: food says "handcrafted" too, so the
    // single word "handcrafted" alone is NOT enough to enter the tent.
    { business_name: 'Cocoa Loco', business_description: 'handcrafted chocolates' },
    { business_name: '', business_description: '' },
  ]) {
    assert.equal(isBedouinEligible(v), false, `${v.business_name || '(empty)'} should NOT be eligible`)
  }
})
