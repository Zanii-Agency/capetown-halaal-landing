import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectNotifyTargets, isEftScopedAlert } from './notify'
import { BOT_ADMINS } from './admins'
import { toE164 } from '@/lib/whatsapp'
import { withNoEftMarker } from '@/lib/eft'
import { updatePortalStateImpl } from '@/lib/portal-state'

const roles = (admins: { role: string }[]) => admins.map((a) => a.role).sort()

// A vendor_applications row reduced to the four columns that decide the lane.
const row = (o: Partial<Record<'admin_notes' | 'paid_at' | 'email' | 'phone', unknown>> = {}) =>
  ({ admin_notes: null, paid_at: null, email: null, phone: null, ...o })

const PAID_AT = '2026-07-23T00:00:00Z'
const NEUTRAL = 'Staff badge added by Krispy Corn Dog: Junaid Maroof.'

test('EFT-content alerts never reach the festival owner, in any mode', () => {
  // eftContent = true: Samreen (festival_owner) is dropped, master still gets it.
  assert.deepEqual(
    roles(selectNotifyTargets(BOT_ADMINS, { audience: 'all', excludeNorm: null, eftContent: true })),
    ['master'],
  )
  // Even when the alert was explicitly addressed to the owner, EFT content wins.
  assert.deepEqual(
    selectNotifyTargets(BOT_ADMINS, { audience: 'festival_owner', excludeNorm: null, eftContent: true }),
    [],
  )
})

test('non-EFT alerts route normally', () => {
  assert.deepEqual(
    roles(selectNotifyTargets(BOT_ADMINS, { audience: 'all', excludeNorm: null, eftContent: false })),
    ['festival_owner', 'master'],
  )
  assert.deepEqual(
    roles(selectNotifyTargets(BOT_ADMINS, { audience: 'master', excludeNorm: null, eftContent: false })),
    ['master'],
  )
  assert.deepEqual(
    roles(selectNotifyTargets(BOT_ADMINS, { audience: 'festival_owner', excludeNorm: null, eftContent: false })),
    ['festival_owner'],
  )
})

// ── the gate ────────────────────────────────────────────────────────────────
// Regression cover for three leaks of the same class: alerts about an EFT-lane
// vendor reaching the festival owner (staff badge, contract, stall, docs), and
// alerts about an ALREADY-PAID vendor being withheld from her (registry.ts's
// hardcoded paidAt:null, and confirmPayment's "marked paid via eft" body).

test('isEftScopedAlert: the vendor row decides the lane, never the body', () => {
  // Marked + unpaid -> master only, even with global mode OFF. THE REPORTED BUG.
  assert.equal(isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: '⟦EFT⟧' }), false), true)
  // Unmarked + unpaid: swept in while global is on, self-reverts when it is off.
  assert.equal(isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: 'just a note' }), true), true)
  assert.equal(isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: 'just a note' }), false), false)
  // ⟦NOEFT⟧ is an explicit exclusion: the owner KEEPS these.
  assert.equal(isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: withNoEftMarker('note') }), true), false)
  // paid_at set (Yoco reconciliation) -> back to the owner, marker notwithstanding.
  assert.equal(isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: '⟦EFT⟧', paid_at: PAID_AT }), true), false)
  const paid = updatePortalStateImpl('note', { v: 1, payment: { status: 'paid' } })
  assert.equal(isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: paid }), true), false)
  // 'collected' is the EFT interim state: no paid_at, so it STAYS on master.
  const collected = updatePortalStateImpl('note', { v: 1, payment: { status: 'collected', eft_collected_at: PAID_AT } })
  assert.equal(isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: collected }), true), true)
  // Internal/operator accounts are never in the lane, by email or by last-9 phone.
  assert.equal(isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: '⟦EFT⟧', email: 'samreenkumandan1@gmail.com' }), true), false)
  assert.equal(isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: '⟦EFT⟧', phone: '+27 72 380 3393' }), true), false)
  // A submitted EFT proof keeps a mid-transaction vendor on master with global off.
  const submitted = updatePortalStateImpl('note', { v: 1, payment: { eft_submitted_at: PAID_AT } })
  assert.equal(isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: submitted }), false), true)
})

test('isEftScopedAlert: a resolved row overrides both the body text and eftScoped', () => {
  const paidVendor = row({ admin_notes: '⟦EFT⟧', paid_at: PAID_AT })
  // confirmPayment's real body. The word "eft" must NOT mute the owner when the
  // row says the vendor has settled — she is being told they became hers.
  assert.equal(
    isEftScopedAlert({ body: 'Krispy Corn Dog marked paid via eft. Amount R4,500.' }, paidVendor, true),
    false,
  )
  // A stale explicit flag cannot over-mute a reconciled vendor...
  assert.equal(isEftScopedAlert({ body: NEUTRAL, eftScoped: true }, paidVendor, true), false)
  // ...and cannot under-mute one still on the lane. The row wins both ways.
  assert.equal(isEftScopedAlert({ body: NEUTRAL, eftScoped: false }, row({ admin_notes: '⟦EFT⟧' }), true), true)
})

test('isEftScopedAlert: with no vendor row, heuristics apply and the default is fail-open', () => {
  // Body-text heuristic still guards alerts we cannot attribute to one vendor.
  assert.equal(isEftScopedAlert({ body: 'You can pay by EFT, details attached.' }, null, false), true)
  // The webhook's phone-only escape hatch still works.
  assert.equal(isEftScopedAlert({ body: NEUTRAL, eftScoped: true }, null, false), true)
  // FAIL-OPEN: nothing passed, global mode ON, neutral body -> she still sees it.
  // This is also the new-application carve-out. It fails the day someone adds a
  // vendorId to /api/applications, which would mute her from every new applicant.
  assert.equal(isEftScopedAlert({ body: 'New vendor application: Saba Foods (saba@x.co).' }, null, true), false)
})

test('gate to targets, end to end', () => {
  const inLane = isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: '⟦EFT⟧' }), false)
  assert.deepEqual(
    roles(selectNotifyTargets(BOT_ADMINS, { audience: 'all', excludeNorm: null, eftContent: inLane })),
    ['master'],
  )
  const settled = isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: '⟦EFT⟧', paid_at: PAID_AT }), true)
  assert.deepEqual(
    roles(selectNotifyTargets(BOT_ADMINS, { audience: 'all', excludeNorm: null, eftContent: settled })),
    ['festival_owner', 'master'],
  )
})

test('exclude filter drops a specific phone', () => {
  const owner = BOT_ADMINS.find((a) => a.role === 'festival_owner')!
  const got = selectNotifyTargets(BOT_ADMINS, { audience: 'all', excludeNorm: toE164(owner.phone), eftContent: false })
  assert.ok(!got.some((a) => a.role === 'festival_owner'))
})
