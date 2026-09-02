import { parsePortalState } from '@/lib/portal-state'
import { hasEftMarker } from '@/lib/eft'

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
