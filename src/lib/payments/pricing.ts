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
  const tierSlug = (reqs.stall_type as string) || (app.preferred_booth_tier as string) || ''
  const tier = TIER_META[tierSlug]
  const stallLabel = tier?.label || tierSlug || 'Custom stall'
  const stallPrice = tier?.price ?? Number(reqs.stall_price) ?? 0

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
