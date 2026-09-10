// Runs under `node --import tsx --test src/lib/eft.test.ts`.
//
// The risk: the ⟦EFT⟧ lane marker shares admin_notes with the ⟦STALL:..⟧
// allocation marker, the ⟦PORTAL:..⟧ base64 state, and human prose. Adding or
// removing the lane marker must never touch any of them, and the PORTAL/STALL
// writers must leave ⟦EFT⟧ alone (asserted via updatePortalStateImpl).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { vendorInOwnerScope, reconciledPaid, rosterPaid, rosterPaymentStatus, viewerSafePayment, hasEftMarker, withEftMarker, withoutEftMarker, eftReference, vendorInEftLane, vendorCommsInEftLane, hasNoEftMarker, withNoEftMarker, withoutNoEftMarker, mentionsEft, isInternalAccount, isOperatorPreviewAddress, isEftAdmin, visiblePaymentStatus, EFT_ADMIN_EMAIL, withOwnerVisibleMarker, earliestEftTimestamp, getEftMode, getPaymentRail, onCovertMasterLane, paymentOnOwnerSide, eftProofVisibleToOwner, eftBankFor, getEftBankDetails, getMasterBankDetails, revealsPaymentArrangement, hasNewVendorMarker, withNewVendorMarker, resolveInEftLane } from './eft'
import { updatePortalStateImpl, parsePortalState } from './portal-state'

test('withEftMarker adds the token and is idempotent', () => {
  const once = withEftMarker('')
  assert.equal(once, '⟦EFT⟧')
  assert.equal(withEftMarker(once), '⟦EFT⟧')
  assert.ok(hasEftMarker(once))
  assert.ok(!hasEftMarker('just a note'))
})

test('adding + removing ⟦EFT⟧ preserves prose, ⟦STALL⟧ and ⟦PORTAL⟧', () => {
  // Prose + allocation + payment state all in one string.
  let notes = 'Priority vendor.\n\n⟦STALL:FS12⟧'
  notes = updatePortalStateImpl(notes, { ...parsePortalState(notes), v: 1, payment: { status: 'pending' } })
  const added = withEftMarker(notes)
  assert.ok(hasEftMarker(added))
  assert.match(added, /⟦STALL:FS12⟧/)
  assert.match(added, /Priority vendor\./)
  assert.equal(parsePortalState(added).payment?.status, 'pending')

  // A subsequent PORTAL write (unrelated mutation) must not drop ⟦EFT⟧.
  const afterPortalWrite = updatePortalStateImpl(added, { ...parsePortalState(added), v: 1, stage: 'paid' })
  assert.ok(hasEftMarker(afterPortalWrite), '⟦EFT⟧ survives a PORTAL read-modify-write')

  // Removing the lane marker leaves everything else intact.
  const removed = withoutEftMarker(afterPortalWrite)
  assert.ok(!hasEftMarker(removed))
  assert.match(removed, /⟦STALL:FS12⟧/)
  assert.match(removed, /Priority vendor\./)
  assert.equal(parsePortalState(removed).stage, 'paid')
})

test('vendorInEftLane excludes already-paid vendors even under global mode', () => {
  // Already paid via the paid_at column -> never in the lane, even marked + global.
  assert.equal(vendorInEftLane('⟦EFT⟧', true, '2026-07-23T00:00:00Z'), false)
  // Already paid via the portal marker status -> never in the lane.
  const paidNotes = updatePortalStateImpl('⟦EFT⟧', { v: 1, payment: { status: 'paid' } })
  assert.equal(vendorInEftLane(paidNotes, true), false)
  // Unpaid + individually marked -> in the lane even with global OFF.
  assert.equal(vendorInEftLane('⟦EFT⟧', false), true)
  // Unpaid + unmarked + global ON -> in the lane.
  assert.equal(vendorInEftLane('just a note', true), true)
  // Unpaid + unmarked + global OFF -> NOT in the lane.
  assert.equal(vendorInEftLane('just a note', false), false)
})

test('vendorCommsInEftLane routes by payment status: unpaid + collected -> master while global on; only truly paid -> owner', () => {
  // Individually added + unpaid -> master, regardless of global mode.
  assert.equal(vendorCommsInEftLane('⟦EFT⟧', null), true)
  assert.equal(vendorCommsInEftLane('⟦EFT⟧', null, true), true)
  // Uploaded an EFT proof + unpaid -> master regardless of global (mid-transaction).
  const submitted = updatePortalStateImpl('note', { v: 1, payment: { eft_submitted_at: '2026-07-23T00:00:00Z' } })
  assert.equal(vendorCommsInEftLane(submitted, null), true)
  assert.equal(vendorCommsInEftLane(submitted, null, false), true)
  // NEW RULE: while global EFT mode is ON, ANY unpaid non-excluded vendor -> master,
  // even with no marker/proof/reveal. Self-reverts when global is off.
  assert.equal(vendorCommsInEftLane('just a note', null, true), true)   // global on  -> master
  assert.equal(vendorCommsInEftLane('just a note', null, false), false) // global off -> owner
  // 'collected' (EFT interim, paid_at null, status !== 'paid') -> master while global on.
  const collected = updatePortalStateImpl('note', { v: 1, payment: { status: 'collected', eft_collected_at: '2026-07-25T00:00:00Z' } })
  assert.equal(vendorCommsInEftLane(collected, null, true), true)
  // A truly PAID vendor (Yoco-settled) is NEVER on the master lane.
  const paid = updatePortalStateImpl('note', { v: 1, payment: { status: 'paid' } })
  assert.equal(vendorCommsInEftLane(paid, null, true), false)
  assert.equal(vendorCommsInEftLane('⟦EFT⟧', '2026-07-23T00:00:00Z', true), false) // paid_at set -> owner
  // ⟦NOEFT⟧ + internal accounts are explicit exclusions even under global mode.
  assert.equal(vendorCommsInEftLane(withNoEftMarker('just a note'), null, true), false)
  assert.equal(vendorCommsInEftLane('⟦NOEFT⟧', null, true), false)
  assert.equal(vendorCommsInEftLane('just a note', null, true, { email: 'samreenkumandan1@gmail.com' }), false)
})

