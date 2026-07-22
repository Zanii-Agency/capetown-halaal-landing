// Compute a vendor's total stall fee from the application data. ONE source of
// truth: src/app/apply/page.tsx is the authoring form, this is the read side.
// Both must agree — TIER_META in src/lib/stalls.ts holds the same numbers.

import { TIER_META } from '@/lib/stalls'

export interface LineItem {
  label: string
  amount: number // Rand
  qty?: number
}

export interface VendorPricing {
  stallLabel: string
  stallPrice: number
  electricalItems: LineItem[]
  electricalTotal: number
  chairsQty: number
  chairsAmount: number
  tablesQty: number
  tablesAmount: number
  total: number
  currency: 'ZAR'
}

// Mirrors ELECTRICAL_OPTIONS in apply/page.tsx — keep in sync.
const ELECTRICAL_PRICES: Record<string, { label: string; price: number }> = {
  'charger-lighting': { label: 'Charger/Lighting', price: 400 },
  microwave: { label: 'Microwave', price: 400 },
  urn: { label: 'Urn', price: 500 },
  'single-fryer': { label: 'Single Fryer', price: 500 },
  'double-fryer': { label: 'Double Fryer', price: 800 },
  'waffle-pancake-maker': { label: 'Waffle/Pancake Maker', price: 500 },
  blender: { label: 'Blender', price: 400 },
  'coffee-machine': { label: 'Coffee Machine', price: 750 },
  'electric-stove': { label: 'Electric Stove', price: 750 },
  'small-display-fridge': { label: 'Small Display Fridge', price: 400 },
  'large-display-fridge-freezer': { label: 'Large Display Fridge/Freezer', price: 600 },
}

// Hire prices — to be confirmed; per-item per-festival. R75 + R200 are
// placeholders consistent with prior comms; admin override via portal state
// payment.amount remains available if Samreen sets a different number.
const CHAIR_HIRE_PER_UNIT = 75
const TABLE_HIRE_PER_UNIT = 200

interface ApplicationLike {
  preferred_booth_tier?: string | null
  special_requirements?: unknown
}

interface SpecialRequirementsShape {
  stall_type?: string
  electrical_appliances?: Record<string, number> | string[]
  electrical_custom?: Array<{ label: string; amount: number; qty?: number }>
  hired_chairs?: number | string
  hired_tables?: number | string
  stall_price?: number
  total_estimate?: number
}

function readReqs(app: ApplicationLike): SpecialRequirementsShape {
  const raw = app.special_requirements
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (typeof raw === 'object') return raw as SpecialRequirementsShape
  return {}
}

