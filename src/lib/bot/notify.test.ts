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
  // Even when the alert was explicitly addressed to the owner, EFT content wins
  // and she is dropped. It now falls through to the master rather than reaching
  // NOBODY, which is what this combination used to do: an EFT-scoped alert
  // addressed to her was silently discarded.
  assert.deepEqual(
    roles(selectNotifyTargets(BOT_ADMINS, { audience: 'festival_owner', excludeNorm: null, eftContent: true })),
    ['master'],
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
  // THE MIRROR: an alert addressed to the festival owner reaches the master too.
  assert.deepEqual(
    roles(selectNotifyTargets(BOT_ADMINS, { audience: 'festival_owner', excludeNorm: null, eftContent: false })),
    ['festival_owner', 'master'],
  )
})

test('the master mirrors everything the festival owner receives', () => {
  // Taona 2026-07-28: "make sure I have a mirror of what goes to samreen".
  // For every combination of audience and EFT scope, if she is a target he is.
  for (const audience of ['all', 'master', 'festival_owner'] as const) {
    for (const eftContent of [true, false]) {
      const got = selectNotifyTargets(BOT_ADMINS, { audience, excludeNorm: null, eftContent })
      const hers = got.some((a) => a.role === 'festival_owner')
      const his = got.some((a) => a.role === 'master')
      assert.equal(his, true, `master must always be a target (${audience}, eft=${eftContent})`)
      if (hers) assert.equal(his, true, `unmirrored alert (${audience}, eft=${eftContent})`)
    }
  }
})

test('exclude still wins over the mirror, so nobody is alerted about their own reply', () => {
  const master = BOT_ADMINS.find((a) => a.role === 'master')!
  assert.deepEqual(
    roles(selectNotifyTargets(BOT_ADMINS, {
      audience: 'all',
      excludeNorm: toE164(master.phone),
      eftContent: false,
    })),
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
  // ⟦NOEFT⟧ REVERSED TWICE, so the history is worth keeping. 2026-07-26 it was
  // made to withhold ("excluded from the EFT lane is not the same as having
  // paid"). 2026-07-28 Taona reversed it: "If excluded on master lane, it
  // belongs to samreen" — the wall hides an EFT ARRANGEMENT, and an excluded
  // vendor has none, so withholding them only hid an ordinary vendor from the
  // person meant to handle her. The 07-26 concern is still honoured by the
  // hasRealEftPayment guard in vendorInOwnerScope: a vendor who actually PAID by
  // EFT (collected / proof uploaded / master method) stays on the master lane
  // whatever the marker says. A bare reveal alone no longer does (self-heal 2026-08-31).
  assert.equal(withheld(withNoEftMarker('note')), false, '⟦NOEFT⟧ and untouched by EFT is HERS')
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

// ── admin_alert fallback ─────────────────────────────────────────────────────
// Meta template params reject newlines; the alert body is chat-shaped.
test('flattenForTemplate makes a chat body template-safe', async () => {
  const { flattenForTemplate } = await import('./notify')
  const { findWaTemplate, renderWaTemplatePreview } = await import('@/lib/templates/wa-meta')
  const flat = flattenForTemplate('*VENDOR SUPPORT MESSAGE*\n\nSumeez · Sataari\nPhone: +27718702167\n\n\nAsks: "help"')
  assert.equal(flat, '*VENDOR SUPPORT MESSAGE* · Sumeez · Sataari · Phone: +27718702167 · Asks: "help"')
  assert.equal(/\n/.test(flat), false)
  assert.ok(flattenForTemplate('x'.repeat(2000)).length <= 1000)
  // The swipe-reply router reads `Phone: +…` back from the logged body.
  assert.match(flat, /Phone: \+27718702167/)
  // The template is registered so the inbox renders the real text, not a label.
  const spec = findWaTemplate('admin_alert')!
  assert.equal(spec.category, 'utility')
  assert.match(renderWaTemplatePreview(spec, { first_name: 'Taona', alert: flat }), /^Hi Taona, [\s\S]*Sumeez/)
})