test('⟦NOEFT⟧ exclusion overrides global mode AND ⟦EFT⟧ in both predicates', () => {
  // Excluding a vendor strips any ⟦EFT⟧ and adds ⟦NOEFT⟧ (the two never coexist).
  const ex = withNoEftMarker('⟦EFT⟧')
  assert.ok(hasNoEftMarker(ex))
  assert.ok(!hasEftMarker(ex))
  // Excluded: never in the payment lane (even global ON) or the comms lane.
  assert.equal(vendorInEftLane(ex, true, null), false)
  assert.equal(vendorCommsInEftLane(ex, null), false)
  // Un-exclude lifts it; preserves prose + ⟦STALL⟧.
  assert.ok(!hasNoEftMarker(withoutNoEftMarker(ex)))
  const keep = withNoEftMarker('Priority.\n\n⟦STALL:FS1⟧')
  assert.match(keep, /⟦STALL:FS1⟧/)
  assert.match(keep, /Priority\./)
})

test('internal/operator accounts are never in either lane, even under global mode', () => {
  // Matched by identity: samreenkumandan* email, GLOBAL CUISINE email/phone, capetownhalaal@.
  assert.ok(isInternalAccount('samreenkumandan1@gmail.com', null))
  assert.ok(isInternalAccount('SamreenKumandan99@outlook.com', null)) // substring, case-insensitive
  assert.ok(isInternalAccount('sales@globalcuisine.co.za', null))
  assert.ok(isInternalAccount('capetownhalaal@gmail.com', null))
  assert.ok(isInternalAccount(null, '+27 72 380 3393')) // last-9 match, any formatting
  assert.ok(isInternalAccount(null, '0723803393'))
  // Real vendors do NOT match.
  assert.ok(!isInternalAccount('chef@realvendor.co.za', '+27821234567'))
  assert.ok(!isInternalAccount(null, null))
  // Global mode would normally sweep an unmarked unpaid vendor into the payment
  // lane; an internal identity blocks it in BOTH predicates.
  const identity = { email: 'samreenkumandan1@gmail.com', phone: null }
  assert.equal(vendorInEftLane('just a note', true, null, identity), false)
  assert.equal(vendorCommsInEftLane('⟦EFT⟧', null, true, identity), false) // even an explicit ⟦EFT⟧ marker
  // Without identity, behaviour is unchanged (backward-compatible).
  assert.equal(vendorInEftLane('just a note', true, null), true)
})

test('isOperatorPreviewAddress matches the operator preview inbox (case-insensitive)', () => {
  assert.ok(isOperatorPreviewAddress('taonac96@gmail.com'))
  assert.ok(isOperatorPreviewAddress('TaonaC96@Gmail.com'))
  assert.ok(!isOperatorPreviewAddress('nazleyparker3@gmail.com'))
  assert.ok(!isOperatorPreviewAddress(null))
})

test('isEftAdmin: the master and the EFT mailbox are allowed; the festival owner and Altaf are not', () => {
  // Regression 2026-09-02: Confirm Paid on an EFT-lane vendor returned `forbidden`
  // for the master because only dev@cthalaal.co.za was exempt, not the login he
  // actually uses (taona@cthalaal.co.za). The seal must still wall the owner side.
  assert.equal(isEftAdmin('dev@cthalaal.co.za'), true)      // confined EFT mailbox
  assert.equal(isEftAdmin('taona@cthalaal.co.za'), true)    // the master
  assert.equal(isEftAdmin('TAONA@Cthalaal.co.za'), true)    // case + trim insensitive
  assert.equal(isEftAdmin('capetownhalaal@gmail.com'), false) // festival owner (Samreen) stays walled
  assert.equal(isEftAdmin('altaafkumandan@gmail.com'), false) // her internal account stays walled
  assert.equal(isEftAdmin(null), false)
  assert.equal(isEftAdmin(''), false)
})

test('mentionsEft fires on EFT replies, not on unrelated ones', () => {
  assert.ok(mentionsEft('You can pay by EFT, upload your proof of payment in the portal.'))
  assert.ok(mentionsEft('Please do a bank transfer to the account on your portal.'))
  assert.ok(mentionsEft('Send us your proof of payment once done.'))
  // Not a payment reply -> must NOT sweep the vendor onto the lane.
  assert.ok(!mentionsEft('Thanks for your halaal certificate, we have added it.'))
  assert.ok(!mentionsEft('Your stall is allocated, see you at the festival.'))
  assert.ok(!mentionsEft(''))
  assert.ok(!mentionsEft(null))
})

test('eftReference is the stall/business name, else allocated stall, else a stable short code', () => {
  // The business (stall) name IS the reference, sanitized bank-safe, so a bank
  // deposit reconciles to the vendor at a glance (Taona 2026-09-01).
  assert.equal(eftReference({ id: 'x', admin_notes: '', business_name: 'Island Way Sorbet' }), 'ISLANDWAYSORBET')
  assert.equal(eftReference({ id: 'x', admin_notes: '', business_name: 'Salt & Pepper' }), 'SALTPEPPER')
  // A name wins even over an allocated stall code.
  assert.equal(eftReference({ id: 'x', admin_notes: '⟦STALL:FT03⟧', business_name: 'Chip n Dip' }), 'CHIPNDIP')
  // No usable name (empty after sanitising): fall back to the allocated stall code.
  assert.equal(eftReference({ id: 'x', admin_notes: '⟦STALL:FT03⟧', business_name: '🌸' }), 'FT03')
  // No name, no stall: id -> strip dashes -> last 6 -> upper.
  assert.equal(eftReference({ id: 'abcdef12-3456-7890-abcd-ef1234567890', admin_notes: '' }), 'CTH567890')
})

