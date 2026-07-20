// Sector helpers for the admin allocation filter.
//
// Vendor rows carry `categories` in two shapes: newer rows store the proper-case
// canonical label ("Food & Beverage"), legacy rows store lowercase fragments
// ("food", "beverage", "halal"). The raw distinct set leaks dupes into the
// "All sectors" dropdown. These helpers fold every raw value down to the fixed
// canonical sector set (plus a single "Other" bucket) so the dropdown is clean
// and the page's sector matching stays consistent with what the dropdown shows.

import { canonicalSector } from '@/lib/sector-map'

/** Sentinel option for categories that don't map to any canonical sector. */
export const OTHER_SECTOR = 'Other'

interface HasCategories {
  categories?: string[] | null
}

/**
 * Build the deduped, canonical sector option list present in the given apps.
 * Returns canonical sector labels sorted alphabetically, with "Other" appended
 * only when at least one raw category fails to canonicalise.
 */
export function discoverCanonicalSectors(apps: HasCategories[]): string[] {
  const seen = new Set<string>()
  let hasOther = false
  for (const a of apps) {
    for (const c of a.categories || []) {
      if (!c) continue
      const canon = canonicalSector(c)
      if (canon) seen.add(canon)
      else hasOther = true
    }
  }
  const sorted = [...seen].sort((x, y) => x.localeCompare(y))
  if (hasOther) sorted.push(OTHER_SECTOR)
  return sorted
}

/**
 * True when the app belongs to the given canonical sector. For OTHER_SECTOR,
 * matches apps with at least one category that canonicalises to null. Comparing
 * against the canonical bucket (not the raw string) is what lets a legacy
 * "food" row match the "Food & Beverage" dropdown option.
 */
export function appInSector(app: HasCategories, sector: string): boolean {
  const cats = app.categories || []
  if (sector === OTHER_SECTOR) {
    return cats.some((c) => c && canonicalSector(c) === null)
  }
  return cats.some((c) => canonicalSector(c) === sector)
}
