// Outside-vendor roster helpers.
//
// The festival has 65 vendors OUTSIDE the marquee that do NOT get a floor-plan
// stall code (bedouin + the three truck types — see venue-zones.ts, the
// non-allocatable zones). They still need to be rostered: which zone they sit
// in, whether they've paid, and — on setup day — a human-readable POSITION
// NUMBER inside their zone (e.g. Bedouin #7, Food Truck #12) plus a check-in.
//
// Following CTH-DOCTRINE Law 8 (DDL is blocked, no stalls/zones table), the
// position assignment is a single reversible marker on the vendor_applications
// .admin_notes row, exactly like the ⟦STALL:..⟧ allocation marker:
//
//     ⟦ZONE:bedouin:7⟧            -> Bedouin position #7
//     ⟦ZONE:food_drink_truck:12⟧  -> Food & Drink Truck position #12
//     ⟦ZONE_CHECKIN:2026-06-22T08:30:00.000Z⟧
//
// The markers never clobber Samreen's human notes — we parse them out, keep the
// prose, and re-append on write. They also never collide with the ⟦STALL:..⟧ or
// base64 ⟦PORTAL:..⟧ regexes (distinct ZONE / ZONE_CHECKIN prefixes).

import { NON_ALLOCATED_ZONES, zoneByKey, type VenueZone } from './venue-zones'

export type OutsideZoneKey = 'bedouin' | 'food_drink_truck' | 'dessert_truck' | 'snack_truck'

/** The non-allocatable zones (bedouin + trucks), in display order. */
export const OUTSIDE_ZONES: VenueZone[] = NON_ALLOCATED_ZONES

export const OUTSIDE_ZONE_KEYS: OutsideZoneKey[] = OUTSIDE_ZONES.map((z) => z.key as OutsideZoneKey)

export function isOutsideZone(key: string | null | undefined): key is OutsideZoneKey {
  return !!key && OUTSIDE_ZONE_KEYS.includes(key as OutsideZoneKey)
}

// ---- map a vendor's preferred_booth_tier slug -> outside zone key ----
//
// Tier slugs come from lib/stalls.ts TIER_META. The outside tiers are:
//   outdoor-bedouin-2x3      -> bedouin
//   food-gazebo-3x3          -> food_drink_truck
//   food-truck-4.5m / 6m / 8m-> food_drink_truck
//   mini-dessert-truck-3.5m  -> dessert_truck
// There is no dedicated "snack" tier slug in TIER_META today, so snack_truck is
// matched defensively on the keyword (future-proofing) and otherwise stays
// empty — operators can still place a snack vendor by tagging the zone by hand
// via the roster's "snack" column if the slug ever appears.
const TIER_TO_ZONE: Array<{ test: (slug: string) => boolean; zone: OutsideZoneKey }> = [
  { test: (s) => s.includes('bedouin'), zone: 'bedouin' },
  { test: (s) => s.includes('snack'), zone: 'snack_truck' },
  { test: (s) => s.includes('dessert'), zone: 'dessert_truck' },
  // food-gazebo + every food-truck size + any other "food"/"truck" slug.
  { test: (s) => s.includes('food') || s.includes('truck') || s.includes('gazebo'), zone: 'food_drink_truck' },
]

export function zoneForTier(slug: string | null | undefined): OutsideZoneKey | null {
  if (!slug) return null
  const s = slug.toLowerCase()
  for (const rule of TIER_TO_ZONE) {
    if (rule.test(s)) return rule.zone
  }
  return null
}

// ---- ⟦ZONE:key:slot⟧ position marker on admin_notes ----
const ZONE_RE = /\s*⟦ZONE:([a-z_]+):(\d+)⟧\s*/
const CHECKIN_RE = /\s*⟦ZONE_CHECKIN:([^⟧]+)⟧\s*/

export interface ParsedZone {
  zone: OutsideZoneKey | null
  slot: number | null
  checkedInAt: string | null
  /** admin_notes with BOTH markers stripped (human prose only). */
  human: string
}

export function parseZoneAssignment(adminNotes: string | null | undefined): ParsedZone {
  const notes = adminNotes || ''
  const zm = notes.match(ZONE_RE)
  const cm = notes.match(CHECKIN_RE)
  const human = notes.replace(ZONE_RE, ' ').replace(CHECKIN_RE, ' ').replace(/\n{3,}/g, '\n\n').trim()
  const zone = zm && isOutsideZone(zm[1]) ? (zm[1] as OutsideZoneKey) : null
  const slot = zm ? parseInt(zm[2], 10) : null
  return { zone, slot, checkedInAt: cm ? cm[1] : null, human }
}

/**
 * Rebuild admin_notes preserving human prose and the existing check-in marker,
 * with (or without) the ⟦ZONE:..⟧ position marker. Passing slot=null clears the
 * assignment. The ⟦PORTAL:..⟧ and ⟦STALL:..⟧ markers (handled by their own
 * modules) are left untouched because they don't match ZONE_RE.
 */
export function withZoneAssignment(
  adminNotes: string | null | undefined,
  zoneKey: OutsideZoneKey | null,
  slotNumber: number | null,
): string {
  const { checkedInAt, human } = parseZoneAssignment(adminNotes)
  const parts: string[] = []
  if (human) parts.push(human)
  if (zoneKey && slotNumber != null) parts.push(`⟦ZONE:${zoneKey}:${slotNumber}⟧`)
  if (checkedInAt) parts.push(`⟦ZONE_CHECKIN:${checkedInAt}⟧`)
  return parts.join('\n\n')
}

/**
 * Rebuild admin_notes preserving human prose and the existing ⟦ZONE:..⟧
 * position marker, setting (or clearing) the check-in marker.
 */
export function withZoneCheckIn(
  adminNotes: string | null | undefined,
  checkedInAt: string | null,
): string {
  const parsed = parseZoneAssignment(adminNotes)
  const parts: string[] = []
  if (parsed.human) parts.push(parsed.human)
  if (parsed.zone && parsed.slot != null) parts.push(`⟦ZONE:${parsed.zone}:${parsed.slot}⟧`)
  if (checkedInAt) parts.push(`⟦ZONE_CHECKIN:${checkedInAt}⟧`)
  return parts.join('\n\n')
}

// ---- per-zone used / capacity rollup ----
export interface ZoneRollup {
  key: OutsideZoneKey
  label: string
  capacity: number
  used: number
}

/**
 * Given a list of {zone} rows (one per outside vendor that has a zone), return
 * the used/capacity rollup for every outside zone. "used" counts vendors mapped
 * to the zone (whether or not they have a position number yet), so the bar
 * reflects the roster, not just placements.
 */
export function rollupZones(vendorZones: Array<OutsideZoneKey | null>): ZoneRollup[] {
  return OUTSIDE_ZONES.map((z) => ({
    key: z.key as OutsideZoneKey,
    label: z.label,
    capacity: z.capacity,
    used: vendorZones.filter((v) => v === z.key).length,
  }))
}

export function zoneLabel(key: string | null | undefined): string {
  return zoneByKey(key)?.label || 'Outside'
}