// --- visiblePaymentStatus: the owner must never learn a vendor is 'collected' ---
// Taona 2026-07-25: "once I click mark collected, everything for the vendor
// should be normal, only Samreen doesn't know and never will know till we do
// Yoco settlement."
test('visiblePaymentStatus: collected reads as none for the owner, real for the EFT admin', () => {
  assert.equal(visiblePaymentStatus('collected', 'samreen@youngatheart.co.za'), 'none')
  assert.equal(visiblePaymentStatus('collected', null), 'none')
  assert.equal(visiblePaymentStatus('collected', undefined), 'none')
  assert.equal(visiblePaymentStatus('collected', EFT_ADMIN_EMAIL), 'collected')
  assert.equal(visiblePaymentStatus('collected', EFT_ADMIN_EMAIL.toUpperCase()), 'collected')
})

test('visiblePaymentStatus: never hides real revenue or alters any other state', () => {
  // A settled payment must ALWAYS show to the owner, or money goes missing from
  // her finance view. Only the interim EFT state is masked.
  for (const email of ['samreen@youngatheart.co.za', null, EFT_ADMIN_EMAIL]) {
    assert.equal(visiblePaymentStatus('paid', email), 'paid')
    assert.equal(visiblePaymentStatus('waived', email), 'waived')
    assert.equal(visiblePaymentStatus('pending', email), 'pending')
    assert.equal(visiblePaymentStatus('deferred', email), 'deferred')
    assert.equal(visiblePaymentStatus('none', email), 'none')
    assert.equal(visiblePaymentStatus(undefined, email), 'none')
    assert.equal(visiblePaymentStatus(null, email), 'none')
  }
})

test('vendorInOwnerScope: the festival owner only ever sees vendors who paid through HER channels', () => {
  const paidVia = (method: string) => updatePortalStateImpl('note', { v: 1, payment: { status: 'paid', method } as never })
  // Yoco, cash and waived are hers.
  assert.equal(vendorInOwnerScope(paidVia('yoco'), null), true)
  assert.equal(vendorInOwnerScope(paidVia('cash'), null), true)
  assert.equal(vendorInOwnerScope(paidVia('waived'), null), true)
  // EFT and manual card are the master's, even once SETTLED. This is the case
  // vendorCommsInEftLane got wrong: paid_at alone used to hand them back to her.
  assert.equal(vendorInOwnerScope(paidVia('eft'), '2026-07-19T00:00:00Z'), false)
  assert.equal(vendorInOwnerScope(paidVia('manual_card'), '2026-07-19T00:00:00Z'), false)
  // Legacy paid vendors carry no method (20 of 47 live rows) — they must NOT be
  // blanked out of her world, which is why the rule is a denylist.
  assert.equal(vendorInOwnerScope(updatePortalStateImpl('note', { v: 1, payment: { status: 'paid' } }), null), true)
  assert.equal(vendorInOwnerScope('just a note', '2026-07-19T00:00:00Z'), true)
})

test('reconciledPaid: the roster reads PAID only for a Yoco-reconcilable channel', () => {
  const paidVia = (method: string) => updatePortalStateImpl('note', { v: 1, payment: { status: 'paid', method } as never })
  // Her channels settle to PAID.
  assert.equal(reconciledPaid(paidVia('yoco'), '2026-07-19T00:00:00Z'), true)
  assert.equal(reconciledPaid(paidVia('cash'), null), true)
  assert.equal(reconciledPaid(paidVia('waived'), null), true)
  // Master-lane settlements read UNPAID until Yoco reconciles them. 'manual' is
  // finance/capture's EFT capture — the gap that let Table Art read as paid.
  assert.equal(reconciledPaid(paidVia('eft'), '2026-07-05T00:00:00Z'), false)
  assert.equal(reconciledPaid(paidVia('manual_card'), '2026-07-05T00:00:00Z'), false)
  assert.equal(reconciledPaid(paidVia('manual'), '2026-07-05T00:00:00Z'), false)
  // The 'collected' EFT interim and a plain unpaid vendor are UNPAID.
  assert.equal(reconciledPaid(updatePortalStateImpl('note', { v: 1, payment: { status: 'collected' } }), null), false)
  assert.equal(reconciledPaid('just a note', null), false)
  // Legacy paid_at with no method is still hers (denylist, not allowlist).
  assert.equal(reconciledPaid('just a note', '2026-07-19T00:00:00Z'), true)
})

test('vendorInOwnerScope: every unpaid state is outside her world', () => {
  assert.equal(vendorInOwnerScope('just a note', null), false, 'plain unpaid')
  assert.equal(vendorInOwnerScope('⟦EFT⟧', null), false, 'on the EFT lane')
  // ⟦NOEFT⟧ deliberately NOT asserted here any more. 2026-07-26 it handed an
  // unpaid vendor to the master ("excluded from EFT is not the same as paid").
  // 2026-07-28 Taona reversed it: "If excluded on master lane, it belongs to
  // samreen." The master lane hides an EFT arrangement and an excluded vendor
  // has none. Covered by its own tests below, including the guard that keeps an
  // EFT-touched vendor on the master lane regardless of the marker.
  // 'collected' is the EFT interim state and never sets paid_at: still not hers.
  const collected = updatePortalStateImpl('note', { v: 1, payment: { status: 'collected' } })
  assert.equal(vendorInOwnerScope(collected, null), false)
  assert.equal(vendorInOwnerScope(null, null), false)
})

// ---------------------------------------------------------------------------
// ⟦NOEFT⟧ hands the vendor to the festival owner — Taona 2026-07-28: "If
// excluded on master lane, it belongs to samreen." The master lane hides an EFT
// ARRANGEMENT; a vendor excluded from EFT has none.
// ---------------------------------------------------------------------------

test('an excluded, unpaid vendor who never touched EFT is HERS', () => {
  // Telkom, Treacle and Tart, Islamic Relief SA, Call-A-Braai on 2026-07-28.
  assert.equal(vendorInOwnerScope(withNoEftMarker('note')), true)
})

