import { parsePortalState } from '@/lib/portal-state'
import { hasEftMarker, isOwnerVisible, rosterPaid } from '@/lib/eft'

/**
 * Publication gate for the public festival site.
 *
 * A vendor may be approved (status = 'approved') but still hidden from the public
 * site while their payment is moving through the temporary master / EFT lane.
 * The rule is: do not surface a vendor whose money has not yet been reconciled
 * back through a normal owner-handled channel (Yoco, cash, waived).
 *
 * Hides:
 *   - EFT-collected vendors (interim: payment.status === 'collected')
 *   - Vendors settled via off-gateway methods that belong to the master lane
 *     (method === 'eft' or 'manual_card')
 *   - Any remaining ⟦EFT⟧-marked vendor that is not yet truly paid
 *
 * Shows:
 *   - Approved vendors with paid_at set via Yoco / cash / waived
 *   - Approved vendors with no payment recorded yet (legacy/unpaid behaviour
 *     preserved; callers that want only paid vendors must layer that on)
 */
export function isPublicVendor(row: {
  admin_notes?: string | null
  paid_at?: string | null
}): boolean {
  // 2026-11-23: the public exhibitor list is approved AND paid. The payment
  // deadline has passed, so an approved vendor with no money in is not a
  // confirmed exhibitor and must not be advertised. "Paid" is the roster's own
  // predicate (paid_at or payment.status 'paid'), which includes part-payers.
  if (!rosterPaid(row.admin_notes, row.paid_at)) return false

  // A settled vendor deliberately handed to the owner (⟦OWNERVIS⟧) is shown
  // whatever the method; the method-based hides below were never meant for them.
  if (isOwnerVisible(row.admin_notes)) return true

  const state = parsePortalState(row.admin_notes || '')
  const p = state.payment
  const method = String(p?.method || '')
  const status = String(p?.status || '')

  // Interim EFT collection: the vendor got a payment-received notification, but
  // paid_at is still null and the money has not yet been settled through Yoco.
  if (status === 'collected') return false

  // Off-gateway settlements handled by the master lane stay hidden until they
  // are reconciled back through Yoco.
  if (method === 'eft' || method === 'manual_card') return false

  // Fallback: any lingering ⟦EFT⟧ marker on a vendor who has not fully paid.
  if (hasEftMarker(row.admin_notes) && !row.paid_at && status !== 'paid') {
    return false
  }

  return true
}
