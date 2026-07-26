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

// Rewritten 2026-07-26. The rule is no longer "is this vendor on the EFT lane?"
// but "has this vendor paid through a channel the festival owner handles?" —
// Taona: "samreen should never have access to unpaid vendors except for when they
// sign up, sign contract". Those two moments pass no vendorId at all, so anything
// naming a vendor here is gated on ownership. `true` = withheld from her.
const paidVia = (method: string) =>
  updatePortalStateImpl('note', { v: 1, payment: { status: 'paid', method } as never })

test('alerts about an UNPAID vendor never reach the festival owner', () => {
  const withheld = (notes: string) => isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: notes }), true)
  assert.equal(withheld('just a note'), true, 'plain unpaid')
  assert.equal(withheld('⟦EFT⟧'), true, 'on the EFT lane')
  // Changed 2026-07-26: ⟦NOEFT⟧ used to hand an UNPAID vendor back to her. Being
  // excluded from the EFT lane is not the same as having paid.
  assert.equal(withheld(withNoEftMarker('note')), true, '⟦NOEFT⟧ but still unpaid')
  const collected = updatePortalStateImpl('note', { v: 1, payment: { status: 'collected', eft_collected_at: PAID_AT } })
  assert.equal(withheld(collected), true, "'collected' is interim, not paid")
  assert.equal(withheld(updatePortalStateImpl('note', { v: 1, payment: { eft_submitted_at: PAID_AT } })), true, 'proof uploaded, not yet settled')
  // Global mode is now irrelevant to this: an unpaid vendor is the master's
  // whether or not the lane is switched on.
  assert.equal(isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: 'just a note' }), false), true)
})

test('a PAID vendor reaches her only if the money came through her channel', () => {
  const withheld = (notes: string, paid: string | null = null) =>
    isEftScopedAlert({ body: NEUTRAL }, row({ admin_notes: notes, paid_at: paid }), true)
  assert.equal(withheld(paidVia('yoco')), false, 'Yoco is hers')
  assert.equal(withheld(paidVia('cash')), false, 'cash is hers')
  assert.equal(withheld(paidVia('waived')), false, 'waived is hers')
  // Changed 2026-07-26: settling by EFT used to hand the vendor back to her the
  // moment paid_at was written. "eft confirmed vendors staff badges cant go to her".
  assert.equal(withheld(paidVia('eft'), PAID_AT), true, 'EFT-settled stays the master\'s')
  assert.equal(withheld(paidVia('manual_card'), PAID_AT), true, 'manual card stays the master\'s')
  // Legacy paid rows carry no method at all (20 of 47 live) and must stay hers.
  assert.equal(withheld(updatePortalStateImpl('note', { v: 1, payment: { status: 'paid' } })), false)
  assert.equal(withheld('just a note', PAID_AT), false)
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