test('exclusion does NOT expose a vendor already collected via EFT', () => {
  // The marker says what happens next, not what already happened. Y&K gifts and
  // toys sat at 'collected' the day this rule was written; handing that over
  // would leak the settlement the wall exists to hide.
  const collected = withNoEftMarker(
    updatePortalStateImpl('note', { v: 1, payment: { status: 'collected' } }))
  assert.equal(vendorInOwnerScope(collected), false)
})

test('a ⟦NOEFT⟧ vendor who only REVEALED bank details (never paid EFT) is HERS', () => {
  // Self-heal 2026-08-31: a bare reveal is not a settlement. Opening the bank
  // details hides nothing, so a card/cash vendor is no longer stranded on the
  // master lane away from the owner meant to handle them (was "forbidden" on
  // Mark-as-Paid for Island Way Sorbet and jimmalos trading).
  const revealed = withNoEftMarker(
    updatePortalStateImpl('note', { v: 1, payment: { eft_revealed_at: '2026-07-27T11:27:22Z' } }))
  assert.equal(vendorInOwnerScope(revealed), true, 'reveal-only is hers')
})

test('exclusion DOES still hide a vendor who submitted EFT proof', () => {
  // A reveal FOLLOWED by real EFT money (proof uploaded) trips hasRealEftPayment
  // and stays hidden, so a real settlement is never exposed.
  const submitted = withNoEftMarker(
    updatePortalStateImpl('note', { v: 1, payment: { eft_submitted_at: '2026-07-27T21:32:00Z' } }))
  assert.equal(vendorInOwnerScope(submitted), false, 'uploaded proof stays hidden')
})

test('exclusion does NOT expose a vendor settled by EFT or manual card', () => {
  for (const method of ['eft', 'manual_card']) {
    const paid = withNoEftMarker(
      updatePortalStateImpl('note', { v: 1, payment: { status: 'paid', method } as never }))
    assert.equal(vendorInOwnerScope(paid, '2026-07-19T00:00:00Z'), false, method)
  }
})

test('exclusion never puts a vendor back INTO the EFT lane', () => {
  // Both walls must agree: excluded means she can see them AND they see no bank
  // details, even with global mode on.
  const n = withNoEftMarker('note')
  assert.equal(vendorInOwnerScope(n), true, 'visible to her')
  assert.equal(vendorInEftLane(n, true), false, 'still no bank details')
})

// ---------------------------------------------------------------------------
// The vendor PROFILE payment state. Taona 2026-07-28, on seeing Y&K read
// "Payment pending" directly above "R4 800 collected": "for dev@cthalaal.co.za
// this is correct, for samreen it shouldnt be."
// ---------------------------------------------------------------------------

test('visiblePaymentStatus: only the EFT admin sees a collected payment', () => {
  assert.equal(visiblePaymentStatus('collected', EFT_ADMIN_EMAIL), 'collected', 'master sees the truth')
  assert.equal(visiblePaymentStatus('collected', 'capetownhalaal@gmail.com'), 'none', 'owner must not')
  assert.equal(visiblePaymentStatus('collected', null), 'none', 'unknown viewer must not')
})

test('visiblePaymentStatus leaves every other state untouched for everyone', () => {
  // Masking must be surgical: hiding 'paid' from her would break her own view of
  // the vendors she settled.
  for (const s of ['paid', 'waived', 'pending', 'none', 'deferred']) {
    assert.equal(visiblePaymentStatus(s, 'capetownhalaal@gmail.com'), s, s)
    assert.equal(visiblePaymentStatus(s, EFT_ADMIN_EMAIL), s, s)
  }
})

test('viewerSafePayment: in-flight EFT money is stripped, her settled payment shows, admin sees raw', () => {
  const SAM = 'capetownhalaal@gmail.com'
  const notesFor = (payment: Record<string, unknown>) => updatePortalStateImpl('note', { v: 1, payment } as never)
  const pay = (notes: string) => parsePortalState(notes).payment

  // Collected EFT (the leak the profile page had): every money field dropped,
  // status masked. amount/reference/method/eft_* must NOT survive.
  const cNotes = notesFor({ status: 'collected', amount: 3700, reference: 'YAH-77', method: 'eft', eft_revealed_at: '2026-08-01T00:00:00Z' })
  const c = viewerSafePayment(pay(cNotes), cNotes, null, SAM)
  assert.equal(c?.status, 'none')
  assert.equal(c?.amount, undefined)
  assert.equal(c?.reference, undefined)
  assert.equal((c as Record<string, unknown>)?.method, undefined)
  assert.equal((c as Record<string, unknown>)?.eft_revealed_at, undefined)

  // Her Yoco-settled payment: amount + reference show; method still never leaks.
  const pNotes = notesFor({ status: 'paid', amount: 6500, reference: 'CH-9', method: 'yoco' })
  const p = viewerSafePayment(pay(pNotes), pNotes, '2026-08-01T00:00:00Z', SAM)
  assert.equal(p?.status, 'paid')
  assert.equal(p?.amount, 6500)
  assert.equal(p?.reference, 'CH-9')
  assert.equal((p as Record<string, unknown>)?.method, undefined)

  // A SETTLED master-lane EFT (status paid, method eft, paid_at set): to her this
  // is UNPAID — status masked to 'none', every money field dropped (2026-09-07,
  // reconciledPaid gate). It only reads paid to the EFT admin.
  const eNotes = notesFor({ status: 'paid', amount: 5400, reference: 'YAH-12', method: 'eft' })
  const e = viewerSafePayment(pay(eNotes), eNotes, '2026-08-01T00:00:00Z', SAM)
  assert.equal(e?.status, 'none')
  assert.equal(e?.amount, undefined)
  assert.equal(e?.reference, undefined)
  assert.equal(viewerSafePayment(pay(eNotes), eNotes, '2026-08-01T00:00:00Z', EFT_ADMIN_EMAIL)?.status, 'paid')

  // A plain unpaid vendor: nothing to leak, status passes through.
  const uNotes = notesFor({ status: 'none' })
  assert.equal(viewerSafePayment(pay(uNotes), uNotes, null, SAM)?.status, 'none')

  // The EFT admin sees the raw object untouched.
  const admin = viewerSafePayment(pay(cNotes), cNotes, null, EFT_ADMIN_EMAIL)
  assert.equal(admin?.status, 'collected')
  assert.equal(admin?.amount, 3700)
  assert.equal((admin as Record<string, unknown>)?.method, 'eft')
})

