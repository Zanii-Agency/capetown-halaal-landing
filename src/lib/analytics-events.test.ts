import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPublicAnalyticsEvent, safeMetadata, MAX_METADATA_BYTES } from './analytics-events'

// ---------------------------------------------------------------------------
// The exploit, as an assertion.
//
// /api/analytics/track is unauthenticated and writes with the service role.
// site_events also carries privileged state, including the row getEftMode()
// reads to decide whether the ENTIRE festival is on EFT. Before the allow-list,
// this payload flipped that switch from anywhere on the internet.
// ---------------------------------------------------------------------------

test('the EFT master switch cannot be written through the public tracker', () => {
  assert.equal(isPublicAnalyticsEvent('eft_mode'), false)
})

test('no privileged event type is publicly writable', () => {
  // Every one of these is read by an admin surface or a money path.
  for (const t of [
    'eft_mode', 'eft_lane_add', 'eft_lane_remove',
    'chase_email', 'chase_whatsapp',
    'contract_signed', 'contract_resend',
    'csv_export', 'abuse_guard_hit', 'bot_tool_call',
    'ticket_buyer_archive_add', 'cron_reconcile_yoco',
  ]) {
    assert.equal(isPublicAnalyticsEvent(t), false, `${t} must be rejected`)
  }
})

test('the real analytics events still work, so the site is not broken', () => {
  for (const t of ['pageview', 'zanii_click', 'apply_step', 'apply_submit', 'apply_success', 'apply_email_captured']) {
    assert.equal(isPublicAnalyticsEvent(t), true, `${t} must be accepted`)
  }
})

test('non-string and malformed types are rejected rather than coerced', () => {
  for (const t of [null, undefined, 42, {}, [], '', 'EFT_MODE', ' eft_mode ']) {
    assert.equal(isPublicAnalyticsEvent(t), false, `${JSON.stringify(t)} must be rejected`)
  }
})

test('metadata is bounded, so the log cannot be used as free storage', () => {
  const huge = { blob: 'x'.repeat(MAX_METADATA_BYTES + 100) }
  assert.deepEqual(safeMetadata(huge), {}, 'oversized metadata is dropped, not stored')
})

test('metadata that is not an object becomes an empty object', () => {
  for (const m of [null, undefined, 'string', 42, ['a']]) {
    assert.deepEqual(safeMetadata(m), {})
  }
})

test('ordinary metadata passes through untouched', () => {
  const m = { surface: 'portal', step: 3 }
  assert.deepEqual(safeMetadata(m), m)
})

test('metadata with a cycle does not throw', () => {
  const cyclic: Record<string, unknown> = { a: 1 }
  cyclic.self = cyclic
  assert.deepEqual(safeMetadata(cyclic), {}, 'JSON.stringify throws; must be caught')
})
