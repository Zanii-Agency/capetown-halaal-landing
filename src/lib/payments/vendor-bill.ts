// The vendor's bill, split into STALL FEE and ACCESSORIES (electricity +
// furniture), with money allocated stall-first. This is the one model every
// vendor-facing money surface reads (Payments page, bot, portal chat), so all
// of them tell the same story.
//
// Why it exists: the pre-2026-08-04 pricing bug dropped free-text electrical
// from totals, so 27 settled vendors paid their stall fee but never their
// accessories. Taona 2026-08-04: everyone with unpaid accessories pays them —
// card payers through Yoco (the existing top-up flow), EFT payers through the
// EFT rail with a `<ref>-ACC` reference. No waivers. Unpaid vendors keep one
// combined balance (the corrected live total).

import { computeVendorPricing, type VendorPricing, type LineItem } from './pricing'
import { parsePortalState, hasPaid, type PortalState } from '@/lib/portal-state'
import { eftReference } from '@/lib/eft'

export type AccessoryState = 'none' | 'paid' | 'pending' | 'owing'

export interface VendorBill {
  /** Stall money has landed (paid / collected / waived / paid_at). */
  settled: boolean
  /** How this vendor's money came in. 'eft' = concrete EFT evidence on the
   *  record (proof submitted / collected / method eft). NOT payment.method
   *  alone: Vanilla Cream is marked method 'yoco' but is an EFT payer. */
  payClass: 'eft' | 'card'
  stall: { label: string; price: number; paid: boolean }
  accessories: {
    items: LineItem[]
    chairs: { qty: number; amount: number }
    tables: { qty: number; amount: number }
    total: number
    /** Covered so far: cumulative payments beyond the stall price, plus an
     *  accessory EFT the operator marked collected (not yet Yoco-settled —
     *  once settled it lives inside payment.amount instead, never both). */
    paid: number
    owing: number
    state: AccessoryState
  }
  liveTotal: number
  paidTotal: number
  /** What the vendor still owes: accessories.owing when settled, else the full
   *  outstanding balance. */
  owing: number
  pricing: VendorPricing
  acc: NonNullable<NonNullable<PortalState['payment']>['acc']> | null
}

export interface BillApp {
  id?: string | null
  preferred_booth_tier?: string | null
  special_requirements?: unknown
  admin_notes?: string | null
  paid_at?: string | null
}

export function vendorHasEftTrail(state: PortalState): boolean {
  const p = state.payment
  // Deliberately NOT eft_revealed_at: merely opening the bank details once is a
  // stale click, not evidence the money came by EFT. A vendor who peeked at the
  // details and then paid by card must class 'card' (doctrine review 2026-08-04).
  return !!(p?.eft_submitted_at || p?.eft_collected_at || p?.status === 'collected' || p?.method === 'eft')
}

export function vendorBill(app: BillApp): VendorBill {
  const pricing = computeVendorPricing({
    preferred_booth_tier: app.preferred_booth_tier as string,
    special_requirements: app.special_requirements,
  })
  const state = parsePortalState(app.admin_notes ?? null)
  const pay = state.payment
  const settled = hasPaid(state) || !!app.paid_at
  const payClass: VendorBill['payClass'] = vendorHasEftTrail(state) ? 'eft' : 'card'

  const accessoriesTotal = Math.max(0, pricing.total - pricing.stallPrice)
  const paidTotal = Number(pay?.amount) || 0
  const acc = pay?.acc || null
  const accCollectedPending = acc?.collected_at && !acc?.settled_at ? Number(acc.amount) || 0 : 0
  const accPaid = Math.min(accessoriesTotal, Math.max(0, paidTotal - pricing.stallPrice) + accCollectedPending)
  const accOwing = Math.max(0, accessoriesTotal - accPaid)

  const accState: AccessoryState =
    accessoriesTotal <= 0 ? 'none'
    : accOwing <= 0 ? 'paid'
    : acc?.submitted_at && !acc?.collected_at ? 'pending'
    : 'owing'

  return {
    settled,
    payClass,
    stall: { label: pricing.stallLabel, price: pricing.stallPrice, paid: settled },
    accessories: {
      items: pricing.electricalItems,
      chairs: { qty: pricing.chairsQty, amount: pricing.chairsAmount },
      tables: { qty: pricing.tablesQty, amount: pricing.tablesAmount },
      total: accessoriesTotal,
      paid: accPaid,
      owing: accOwing,
      state: accState,
    },
    liveTotal: pricing.total,
    paidTotal,
    owing: settled ? accOwing : Math.max(0, pricing.total - paidTotal),
    pricing,
    acc,
  }
}

/** The bank reference for an ACCESSORY EFT deposit: the vendor's normal EFT
 *  reference with -ACC appended, so an accessory deposit is distinguishable
 *  from a stall deposit straight off the bank statement. */
export function accEftReference(app: { id?: string | null; admin_notes?: string | null; business_name?: string | null }): string {
  return `${eftReference(app)}-ACC`
}