test('rosterPaymentStatus: owner sees paid ONLY for her-channel settlement; master-lane EFT masks to unpaid', () => {
  const SAM = 'capetownhalaal@gmail.com'
  const notes = (payment: Record<string, unknown>) =>
    updatePortalStateImpl('note', { v: 1, payment } as never)
  const paidAt = '2026-07-05T00:00:00Z'
  // rosterPaid stays the method-AGNOSTIC true-state label — every settled method is
  // paid. This is the EFT admin's export column and never changed.
  for (const method of ['eft', 'manual', 'manual_card', 'yoco', 'cash']) {
    assert.equal(rosterPaid(notes({ status: 'paid', method }), paidAt), true, method)
  }
  // To the OWNER, "paid" means reconciled through HER channel. Taona 2026-09-07
  // ("all vendors on master lane eft should always show as unpaid to her") reverses
  // the 2026-08-16 call: Yoco/cash read paid, eft/manual/manual_card read unpaid.
  for (const method of ['yoco', 'cash']) {
    assert.equal(rosterPaymentStatus(notes({ status: 'paid', method }), paidAt, SAM), 'paid', method)
  }
  for (const method of ['eft', 'manual', 'manual_card']) {
    assert.equal(rosterPaymentStatus(notes({ status: 'paid', method }), paidAt, SAM), 'none', method)
  }
  // The EFT admin still sees the raw truth for every method.
  for (const method of ['eft', 'manual', 'manual_card', 'yoco', 'cash']) {
    assert.equal(rosterPaymentStatus(notes({ status: 'paid', method }), paidAt, EFT_ADMIN_EMAIL), 'paid', method)
  }
  // paid_at alone (no method) is her-channel by default — nothing master about it.
  assert.equal(rosterPaid('just a note', '2026-07-19T00:00:00Z'), true)
  assert.equal(rosterPaymentStatus('just a note', '2026-07-19T00:00:00Z', SAM), 'paid')
  // IN-FLIGHT 'collected' (recorded, not settled) is NOT paid and masks to 'none'.
  assert.equal(rosterPaid(notes({ status: 'collected' }), null), false)
  assert.equal(rosterPaymentStatus(notes({ status: 'collected' }), null, SAM), 'none')
  // Plain unpaid states pass through untouched.
  assert.equal(rosterPaymentStatus(notes({ status: 'pending' }), null, SAM), 'pending')
  assert.equal(rosterPaymentStatus('just a note', null, SAM), 'none')
  // The EFT admin always sees the raw truth.
  assert.equal(rosterPaymentStatus(notes({ status: 'collected' }), null, EFT_ADMIN_EMAIL), 'collected')
})

// ---------------------------------------------------------------------------
// The OWNERVIS hand-over must not survive money in motion.
// Taona 2026-07-29: "all payments yet to be reconciled except for y and k
// should never be known by her."
// ---------------------------------------------------------------------------

test('a handed-over vendor goes BACK behind the wall once money is collected', () => {
  // Stubborn Monkey, live on 2026-07-29. Handed over so Samreen could help a
  // vendor whose card kept declining; the money then arrived by EFT and was
  // marked collected. The hand-over branch returned true unconditionally, so it
  // kept the vendor visible straight through the collection.
  const notes = withOwnerVisibleMarker('⟦PORTAL:' + Buffer.from(JSON.stringify({
    payment: { status: 'collected', amount: 3700, eft_collected_at: '2026-07-26T12:10:56.307Z' },
  })).toString('base64') + '⟧')
  assert.equal(vendorInOwnerScope(notes, null), false)
})

test('but a handed-over vendor who SETTLES by card is hers again (Y&K)', () => {
  // Y&K touched EFT and was then settled through Yoco. Reconciliation is what
  // ends the arrangement, so this one must stay visible.
  const notes = withOwnerVisibleMarker('⟦PORTAL:' + Buffer.from(JSON.stringify({
    payment: { status: 'paid', method: 'yoco', amount: 4800, eft_revealed_at: '2026-07-24T09:00:00.000Z' },
  })).toString('base64') + '⟧')
  assert.equal(vendorInOwnerScope(notes, '2026-07-28T00:00:00.000Z'), true)
})

test('an ordinary hand-over with no payment activity still works', () => {
  // The 14 vendors carrying OWNERVIS with a clean payment state must be
  // unaffected, or the guard has broken the feature it protects.
  assert.equal(vendorInOwnerScope(withOwnerVisibleMarker('needs a payment plan'), null), true)
})

test('an EFT-settled hand-over stays hidden', () => {
  const notes = withOwnerVisibleMarker('⟦PORTAL:' + Buffer.from(JSON.stringify({
    payment: { status: 'paid', method: 'eft', amount: 3700 },
  })).toString('base64') + '⟧')
  assert.equal(vendorInOwnerScope(notes, '2026-07-20T00:00:00.000Z'), false)
})

// ---------------------------------------------------------------------------
// earliestEftTimestamp drives the owner-view cutoff on reconciliation.
// ---------------------------------------------------------------------------

test('earliestEftTimestamp returns the earliest EFT touch', () => {
  const state = parsePortalState(updatePortalStateImpl('note', {
    v: 1,
    payment: {
      eft_revealed_at: '2026-07-28T10:00:00.000Z',
      eft_submitted_at: '2026-07-27T09:00:00.000Z',
      eft_collected_at: '2026-07-27T18:00:00.000Z',
    },
  }))
  assert.equal(earliestEftTimestamp(state), '2026-07-27T09:00:00.000Z')
})