export function computeVendorPricing(app: ApplicationLike): VendorPricing {
  const reqs = readReqs(app)
  // SOURCE OF TRUTH for the charge is the price the SYSTEM stored: the amount the
  // vendor selected/agreed at application time (special_requirements.stall_price),
  // which is what the vendor portal shows and Yoco charges. A negotiated / sponsor
  // rate (e.g. Telkom at R4,800 for a 3x3) lives here and must NOT be overwritten
  // by a TIER_META standard-price lookup. Reading the tier price first (an earlier
  // attempt at the MaterniTee fix) over-charged every vendor whose agreed price
  // differs from the standard. The correct root fix is tierPricingFields, which
  // RE-SYNCS this stored price whenever the tier actually changes, so reading the
  // stored price is always current. TIER_META supplies the label, and a fallback
  // price only for legacy rows that never stored a stall_price.
  const hasTier = !!(app.preferred_booth_tier && String(app.preferred_booth_tier).trim())
  const tierSlug = (app.preferred_booth_tier as string) || (reqs.stall_type as string) || ''
  const tier = TIER_META[tierSlug]
  const storedPrice = Number(reqs.stall_price)
  // Base stall fee applies ONLY when a booth TIER is assigned. If Samreen clears
  // the tier, the vendor is custom-only: NO base fee, just the custom charges
  // below. This is the "reset to Other + a custom charge" she expects on clearing
  // the tier (the flower sisters: R2,000 custom charge, not R3,750 stale base
  // PLUS R2,000). A tiered vendor keeps their stored/agreed price.
  const stallPrice = hasTier
    ? (Number.isFinite(storedPrice) && storedPrice > 0 ? storedPrice : (tier?.price ?? 0))
    : 0
  const stallLabel = hasTier ? (tier?.label || tierSlug || 'Custom stall') : 'Custom (no tier)'

  const electrical: LineItem[] = []
  const elec = reqs.electrical_appliances
  if (elec && typeof elec === 'object') {
    const entries = Array.isArray(elec)
      ? elec.map((k) => [k, 1] as const)
      : Object.entries(elec)
    for (const [key, qty] of entries) {
      const q = Math.max(1, Math.floor(Number(qty) || 0))
      if (!q || key === 'none') continue
      const meta = ELECTRICAL_PRICES[key]
      if (!meta) continue
      electrical.push({ label: meta.label, amount: meta.price * q, qty: q })
    }
  }

  // Admin-set custom charges (Samreen): off-list appliances OR any additional
  // payment request. The AMOUNT is what matters: any entry with a finite amount
  // > 0 charges, even if the label is blank (default it). Only non-finite/<=0
  // amounts are skipped, so typing just an amount adds it to the total.
  const custom = reqs.electrical_custom
  if (Array.isArray(custom)) {
    for (const entry of custom) {
      if (!entry || typeof entry !== 'object') continue
      const amt = Number(entry.amount)
      if (!Number.isFinite(amt) || amt <= 0) continue
      const label = (typeof entry.label === 'string' && entry.label.trim()) || 'Additional charge'
      const qty = Math.max(1, Math.floor(Number(entry.qty) || 1))
      electrical.push({ label, amount: amt * qty, qty })
    }
  }

  // electricalTotal is the sum of ALL electrical items (priced + custom), so
  // custom charges flow into total below and onto the invoice.
  const electricalTotal = electrical.reduce((s, i) => s + i.amount, 0)

  const chairsQty = Math.max(0, Math.floor(Number(reqs.hired_chairs) || 0))
  const chairsAmount = chairsQty * CHAIR_HIRE_PER_UNIT
  const tablesQty = Math.max(0, Math.floor(Number(reqs.hired_tables) || 0))
  const tablesAmount = tablesQty * TABLE_HIRE_PER_UNIT

  const total = stallPrice + electricalTotal + chairsAmount + tablesAmount

  return {
    stallLabel,
    stallPrice,
    electricalItems: electrical,
    electricalTotal,
    chairsQty,
    chairsAmount,
    tablesQty,
    tablesAmount,
    total,
    currency: 'ZAR',
  }
}

export function formatRand(n: number): string {
  return 'R' + Number(n || 0).toLocaleString('en-ZA')
}

// When a vendor's booth tier changes, the FROZEN special_requirements snapshot
// (stall_type/stall_price/total_estimate) must move with it, or admin pages and
// the stored invoice line keep showing the OLD size. computeVendorPricing reads
// preferred_booth_tier for the live total, so pricing is already correct, but
// these fields are the stored display copy that many admin surfaces render.
// Returns the patched pricing fields for the new tier, preserving any add-on
// delta (total - base); null if the tier is not a known TIER_META key. Every
// path that writes preferred_booth_tier should Object.assign this onto reqs.
export function tierPricingFields(
  tierSlug: string,
  prev: { stall_price?: number | string; total_estimate?: number | string },
): { stall_type: string; stall_price: number; total_estimate: number } | null {
  const meta = TIER_META[tierSlug]
  if (!meta) return null
  const prevStall = Number(prev.stall_price) || 0
  const prevTotal = Number(prev.total_estimate) || prevStall
  const addOns = Math.max(0, prevTotal - prevStall)
  return { stall_type: meta.label, stall_price: meta.price, total_estimate: meta.price + addOns }
}
