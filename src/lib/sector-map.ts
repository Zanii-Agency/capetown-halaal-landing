/**
 * Deterministic sector classifier for vendor_applications.
 *
 * Maps a vendor's product_categories (comma-separated string OR string[]) plus
 * their business_description down to one of 8 fixed sectors. Returns
 * { sector: null, confidence: 0 } when nothing matches — never guesses.
 *
 * Confidence model: 1.0 when product_categories alone hit the rule,
 *                   0.6 when only business_description fired,
 *                   0 when nothing fired.
 *
 * Used by scripts/derive-sectors.mjs for the one-shot backfill of the new
 * `sector` column on vendor_applications. Pure / no side effects.
 */

export type Sector =
  | 'Food & Beverage'
  | 'Fashion & Modest Wear'
  | 'Beauty & Wellness'
  | 'Health & Pharmacy'
  | 'Business & Trade'
  | 'Home & Living'
  | 'Travel & Tourism'
  | 'Advertising'

export interface SectorResult {
  sector: Sector | null
  confidence: number
}

// Ordered: earlier sectors win ties. Food & Beverage first because it's the
// largest CTH category and tokens like "ice cream" must not collide with
// generic "cream" inside Beauty rules.
const SECTOR_RULES: Array<{ sector: Sector; tokens: string[] }> = [
  {
    sector: 'Food & Beverage',
    tokens: [
      'food', 'halal meat', 'spices', 'restaurant', 'beverage', 'juice',
      'dessert', 'baking', 'catering', 'food truck', 'ice cream', 'coffee', 'tea',
    ],
  },
  {
    sector: 'Fashion & Modest Wear',
    tokens: ['abaya', 'hijab', 'modest', 'fashion', 'clothing', 'garment', 'scarf', 'jilbab', 'thobe', 'kaftan'],
  },
  {
    sector: 'Beauty & Wellness',
    tokens: ['skincare', 'perfume', 'cosmetic', 'hair', 'makeup', 'attar', 'oud', 'oils', 'beauty'],
  },
  {
    sector: 'Health & Pharmacy',
    tokens: ['supplement', 'pharmacy', 'wellness', 'herbal', 'vitamin', 'medical', 'fitness'],
  },
  {
    sector: 'Business & Trade',
    tokens: ['b2b', 'wholesale', 'import', 'export', 'distributor', 'agency', 'consulting'],
  },
  {
    sector: 'Home & Living',
    tokens: ['furniture', 'decor', 'home', 'prayer mat', 'accessories', 'lighting', 'art'],
  },
  {
    sector: 'Travel & Tourism',
    tokens: ['travel', 'umrah', 'hajj', 'tourism', 'agency travel', 'packages'],
  },
  {
    sector: 'Advertising',
    tokens: ['advertising', 'marketing', 'media', 'signage'],
  },
]

function normalizeCategories(input: string | string[] | null | undefined): string[] {
  if (input == null) return []
  const raw = Array.isArray(input) ? input.join(',') : input
  return raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
}

function matchAny(haystack: string, tokens: string[]): boolean {
  for (const token of tokens) {
    if (haystack.includes(token)) return true
  }
  return false
}

/**
 * Derive the sector for a single vendor row. Accepts the categories as either
 * a comma-separated string (DB shape) or a string[] (typed shape) — both are
 * handled to avoid a footgun at the call site.
 */
export function deriveSector(
  productCategories: string | string[] | null,
  businessDescription: string | null,
): SectorResult {
  const cats = normalizeCategories(productCategories)
  const catBlob = cats.join(' | ')
  const descBlob = (businessDescription || '').toLowerCase()

  for (const rule of SECTOR_RULES) {
    if (catBlob && matchAny(catBlob, rule.tokens)) {
      return { sector: rule.sector, confidence: 1.0 }
    }
  }

  for (const rule of SECTOR_RULES) {
    if (descBlob && matchAny(descBlob, rule.tokens)) {
      return { sector: rule.sector, confidence: 0.6 }
    }
  }

  return { sector: null, confidence: 0 }
}

export const SECTORS: ReadonlyArray<Sector> = SECTOR_RULES.map((r) => r.sector)

/**
 * Canonicalise a single raw category string (e.g. "food", "beverage", "halal",
 * "Food & Beverage") to one of the fixed {@link Sector} labels. Returns null
 * when nothing matches, so the caller can bucket unmatched values under a
 * single "Other" label instead of leaking lowercase dupes into a dropdown.
 *
 * Pure / no side effects. Used by the admin allocation sector filter to dedupe
 * the legacy + proper-case category soup down to the canonical set.
 */
export function canonicalSector(raw: string | null | undefined): Sector | null {
  if (!raw) return null
  const blob = raw.trim().toLowerCase()
  if (!blob) return null
  // Exact canonical match first (proper-case rows already store the label).
  for (const rule of SECTOR_RULES) {
    if (rule.sector.toLowerCase() === blob) return rule.sector
  }
  // Token match for legacy lowercase fragments ("food", "beverage", "halal"…).
  for (const rule of SECTOR_RULES) {
    if (matchAny(blob, rule.tokens)) return rule.sector
  }
  return null
}
