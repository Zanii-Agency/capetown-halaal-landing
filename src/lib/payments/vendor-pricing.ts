// The pricing a VENDOR is shown. Admin surfaces keep computeVendorPricing (the
// live truth); vendor-facing surfaces route through here.
//
// Why: 8d2c788 (2026-08-04) started counting free-text electrical, which raised
// the live total for 27 vendors who had ALREADY paid/collected at the old
// figure. Their portals would have silently grown an "outstanding" balance
// overnight (Taona 2026-08-04: "those who had already paid dont update their
// platform"). So a settled vendor keeps the computation they settled under:
// stringElectrical:false is exactly the pre-8d2c788 behaviour, so pre-existing
// legit arrears (admin-added charges) still show, only the reprice is frozen.
//
// Unpaid vendors always get the live total (the under-quoting was the bug).

import { computeVendorPricing, type VendorPricing } from './pricing'
import { parsePortalState, hasPaid } from '@/lib/portal-state'

/** Paid vendors who have SEEN the repriced total and had it explained; they keep
 *  the live view (and can settle the difference via the portal if they choose). */
export const REPRICE_ACK_IDS: ReadonlySet<string> = new Set([
  '13e664c3-3b28-4f3f-b8c7-db7069e0249b', // Vanilla Cream (email explained the R1 000 appliance line, 2026-08-04)
])

export interface VendorFacingApp {
  id?: string | null
  preferred_booth_tier?: string | null
  special_requirements?: unknown
  admin_notes?: string | null
  paid_at?: string | null
}

export function vendorFacingPricing(app: VendorFacingApp): VendorPricing {
  const live = computeVendorPricing({
    preferred_booth_tier: app.preferred_booth_tier as string,
    special_requirements: app.special_requirements,
  })
  const state = parsePortalState(app.admin_notes ?? null)
  const settled = hasPaid(state) || !!app.paid_at
  if (!settled) return live
  if (app.id && REPRICE_ACK_IDS.has(app.id)) return live

  const frozen = computeVendorPricing(
    {
      preferred_booth_tier: app.preferred_booth_tier as string,
      special_requirements: app.special_requirements,
    },
    { stringElectrical: false },
  )
  // Never show a settled vendor LESS than they actually paid: a vendor who pays
  // a post-8d2c788 quote (electrical included) must keep seeing that total.
  const paidAmount = Number(state.payment?.amount) || 0
  if (paidAmount > frozen.total) return live
  return frozen
}