test('earliestEftTimestamp returns null when no EFT touch exists', () => {
  assert.equal(earliestEftTimestamp(parsePortalState('note')), null)
  assert.equal(earliestEftTimestamp(parsePortalState(updatePortalStateImpl('note', {
    v: 1,
    payment: { status: 'paid', method: 'yoco' },
  }))), null)
})

test('earliestEftTimestamp handles a single touch and ignores empty strings', () => {
  const state = parsePortalState(updatePortalStateImpl('note', {
    v: 1,
    payment: {
      eft_collected_at: '2026-07-25T12:00:00.000Z',
      eft_revealed_at: '',
    },
  }))
  assert.equal(earliestEftTimestamp(state), '2026-07-25T12:00:00.000Z')
})


test('getEftMode env override forces the lane on or off without touching the DB', async () => {
  const original = process.env.EFT_MODE
  try {
    for (const on of ['on', 'ON', '1', 'true', 'yes']) {
      process.env.EFT_MODE = on
      assert.equal(await getEftMode(), true, `${on} should force EFT mode on`)
    }
    for (const off of ['off', 'OFF', '0', 'false', 'no']) {
      process.env.EFT_MODE = off
      assert.equal(await getEftMode(), false, `${off} should force EFT mode off`)
    }
  } finally {
    if (original === undefined) delete process.env.EFT_MODE
    else process.env.EFT_MODE = original
  }
})

test('getPaymentRail env override maps to the three rails; getEftMode derives from it', async () => {
  const original = process.env.EFT_MODE
  try {
    process.env.EFT_MODE = 'master'
    assert.equal(await getPaymentRail(), 'master')
    assert.equal(await getEftMode(), true, 'master is an EFT rail')
    for (const v of ['on', '1', 'true', 'yes', 'eft', 'samreen_eft']) {
      process.env.EFT_MODE = v
      assert.equal(await getPaymentRail(), 'samreen_eft', `${v} -> samreen_eft`)
      assert.equal(await getEftMode(), true, `${v} is an EFT rail`)
    }
    for (const v of ['off', '0', 'false', 'no', 'yoco']) {
      process.env.EFT_MODE = v
      assert.equal(await getPaymentRail(), 'yoco', `${v} -> yoco`)
      assert.equal(await getEftMode(), false, `${v} is card-only`)
    }
  } finally {
    if (original === undefined) delete process.env.EFT_MODE
    else process.env.EFT_MODE = original
  }
})

test('onCovertMasterLane: master sweeps everyone; else only ⟦EFT⟧ + the frozen set', () => {
  const frozen = { protectedIds: new Set(['frozen1']) }
  const plain = 'ordinary vendor'
  const marked = withEftMarker('')

  // 'master' rail: the WHOLE population is covert (pays into ...191, hidden).
  assert.equal(onCovertMasterLane('anyone', plain, 'master', null), true)
  assert.equal(onCovertMasterLane('frozen1', plain, 'master', frozen), true)

  // 'samreen_eft' rail: only the pinned cohort is covert.
  assert.equal(onCovertMasterLane('x', plain, 'samreen_eft', frozen), false, 'plain vendor is Samreen’s')
  assert.equal(onCovertMasterLane('x', marked, 'samreen_eft', frozen), true, '⟦EFT⟧ hand-pick stays covert')
  assert.equal(onCovertMasterLane('frozen1', plain, 'samreen_eft', frozen), true, 'frozen 66 stay covert')

  // 'yoco' rail: a ⟦EFT⟧ carve-out vendor still pays into the covert ...191 account.
  assert.equal(onCovertMasterLane('x', marked, 'yoco', null), true)
  assert.equal(onCovertMasterLane('x', plain, 'yoco', null), false)

  // ⟦OWNERVIS⟧ hand-back releases a frozen member back to Samreen's account, and
  // wins even over the master-rail sweep (Cakes & Crumbs release, 2026-09-07).
  const handedBack = withOwnerVisibleMarker('')
  assert.equal(onCovertMasterLane('frozen1', handedBack, 'samreen_eft', frozen), false, '⟦OWNERVIS⟧ frozen member is Samreen’s')
  assert.equal(onCovertMasterLane('frozen1', handedBack, 'master', frozen), false, '⟦OWNERVIS⟧ beats the master sweep')

  // ⟦NEWVENDOR⟧ cohort: covert on EVERY rail, no ⟦EFT⟧ marker needed. Regression
  // for Haadiya Bakes (2026-09-11): tagged ⟦NEWVENDOR⟧ + ⟦NOEFT⟧, no ⟦EFT⟧, not
  // frozen — she was shown Samreen's ...629 on the samreen_eft rail and paid it.
  const newVendor = withNewVendorMarker('')
  assert.equal(onCovertMasterLane('x', newVendor, 'samreen_eft', frozen), true, 'new vendor is covert on samreen_eft')
  assert.equal(onCovertMasterLane('x', newVendor, 'master', frozen), true, 'new vendor is covert on master')
  assert.equal(onCovertMasterLane('x', newVendor, 'yoco', null), true, 'new vendor is covert even on yoco')
  assert.equal(onCovertMasterLane('x', withNoEftMarker(newVendor), 'samreen_eft', frozen), true, '⟦NOEFT⟧ cannot pull a new vendor off the master lane')
  assert.equal(onCovertMasterLane('x', withOwnerVisibleMarker(newVendor), 'master', frozen), false, '⟦OWNERVIS⟧ still hands a new vendor back to Samreen')
})

