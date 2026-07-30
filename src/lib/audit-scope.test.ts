import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hiddenFromOwner, siteEventHiddenFromOwner, isLaneMechanicsEvent } from './audit-scope'

// ---------------------------------------------------------------------------
// The seven rows that were actually visible to her on 2026-07-28.
// ---------------------------------------------------------------------------

test('the lane-mechanics rows she could read are hidden', () => {
  for (const t of ['eft_lane_exclude', 'eft_lane_add', 'eft_lane_unexclude']) {
    assert.equal(hiddenFromOwner({ event_type: t, note: 'EFT lane add' }, true), true, t)
  }
})

test('Y&K is the case a vendor-only filter would have missed', () => {
  // Y&K was deliberately moved INTO her scope so the payment reads as settled.
  // vendorInScope is therefore TRUE, and the row must still be withheld: it is
  // the audit trail of the arrangement, on the one vendor it matters most for.
  assert.equal(
    hiddenFromOwner({ event_type: 'eft_lane_add', note: 'EFT lane add' }, true),
    true,
    'in-scope vendor must not expose its own lane mechanics',
  )
})

test('an EFT note on a vendor who IS hers is hidden on content alone', () => {
  // Elegant Muslimah / Amc cookware: paid_at is set, so they are hers, but the
  // note reads "Marked paid manually by admin (eft)."
  assert.equal(
    hiddenFromOwner({ event_type: 'payment_manual', note: 'Marked paid manually by admin (eft).' }, true),
    true,
  )
})

test('EFT wording nested inside a JSONB diff is still caught', () => {
  // before/after are objects, not strings. A naive check stringifies to
  // "[object Object]" and lets the payload through.
  assert.equal(
    hiddenFromOwner({ event_type: 'vendor_amended', after_value: { method: 'eft', amount: 4800 } }, true),
    true,
  )
})

// ---------------------------------------------------------------------------
// The vendor gate.
// ---------------------------------------------------------------------------

test('ordinary events about HER vendors stay visible', () => {
  for (const t of ['approved', 'rejected', 'vendor_amended', 'stall_move_approved', 'chase_email']) {
    assert.equal(hiddenFromOwner({ event_type: t, note: 'Approved by admin' }, true), false, t)
  }
})

test('the same events about vendors outside her scope are hidden', () => {
  for (const t of ['approved', 'rejected', 'vendor_amended']) {
    assert.equal(hiddenFromOwner({ event_type: t }, false), true, t)
  }
})

test('an unresolvable vendor fails CLOSED', () => {
  // A row naming no vendor, or one whose vendor could not be looked up, cannot
  // be PROVEN hers. Hiding a csv_export line is cheap; showing a lane row is not.
  assert.equal(hiddenFromOwner({ event_type: 'csv_export' }, undefined), true)
  assert.equal(hiddenFromOwner({ event_type: 'approved' }, undefined), true)
})

// ---------------------------------------------------------------------------
// The hole this session opened.
// ---------------------------------------------------------------------------

test('admin_login is master-only, so she cannot read her own tracking or his IP', () => {
  // Login tracking was added today at Taona's request and writes to
  // site_events, which this same feed renders. A monitoring feature visible to
  // the monitored party is not a monitoring feature.
  assert.equal(siteEventHiddenFromOwner({
    event_type: 'admin_login',
    metadata: { email: 'capetownhalaal@gmail.com', ip: '41.13.7.22', city: 'Cape Town' },
  }), true)
  assert.equal(hiddenFromOwner({ event_type: 'admin_login' }, true), true)
})

// ---------------------------------------------------------------------------
// site_events: judged on content, and must not go dark.
// ---------------------------------------------------------------------------

test('the ordinary site_events feed still reaches her', () => {
  for (const t of ['apply_submit', 'apply_success', 'contract_signed', 'support_mail_in', 'cron_reconcile_yoco']) {
    assert.equal(siteEventHiddenFromOwner({ event_type: t, metadata: { vendor_id: 'x' } }), false, t)
  }
})

test('a future eft_lane_* event type is covered the day it is written', () => {
  assert.equal(isLaneMechanicsEvent('eft_lane_something_new'), true)
  assert.equal(isLaneMechanicsEvent('EFT_LANE_ADD'), true, 'case insensitive')
  assert.equal(isLaneMechanicsEvent('approved'), false)
})

// ---------------------------------------------------------------------------
// site_events can name a vendor; when they do, an out-of-scope vendor is hidden.
// ---------------------------------------------------------------------------

test('siteEventHiddenFromOwner hides master-lane vendor events by scope', () => {
  assert.equal(siteEventHiddenFromOwner({
    event_type: 'vendor_doc_uploaded',
    metadata: { vendor_id: 'x' },
  }, false), true, 'out-of-scope vendor event')
  assert.equal(siteEventHiddenFromOwner({
    event_type: 'vendor_doc_uploaded',
    metadata: { vendor_id: 'x' },
  }, true), false, 'in-scope vendor event')
})

test('siteEventHiddenFromOwner still judges content when vendor scope is unknown', () => {
  assert.equal(siteEventHiddenFromOwner({
    event_type: 'cron_reconcile_yoco',
    metadata: { note: 'Processed EFT settlement' },
  }), true, 'EFT wording hides even without vendor')
  assert.equal(siteEventHiddenFromOwner({
    event_type: 'apply_submit',
    metadata: {},
  }), false, 'ordinary event stays visible')
})
