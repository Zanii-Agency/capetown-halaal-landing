// Runs under `node --import tsx --test src/lib/broadcast-audience.test.ts`.
//
// The risk this guards: a vendor's lifecycle stage and paid state are derived
// from three columns + admin_notes markers (no payment_status/portal_stage
// column exists). A drift here mis-targets a blast. Assert the funnel ordering,
// the paid-state matching (incl. waived/collected which the old copies missed),
// and that rejected is a terminal override.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { vendorStage, matchesPaid, isPaidRow, rowMatchesFilters, type AudienceRow } from './broadcast-audience'

function row(over: Partial<AudienceRow>): AudienceRow {
  return {
    id: 'x', business_name: 'B', contact_name: 'C', email: null, phone: null,
    preferred_booth_tier: null, product_categories: null, status: 'pending',
    admin_notes: null, paid_at: null, contract_signed_at: null, ...over,
  }
}

// A ⟦PORTAL:<base64>⟧ marker with a given payment status (matches parsePortalState).
function portal(status: string): string {
  return `⟦PORTAL:${Buffer.from(JSON.stringify({ payment: { status } })).toString('base64')}⟧`
}

test('paid_at settles a row regardless of status', () => {
  const r = row({ status: 'approved', paid_at: '2026-09-01T00:00:00Z' })
  assert.equal(isPaidRow(r), true)
  assert.equal(vendorStage(r), 'paid')
})

test('waived and collected count as paid (the states the old copies dropped)', () => {
  assert.equal(isPaidRow(row({ admin_notes: portal('waived') })), true)
  assert.equal(isPaidRow(row({ admin_notes: portal('collected') })), true)
  assert.equal(isPaidRow(row({ admin_notes: portal('deferred') })), false)
})

test('vendorStage walks the funnel by depth', () => {
  assert.equal(vendorStage(row({ status: 'pending' })), 'applied')
  assert.equal(vendorStage(row({ status: 'info_requested' })), 'info')
  assert.equal(vendorStage(row({ status: 'approved' })), 'approved')
  assert.equal(vendorStage(row({ status: 'approved', admin_notes: '⟦STALL:FS3⟧' })), 'allocated')
  assert.equal(vendorStage(row({ status: 'approved', contract_signed_at: '2026-09-01' })), 'contract')
})

test('rejected is terminal, overrides funnel depth', () => {
  assert.equal(vendorStage(row({ status: 'rejected', contract_signed_at: '2026-09-01' })), 'rejected')
})

test('matchesPaid enum selects the right cohort', () => {
  const deferred = row({ admin_notes: portal('deferred') })
  const waived = row({ admin_notes: portal('waived') })
  assert.equal(matchesPaid(deferred, 'deferred'), true)
  assert.equal(matchesPaid(deferred, 'unpaid'), true)   // deferred is not settled
  assert.equal(matchesPaid(deferred, 'paid'), false)
  assert.equal(matchesPaid(waived, 'waived'), true)
  assert.equal(matchesPaid(waived, 'paid'), true)        // waived settles
})

test('rowMatchesFilters ANDs stage + paid', () => {
  const r = row({ status: 'approved', contract_signed_at: '2026-09-01' }) // stage=contract, unpaid
  assert.equal(rowMatchesFilters(r, { stage: 'contract', paid: 'unpaid' }), true)
  assert.equal(rowMatchesFilters(r, { stage: 'contract', paid: 'paid' }), false)
  assert.equal(rowMatchesFilters(r, { stage: 'paid' }), false)
})