test('paymentOnOwnerSide: rail-INDEPENDENT whose-money test (the /admin/paid fence)', () => {
  // 2026-09-11: under the master rail the live onCovertMasterLane swept EVERYONE
  // covert and /admin/paid collapsed to the 7 ⟦OWNERVIS⟧ hand-backs, hiding every
  // Yoco payer, Samreen-EFT payer and plan vendor. This predicate must not move
  // when the rail does.
  const frozen = { protectedIds: new Set(['frozen1']) }
  const yocoPaid = updatePortalStateImpl('note', { v: 1, payment: { status: 'paid', method: 'yoco', amount: 6500 } } as never)
  const samreenEftPaid = updatePortalStateImpl('note', { v: 1, payment: { status: 'paid', method: 'samreen_eft', amount: 12000 } } as never)
  const masterSettled = updatePortalStateImpl('note', { v: 1, payment: { status: 'paid', method: 'eft', amount: 6500 } } as never)
  const masterStampedProof = updatePortalStateImpl('note', { v: 1, payment: {
    eft_submitted_at: '2026-09-11T12:00:00.000Z',
    proofs: [{ path: 'x/eft-proof-1.pdf', kind: 'eft_submission', uploaded_at: '2026-09-11T12:00:00.000Z', account: 'master' }],
  } } as never)
  const samreenStampedProof = updatePortalStateImpl('note', { v: 1, payment: {
    eft_submitted_at: '2026-09-11T12:00:00.000Z',
    proofs: [{ path: 'x/eft-proof-1.pdf', kind: 'eft_submission', uploaded_at: '2026-09-11T12:00:00.000Z', account: 'samreen' }],
  } } as never)

  assert.equal(paymentOnOwnerSide('x', yocoPaid, frozen), true, 'a Yoco payer is hers on every rail')
  assert.equal(paymentOnOwnerSide('x', samreenEftPaid, frozen), true, 'a Samreen-EFT payer is hers on every rail')
  assert.equal(paymentOnOwnerSide('x', samreenStampedProof, frozen), true, 'a proof into her ...629 stays listed')
  assert.equal(paymentOnOwnerSide('x', masterSettled, frozen), false, 'a master-method settlement is his')
  assert.equal(paymentOnOwnerSide('x', masterStampedProof, frozen), false, 'a master-stamped proof (...191) never surfaces')
  assert.equal(paymentOnOwnerSide('x', withEftMarker(''), frozen), false, 'the pinned ⟦EFT⟧ cohort is his')
  assert.equal(paymentOnOwnerSide('x', withNewVendorMarker(''), frozen), false, 'the ⟦NEWVENDOR⟧ cohort is his')
  assert.equal(paymentOnOwnerSide('frozen1', 'note', frozen), false, 'the frozen cutover set is his')
  assert.equal(paymentOnOwnerSide('frozen1', withOwnerVisibleMarker('note'), frozen), true, '⟦OWNERVIS⟧ hands a frozen member back')
})

test('eftBankFor picks the covert ...191 account only when covert', () => {
  assert.equal(eftBankFor(true).accountNumber, getMasterBankDetails().accountNumber)
  assert.equal(eftBankFor(false).accountNumber, getEftBankDetails().accountNumber)
  assert.notEqual(getMasterBankDetails().accountNumber, getEftBankDetails().accountNumber, 'the two rails must never share an account')
})

test('revealsPaymentArrangement strips the covert ...191 account, not just Samreen\'s ...629', () => {
  const master = getMasterBankDetails().accountNumber
  const samreen = getEftBankDetails().accountNumber
  // The covert account quoted back to Samreen must be hidden (this was the leak).
  assert.equal(revealsPaymentArrangement(`Payment done to ${master}, thanks`), true, 'covert ...191 must be stripped')
  // Samreen's own account still hidden (unchanged).
  assert.equal(revealsPaymentArrangement(`Payment done to ${samreen}, thanks`), true)
  // A refusal is still shown even if it names EFT (unchanged carve-out).
  assert.equal(revealsPaymentArrangement('Stall fees are card only through Yoco, there are no banking details.'), false)
})

test('eftProofVisibleToOwner never surfaces a ⟦EFT⟧ vendor, even with a post-cutover proof', () => {
  const fullEft = { startedAt: '2026-08-26T00:00:00.000Z', protectedIds: new Set<string>() }
  const postCutoverProof = { v: 1, payment: { eft_submitted_at: '2026-08-27T10:00:00.000Z' } }
  const visibleNotes = updatePortalStateImpl('note', postCutoverProof as never)
  // A plain non-frozen vendor with a post-cutover proof IS visible to the owner...
  assert.equal(eftProofVisibleToOwner('v1', visibleNotes, fullEft), true)
  // ...but the SAME vendor once hand-picked onto the covert lane (⟦EFT⟧) is not.
  assert.equal(eftProofVisibleToOwner('v1', withEftMarker(visibleNotes), fullEft), false)
})

test('eftProofVisibleToOwner: ⟦OWNERVIS⟧ hands a covert/frozen vendor to the owner (deliberate override)', () => {
  // Regression for the En Vogue Cpt fix (2026-09-02): a protected+⟦EFT⟧ vendor that
  // an admin deliberately marked ⟦OWNERVIS⟧ must move OFF the master lane and onto
  // Samreen's EFT Proofs page. The override is bounded to the marker; the frozen
  // cohort and un-marked ⟦EFT⟧ vendors stay hidden.
  const fullEft = { startedAt: '2026-08-26T00:00:00.000Z', protectedIds: new Set<string>(['frozen1']) }
  const notes = updatePortalStateImpl('note', { v: 1, payment: { eft_submitted_at: '2026-08-27T10:00:00.000Z' } } as never)
  // frozen + ⟦EFT⟧, no OWNERVIS -> hidden (the seal holds for the other 65).
  assert.equal(eftProofVisibleToOwner('frozen1', withEftMarker(notes), fullEft), false)
  // same vendor marked ⟦OWNERVIS⟧ -> handed to the owner, proof is HERS.
  assert.equal(eftProofVisibleToOwner('frozen1', withOwnerVisibleMarker(withEftMarker(notes)), fullEft), true)
  // the post-cutover FLOOR still hides a PRE-cutover proof for everyone else...
  const pre = updatePortalStateImpl('note', { v: 1, payment: { eft_submitted_at: '2026-08-01T00:00:00.000Z' } } as never)
  assert.equal(eftProofVisibleToOwner('v2', pre, fullEft), false)
  // ...but the hand-set marker overrides it (Island Way Sorbet, paid into her account
  // 2026-08-25, before the 31 Aug re-activation; the proof is dated truthfully).
  assert.equal(eftProofVisibleToOwner('frozen1', withOwnerVisibleMarker(pre), fullEft), true)
  // OWNERVIS with NO proof at all -> nothing to surface.
  assert.equal(eftProofVisibleToOwner('frozen1', withOwnerVisibleMarker('note'), fullEft), false)
})

