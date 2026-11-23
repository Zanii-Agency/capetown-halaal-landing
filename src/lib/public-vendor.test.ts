import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isPublicVendor } from './public-vendor'
import { updatePortalStateImpl, type PortalState } from './portal-state'
import { withOwnerVisibleMarker } from './eft'

describe('isPublicVendor', () => {
  it('hides an approved vendor who has not paid', () => {
    assert.equal(isPublicVendor({ admin_notes: null, paid_at: null }), false)
  })

  it('hides a vendor whose payment is only deferred or pending', () => {
    assert.equal(isPublicVendor({ admin_notes: withPayment({ status: 'deferred' }), paid_at: null }), false)
    assert.equal(isPublicVendor({ admin_notes: withPayment({ status: 'pending' }), paid_at: null }), false)
  })

  it('shows a settled EFT vendor handed to the owner (⟦OWNERVIS⟧)', () => {
    const notes = withOwnerVisibleMarker(withPayment({ status: 'paid', method: 'eft', paid_at: '2026-07-30T00:00:00.000Z' }))
    assert.equal(isPublicVendor({ admin_notes: notes, paid_at: '2026-07-30T00:00:00.000Z' }), true)
  })

  it('does not show an ⟦OWNERVIS⟧ vendor who has not paid', () => {
    assert.equal(isPublicVendor({ admin_notes: withOwnerVisibleMarker(''), paid_at: null }), false)
  })

  it('shows a Yoco-paid vendor', () => {
    const notes = withPayment({ status: 'paid', method: 'yoco', paid_at: '2026-07-30T00:00:00.000Z' })
    assert.equal(isPublicVendor({ admin_notes: notes, paid_at: '2026-07-30T00:00:00.000Z' }), true)
  })

  it('shows a cash/waived vendor', () => {
    const notes = withPayment({ status: 'paid', method: 'cash', paid_at: '2026-07-30T00:00:00.000Z' })
    assert.equal(isPublicVendor({ admin_notes: notes, paid_at: '2026-07-30T00:00:00.000Z' }), true)
  })

  it('hides an EFT-collected vendor before Yoco reconciliation', () => {
    const notes = withPayment({ status: 'collected', eft_collected_at: '2026-07-30T00:00:00.000Z' })
    assert.equal(isPublicVendor({ admin_notes: notes, paid_at: null }), false)
  })

  it('hides a vendor settled via EFT method (still master-only)', () => {
    const notes = withPayment({ status: 'paid', method: 'eft', paid_at: '2026-07-30T00:00:00.000Z' })
    assert.equal(isPublicVendor({ admin_notes: notes, paid_at: '2026-07-30T00:00:00.000Z' }), false)
  })

  it('hides a vendor settled via manual_card (master-only)', () => {
    const notes = withPayment({ status: 'paid', method: 'manual_card', paid_at: '2026-07-30T00:00:00.000Z' })
    assert.equal(isPublicVendor({ admin_notes: notes, paid_at: '2026-07-30T00:00:00.000Z' }), false)
  })

  it('hides a lingering ⟦EFT⟧ marker that is not yet paid', () => {
    assert.equal(isPublicVendor({ admin_notes: 'Some prose\n⟦EFT⟧', paid_at: null }), false)
  })

  it('shows a vendor once the ⟦EFT⟧ marker is reconciled through Yoco', () => {
    const notes = updatePortalStateImpl('Some prose\n⟦EFT⟧', {
      v: 1,
      payment: { status: 'paid', method: 'yoco', paid_at: '2026-07-30T00:00:00.000Z' },
    })
    assert.equal(isPublicVendor({ admin_notes: notes, paid_at: '2026-07-30T00:00:00.000Z' }), true)
  })
})

function withPayment(payment: Record<string, unknown>): string {
  return updatePortalStateImpl('', {
    v: 1,
    payment: payment as PortalState['payment'],
  })
}
