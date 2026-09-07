// The ACCESSORIES chase cohort: vendors whose STALL FEE is settled but whose
// accessory-electricity (the appliances they booked) is still OWING, scoped to
// Samreen's side (Yoco + Samreen-EFT) so the covert master lane is never chased
// here (Taona 2026-09-07). One predicate, used by BOTH the 3-day reminder cron
// and its dry-run, so the "who gets chased" list can never drift between the
// preview and the real send.
//
// STOP CONDITION is implicit: a vendor drops out the moment accessories.state
// leaves 'owing' — EFT payers flip to 'pending' when they upload their -ACC
// proof, card payers flip to 'paid' at Yoco settlement. So the chase ends exactly
// when they have paid AND (for EFT) uploaded proof, with no manual off-switch.

import { vendorBill, type VendorBill } from './vendor-bill'
import { parsePortalState, isWithdrawn } from '@/lib/portal-state'
import { isOwnerVisible, onCovertMasterLane, type PaymentRail } from '@/lib/eft'
import { isTestVendor } from '@/lib/test-vendors'

export interface AccessoryChaseApp {
  id: string
  business_name?: string | null
  contact_name?: string | null
  email?: string | null
  phone?: string | null
  admin_notes?: string | null
  paid_at?: string | null
  preferred_booth_tier?: string | null
  special_requirements?: unknown
  status?: string | null
}

export interface AccessoryLine { label: string; amount: number }

export interface AccessoryChaseTarget {
  id: string
  businessName: string
  contactName: string
  email: string | null
  phone: string | null
  owing: number
  /** Exactly what they selected, flattened for display: each appliance + furniture. */
  items: AccessoryLine[]
  payClass: VendorBill['payClass']
  bill: VendorBill
}

/** Flatten a bill's accessories into display lines: electrical appliances first
 *  (with qty in the label), then chairs and tables. This is "exactly what they
 *  selected", the same breakdown the /payments page renders. */
export function accessoryLines(bill: VendorBill): AccessoryLine[] {
  const lines: AccessoryLine[] = []
  for (const it of bill.accessories.items) {
    lines.push({ label: it.qty && it.qty > 1 ? `${it.label} × ${it.qty}` : it.label, amount: it.amount })
  }
  if (bill.accessories.chairs.qty > 0) lines.push({ label: `Chairs hired × ${bill.accessories.chairs.qty}`, amount: bill.accessories.chairs.amount })
  if (bill.accessories.tables.qty > 0) lines.push({ label: `Tables hired × ${bill.accessories.tables.qty}`, amount: bill.accessories.tables.amount })
  return lines
}

/** Returns the chase target for this vendor, or null if they are not in scope.
 *  rail + fullEft are read ONCE by the caller and passed in (they are festival-
 *  wide, not per-vendor), so a whole-roster scan does one DB read, not N. */
export function accessoryChaseTarget(
  app: AccessoryChaseApp,
  rail: PaymentRail,
  fullEft: { protectedIds: Set<string> } | null,
): AccessoryChaseTarget | null {
  if (isTestVendor(app)) return null
  const notes = app.admin_notes ?? ''
  const state = parsePortalState(notes)
  if (isWithdrawn(state)) return null

  const bill = vendorBill({
    id: app.id,
    preferred_booth_tier: app.preferred_booth_tier ?? null,
    special_requirements: app.special_requirements,
    admin_notes: notes,
    paid_at: app.paid_at ?? null,
  })
  // Stall must be settled AND accessories still genuinely owing (not 'pending' =
  // proof already uploaded, not 'paid', not 'none').
  if (!bill.settled) return null
  if (bill.accessories.state !== 'owing' || bill.accessories.owing <= 0) return null

  // Samreen's side only: reconciled Yoco/cash OR her EFT (owner-visible), NEVER
  // the covert master lane (⟦EFT⟧ / frozen-66 / master rail). Same scope as
  // /admin/paid, so this chase covers exactly her payers and no one covert.
  const samreenSide = isOwnerVisible(notes) || !onCovertMasterLane(app.id, notes, rail, fullEft)
  if (!samreenSide) return null

  return {
    id: app.id,
    businessName: (app.business_name as string) || 'your business',
    contactName: (app.contact_name as string) || 'there',
    email: app.email ?? null,
    phone: app.phone ?? null,
    owing: bill.accessories.owing,
    items: accessoryLines(bill),
    payClass: bill.payClass,
    bill,
  }
}