// ---------------------------------------------------------------------------
// 2026-09-05: Samreen's own EFT confirmations must count as HERS.
// /api/admin/eft-proofs/confirm used to write method 'eft', a MASTER_ONLY method,
// so every vendor she confirmed on her own page fell out of her finance
// dashboard, roster scope and inbox. 'samreen_eft' is her reconciled account.
// ---------------------------------------------------------------------------

test("a vendor Samreen confirmed on her EFT-proofs page ('samreen_eft') is in her scope and reads PAID", () => {
  const notes = updatePortalStateImpl('note', { v: 1, payment: { status: 'paid', method: 'samreen_eft', amount: 6500, eft_submitted_at: '2026-09-01T10:00:00.000Z', paid_at: '2026-09-05T08:00:00.000Z' } } as never)
  assert.equal(reconciledPaid(notes, '2026-09-05T08:00:00.000Z'), true)
  assert.equal(vendorInOwnerScope(notes, '2026-09-05T08:00:00.000Z'), true)
  assert.equal(rosterPaymentStatus(notes, '2026-09-05T08:00:00.000Z', 'capetownhalaal@gmail.com'), 'paid')
})

test("the same state with method 'eft' (a master-lane settlement) stays OUT of her scope", () => {
  const notes = updatePortalStateImpl('note', { v: 1, payment: { status: 'paid', method: 'eft', amount: 6500, eft_submitted_at: '2026-09-01T10:00:00.000Z' } } as never)
  assert.equal(reconciledPaid(notes, '2026-09-05T08:00:00.000Z'), false)
  assert.equal(vendorInOwnerScope(notes, '2026-09-05T08:00:00.000Z'), false)
})


// ---------------------------------------------------------------------------
// 2026-09-11: the ⟦NEWVENDOR⟧ cohort is master-lane BY DEFINITION, on every rail.
// Haadiya Bakes carried ⟦NEWVENDOR⟧ + ⟦NOEFT⟧ but no ⟦EFT⟧ and was not frozen,
// so on the samreen_eft rail she was shown Samreen's ...629 and paid into it.
// ---------------------------------------------------------------------------

test('eftProofVisibleToOwner never surfaces a ⟦NEWVENDOR⟧ cohort proof', () => {
  const fullEft = { startedAt: '2026-08-26T00:00:00.000Z', protectedIds: new Set<string>() }
  const postCutoverProof = updatePortalStateImpl('note', { v: 1, payment: { eft_submitted_at: '2026-09-10T12:23:39.227Z' } } as never)
  assert.equal(eftProofVisibleToOwner('v1', postCutoverProof, fullEft), true, 'a plain vendor’s post-cutover proof is hers (control)')
  assert.equal(eftProofVisibleToOwner('v1', withNewVendorMarker(postCutoverProof), fullEft), false, 'a new-vendor proof is the master’s, never hers')
})

test('eftProofVisibleToOwner: a master-stamped proof never surfaces, an unstamped one stays listed on any rail', () => {
  // 2026-09-11: flipping to the master rail must only change which bank details
  // vendors SEE, not empty the owner’s list of vendors who already paid into her
  // ...629 account. The account is stamped on the proof at filing time; unstamped
  // (pre-master-rail) proofs passing the fence are Samreen-account proofs.
  const fullEft = { startedAt: '2026-08-26T00:00:00.000Z', protectedIds: new Set<string>() }
  const stampedMaster = updatePortalStateImpl('note', { v: 1, payment: {
    eft_submitted_at: '2026-09-11T12:00:00.000Z',
    proofs: [{ path: 'v1/eft-proof-1.pdf', kind: 'eft_submission', uploaded_at: '2026-09-11T12:00:00.000Z', account: 'master' }],
  } } as never)
  assert.equal(eftProofVisibleToOwner('v1', stampedMaster, fullEft), false, 'paid into the covert ...191 while master was on: never hers')
  const stampedSamreen = updatePortalStateImpl('note', { v: 1, payment: {
    eft_submitted_at: '2026-09-11T12:00:00.000Z',
    proofs: [{ path: 'v1/eft-proof-1.pdf', kind: 'eft_submission', uploaded_at: '2026-09-11T12:00:00.000Z', account: 'samreen' }],
  } } as never)
  assert.equal(eftProofVisibleToOwner('v1', stampedSamreen, fullEft), true, 'paid into her ...629: stays listed whatever the rail')
})

test('resolveInEftLane: ⟦NEWVENDOR⟧ always sees the EFT panel; ⟦NOEFT⟧ cannot exclude them', async () => {
  // Haadiya Bakes' exact marker set: ⟦NEWVENDOR⟧ + ⟦NOEFT⟧, no ⟦EFT⟧.
  const notes = withNoEftMarker(withNewVendorMarker(''))
  for (const mode of ['samreen_eft', 'master', 'yoco']) {
    process.env.EFT_MODE = mode
    try {
      assert.equal(await resolveInEftLane({ admin_notes: notes }, false), true, `new vendor sees EFT on ${mode}`)
    } finally {
      delete process.env.EFT_MODE
    }
  }
  // A paid cohort member keeps the normal paid view (no EFT panel).
  process.env.EFT_MODE = 'master'
  try {
    assert.equal(await resolveInEftLane({ admin_notes: notes, paid_at: '2026-09-10T00:00:00Z' }, true), false)
  } finally {
    delete process.env.EFT_MODE
  }
})
