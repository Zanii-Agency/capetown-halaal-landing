// TEMPORARY EFT lane (Yoco-outage side-channel).
//
// During a Yoco outage a hand-picked cohort of vendors pays by EFT. Lane
// membership is a single reversible plaintext marker on
// vendor_applications.admin_notes:  ⟦EFT⟧ , queryable via
// admin_notes.ilike '%⟦EFT⟧%', following the ⟦STALL⟧ / ⟦WAV⟧ token precedent
// (DDL is blocked on this Supabase project, Law 8). The marker drives three
// branches: the vendor EFT payment panel, the inbox carve-out (a lane vendor's
// email + WhatsApp leave the main admin inbox), and the bot maintenance
// short-circuit. Removing the marker is the per-vendor revert. This whole
// module (and everything that imports it) is deleted once Yoco is back and the
// lane is empty.
//
// Note: the EFT lane NEVER calls confirmPayment(), so no vendor/owner email or
// WhatsApp fires and the admin `payment.status`/`paid_at` stay unpaid. That is
// the whole point: the main data stays clean and reconcilable.

import { parseAllocation, SMALL_EFT_ROTATION_TIERS } from '@/lib/stalls'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState, setArrangement, type PortalState } from '@/lib/portal-state'
import { recordLedger } from '@/lib/zanii-ledger'

const EFT_MARKER = '⟦EFT⟧'
// Bare token; cannot collide with ⟦PORTAL:<base64>⟧ or ⟦STALL:...⟧ (different
// bodies), and PORTAL/STALL writers only strip their own marker, so ⟦EFT⟧
// survives their read-modify-writes untouched.
const EFT_RE = /⟦EFT⟧/

// Bare token like ⟦EFT⟧/⟦NOEFT⟧, distinct body so no reader collides with them.
const OWNERVIS_MARKER = '⟦OWNERVIS⟧'
const OWNERVIS_RE = /⟦OWNERVIS⟧/

const NOEFT_MARKER = '⟦NOEFT⟧'
// Explicit EXCLUSION: this vendor is handled manually and must NEVER enter the EFT
// lane, even under global mode. They never see EFT details on their portal and
// their conversations stay on the main inbox. Overrides both global mode and
// ⟦EFT⟧. Distinct token, no collision with /⟦EFT⟧/ (the char after ⟦ is 'N').
const NOEFT_RE = /⟦NOEFT⟧/

/** Admin email allowed to see and operate the /admin/eft surface. Env-overridable
 *  so the gate can move without a code change. Compared lower-cased. */
export const EFT_ADMIN_EMAIL = (process.env.EFT_ADMIN_EMAIL || 'dev@cthalaal.co.za').toLowerCase()

/** True when the caller's email may use the EFT surface. */
export function isEftAdmin(email?: string | null): boolean {
  return !!email && email.toLowerCase() === EFT_ADMIN_EMAIL
}

/**
 * The payment status a given admin is allowed to SEE on the general admin lists.
 *
 * 'collected' is the EFT lane's interim state: an operator has confirmed the
 * money landed, so the VENDOR's portal behaves exactly as if they had paid by
 * card. The festival owner must not learn of it, because the whole lane is
 * walled from her until the payment is settled through Yoco (Taona, 2026-07-25:
 * "once I click mark collected, everything for the vendor should be normal, only
 * Samreen doesn't know and never will know till we do Yoco settlement").
 *
 * So for every viewer except the EFT admin, 'collected' is reported as 'none',
 * which is exactly what the row showed before the money was collected. The EFT
 * console (/admin/eft) reads the raw state directly and is unaffected, and Yoco
 * settlement flips the row to a real 'paid' that everyone sees.
 *
 * Display only. It never changes what is stored, and never suppresses a real
 * 'paid', so revenue can not go missing from the owner's finance view.
 */
export function visiblePaymentStatus(status: string | null | undefined, viewerEmail?: string | null): string {
  const s = status || 'none'
  if (s !== 'collected') return s
  return isEftAdmin(viewerEmail) ? s : 'none'
}

/** The payment status to DISPLAY on a roster that shows EVERY vendor (the
 *  vendors page and the outside roster, the on-screen twins of the export).
 *  visiblePaymentStatus only masks 'collected'; it cannot see the method, so an
 *  EFT/manual settlement stamped status:'paid' still read 'paid' to the festival
 *  owner (Amc cookware, Africa Muslims Agency, Elegant Muslimah, Table Art on
 *  2026-08-11). Permanent rule (Taona): a vendor is 'paid' to her only once Yoco
 *  reconciles it; every master-lane state ('paid' via eft/manual_card/manual, or
 *  the 'collected' interim) masks to 'none', exactly as 'collected' already did.
 *  The EFT admin still reads the true state. Method-aware, so it needs the notes
 *  and paid_at, not just the status string. Reuses reconciledPaid so it cannot
 *  drift from the export. */
export function rosterPaymentStatus(
  adminNotes: string | null | undefined,
  paidAt: string | null | undefined,
  viewerEmail?: string | null,
): string {
  const raw = parsePortalState(adminNotes).payment?.status || (paidAt ? 'paid' : 'none')
  if (isEftAdmin(viewerEmail)) return raw
  if (rosterPaid(adminNotes, paidAt)) return 'paid'
  return raw === 'paid' || raw === 'collected' ? 'none' : raw
}

// Operator PREVIEW addresses: emails an operator uses to preview vendor-facing
// output (e.g. a self-sent invoice preview). Their unified-inbox threads are
// confined to the dev-only EFT feed so a preview never surfaces in the festival
// owner's (Samreen's) main inbox (Taona 2026-07-25). Any send through the CTH
// Resend account is mirrored into support_inbox_messages by the resend webhook,
// so a preview to a non-vendor address would otherwise show to her. This is an
// inbox-VISIBILITY rule only; it does NOT touch EFT/payment routing. Env-tunable.
const OPERATOR_PREVIEW_EMAILS = new Set<string>(
  ((process.env.OPERATOR_PREVIEW_EMAILS || 'taonac96@gmail.com')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
)

/** True when the email is an operator preview address (see above). */
export function isOperatorPreviewAddress(email?: string | null): boolean {
  return !!email && OPERATOR_PREVIEW_EMAILS.has(email.toLowerCase().trim())
}

/** True when the vendor is in the EFT lane. */
export function hasEftMarker(adminNotes?: string | null): boolean {
  return EFT_RE.test(adminNotes || '')
}

/** Add the vendor to the EFT lane (idempotent). Preserves human prose and every
 *  other marker (⟦PORTAL⟧, ⟦STALL⟧, ⟦WAV⟧). */
export function withEftMarker(adminNotes?: string | null): string {
  const notes = adminNotes || ''
  if (EFT_RE.test(notes)) return notes
  const trimmed = notes.trim()
  return trimmed ? `${trimmed}\n${EFT_MARKER}` : EFT_MARKER
}

/** Remove the vendor from the EFT lane. Preserves human prose and every other
 *  marker. */
export function withoutEftMarker(adminNotes?: string | null): string {
  return (adminNotes || '').replace(EFT_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** True when the vendor is explicitly EXCLUDED from EFT (handled manually). */
export function hasNoEftMarker(adminNotes?: string | null): boolean {
  return NOEFT_RE.test(adminNotes || '')
}

// Internal / operator accounts that are NEVER EFT-paying vendors, regardless of
// global mode or markers (Taona 2026-07-24: "anything with samreenkumandan should
// have no eft"; Samreen, Altaf, and GLOBAL CUISINE are her own internal rows).
// Identity-matched so FUTURE rows are caught too, not just today's. Email is
// matched case-insensitively (exact set + the shared operator handle as a
// substring); phone on last-9 digits so formatting never breaks the match.
const INTERNAL_EMAILS = new Set<string>(['sales@globalcuisine.co.za', 'capetownhalaal@gmail.com'])
const INTERNAL_EMAIL_SUBSTRINGS = ['samreenkumandan']
const INTERNAL_PHONE_LAST9 = new Set<string>(['723803393']) // Samreen's line (GLOBAL CUISINE)
// TODO(altaf): add Altaf's email + phone here once known so his rows are covered.

/** True when a contact identity belongs to an internal/operator account that must
 *  never be routed through EFT (no payment panel, never swept to the Master lane). */
export function isInternalAccount(email?: string | null, phone?: string | null): boolean {
  const e = (email || '').toLowerCase().trim()
  if (e && (INTERNAL_EMAILS.has(e) || INTERNAL_EMAIL_SUBSTRINGS.some((s) => e.includes(s)))) return true
  const last9 = (phone || '').replace(/\D/g, '').slice(-9)
  return !!last9 && INTERNAL_PHONE_LAST9.has(last9)
}

/** Contact identity, passed to the lane predicates so an internal account is
 *  excluded even when global EFT mode would otherwise sweep it in. */
export interface LaneIdentity { email?: string | null; phone?: string | null }

/** Exclude the vendor from EFT (idempotent). Also strips any ⟦EFT⟧ so the two
 *  never coexist. Preserves prose and every other marker. */
export function withNoEftMarker(adminNotes?: string | null): string {
  const base = withoutEftMarker(adminNotes) // drop ⟦EFT⟧ if present
  if (NOEFT_RE.test(base)) return base
  const trimmed = base.trim()
  return trimmed ? `${trimmed}\n${NOEFT_MARKER}` : NOEFT_MARKER
}

/** Lift the EFT exclusion. Preserves prose and every other marker. */
export function withoutNoEftMarker(adminNotes?: string | null): string {
  return (adminNotes || '').replace(NOEFT_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** Grant a vendor a payment extension AND exclude them from the EFT push in one
 *  step. Operator rule 2026-08-10: "anyone who opts for payment end of month
 *  (31 Aug) by default exclude them from the EFT list" — they settle by card
 *  when ready, off the EFT rail. Writes the deferral first (portal marker), then
 *  re-reads and appends ⟦NOEFT⟧ so neither write clobbers the other. */
export async function grantExtension(applicationId: string, until: string, note?: string): Promise<void> {
  await setArrangement(applicationId, until, note)
  const admin = createAdminClient()
  const { data } = await admin.from('vendor_applications').select('admin_notes').eq('id', applicationId).maybeSingle()
  const next = withNoEftMarker((data?.admin_notes as string) || '')
  await admin.from('vendor_applications').update({ admin_notes: next }).eq('id', applicationId)
  // Signed proof-of-action: a payment-deferral is a money arrangement, receipted
  // under the payments DID. Best-effort: recordLedger never throws.
  await recordLedger('payments', 'cth.pay.extension_granted', { application_id: applicationId, until, note: note || null })
}

export interface EftBankDetails {
  accountName: string
  bank: string
  accountNumber: string
  branchCode: string
  accountType?: string
}

// CTH / Young at Heart's own EFT RECEIVING account. These are shown to vendors
// so they can pay, i.e. they are display data, not a secret credential. Live
// values supplied by the operator 2026-07-23; branch 250655 is FNB's universal
// EFT branch code. Overridable via env without a code change.
//
// ACCOUNT CHANGED 2026-07-27 on Taona's instruction: 63170873351 -> 63141269191.
// Everything else (account name, bank, branch code) is unchanged. This constant
// is the ONLY place the number appears in the repo and no EFT_BANK_ACCOUNT_NUMBER
// override is set in production, so this line alone governs what every vendor
// sees: portal EftPanel, the admin EFT tab, invoices, emails and the bot.
const DEFAULT_BANK: EftBankDetails = {
  accountName: 'Halaal Hub',
  bank: 'FNB',
  accountNumber: '63141269191',
  branchCode: '250655',
}

/** CTH / Young at Heart EFT bank details. Env overrides the in-code defaults so
 *  the account can change without a deploy. Always returns a value. */
export function getEftBankDetails(): EftBankDetails {
  return {
    accountName: process.env.EFT_BANK_ACCOUNT_NAME || DEFAULT_BANK.accountName,
    bank: process.env.EFT_BANK_NAME || DEFAULT_BANK.bank,
    accountNumber: process.env.EFT_BANK_ACCOUNT_NUMBER || DEFAULT_BANK.accountNumber,
    branchCode: process.env.EFT_BANK_BRANCH_CODE || DEFAULT_BANK.branchCode,
    accountType: process.env.EFT_BANK_ACCOUNT_TYPE || undefined,
  }
}

/** GLOBAL EFT mode. When ON, EVERY vendor sees EFT details (Yoco hidden) and
 *  every vendor's comms route to the EFT tab. Read order: env EFT_MODE forces it
 *  on or off (crisis override / test harness), else the latest persisted toggle
 *  from the /admin/eft tab (site_events, no DDL, instant). A vendor is "in the
 *  lane" when this is ON *or* they carry the per-vendor ⟦EFT⟧ marker. Server-only. */
export async function getEftMode(): Promise<boolean> {
  const env = (process.env.EFT_MODE || '').toLowerCase()
  if (env === '1' || env === 'true' || env === 'on' || env === 'yes') return true
  if (env === '0' || env === 'false' || env === 'off' || env === 'no') return false
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('site_events')
      .select('metadata')
      .eq('event_type', 'eft_mode')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data?.metadata as { on?: boolean } | null)?.on === true
  } catch {
    // Fail CLOSED to normal (Yoco) operation: a read failure must never silently
    // flip the whole festival onto EFT.
    return false
  }
}

/** Settlement methods the festival owner does NOT handle. A vendor who paid this
 *  way is the master's, exactly like an unpaid one. Deliberately a DENYLIST, not
 *  an allowlist: 20 of 47 paid vendors carry no `method` at all (settled before
 *  the field existed, all pre-dating EFT mode), and an allowlist would blank them
 *  out of her world. Every new payment records its method, so a blank can only be
 *  historical.
 *
 *  'manual' is the method finance/capture writes for an operator-entered EFT
 *  capture (audience:'master'; it overwrites confirmPayment's 'eft' at
 *  capture/route.ts). It belongs here for the same reason 'eft' does. Leaving it
 *  out let a master-lane capture (Table Art, captured 2026-07-05) read as
 *  hers/paid on every surface until 2026-08-10. */
const MASTER_ONLY_METHODS = new Set(['eft', 'manual_card', 'manual'])

/** The vendor-roster PAID/UNPAID label — permanent rule (Taona 2026-08-10:
 *  "all vendors show, EFT shows as unpaid, they only show paid once Yoco
 *  reconciled"). A vendor reads PAID only once money settled through a channel
 *  the festival owner reconciles (Yoco, cash, waived): a real paid_at, or portal
 *  status 'paid', via a NON-master method. Every master-lane settlement — EFT,
 *  manual_card, finance/capture 'manual' — and the 'collected' interim reads
 *  UNPAID until a Yoco reconciliation flips it.
 *
 *  This is vendorInOwnerScope's settledHerWay, extracted so the roster export and
 *  the visibility scope share ONE rule and cannot drift. */
export function reconciledPaid(
  adminNotes: string | null | undefined,
  paidAt?: string | null,
): boolean {
  const p = parsePortalState(adminNotes).payment
  return (!!paidAt || p?.status === 'paid') && !MASTER_ONLY_METHODS.has(String(p?.method || ''))
}

/** The roster PAID label. A vendor reads PAID once it has SETTLED — paid_at set, or
 *  portal status 'paid' — regardless of method. This is byte-for-byte the same rule
 *  the finance dashboard already uses for is_paid/totalRevenue, so the vendors page,
 *  the export and the total can never disagree.
 *
 *  Taona 2026-08-16: a settled EFT payment is a DONE deal, whoever reconciled it —
 *  Samreen from her portal (Amc cookware, Elegant Muslimah, Table Art), the EFT
 *  admin handing a ⟦NOEFT⟧/⟦OWNERVIS⟧ vendor to her (Islamic Relief SA, Africa
 *  Muslims Agency), or a Yoco settlement (Y&K, Vanilla Cream). "The 5 are correct,
 *  make sure their payments reflect on the total." What stays masked is the
 *  IN-FLIGHT master lane — 'collected' (money recorded, not reconciled) is NOT a
 *  settlement, so it is not paid here and rosterPaymentStatus renders it 'none'.
 *  That is where the earlier method-based masking went too far: it hid settled EFT
 *  the owner had every right to see, while the leak it was guarding against
 *  (EFT-in-progress) is the 'collected' state, which this correctly withholds.
 *
 *  reconciledPaid (Yoco/cash/waived only) stays the predicate for vendorInOwnerScope
 *  — that wall decides VISIBILITY, a separate concern from the paid/unpaid label. */
export function rosterPaid(
  adminNotes: string | null | undefined,
  paidAt?: string | null,
): boolean {
  return !!paidAt || parsePortalState(adminNotes).payment?.status === 'paid'
}

/** Is this vendor inside the festival owner's world at all?
 *
 *  Taona 2026-07-26: "samreen should never have access to unpaid vendors except
 *  for when they sign up, sign contract... eft confirmed vendors staff badges
 *  notifications cant go to her only yoco paid staff badges" — she deals with
 *  vendors who have PAID through a channel she handles (Yoco, cash, waived), and
 *  with nobody else.
 *
 *  This supersedes vendorCommsInEftLane as the visibility test. That one asked
 *  "is this vendor on the EFT lane?", which let an EFT-SETTLED vendor back into
 *  her world the moment paid_at was written. The question is not how they got
 *  here, it is whether their money came through her channel.
 *
 *  The two pipeline events that reach her regardless of this (a vendor signing up
 *  and signing their contract) are carve-outs at the call sites, not exceptions
 *  here: they are the only moments an unpaid vendor is her business. */
export function vendorInOwnerScope(
  adminNotes: string | null | undefined,
  paidAt?: string | null,
): boolean {
  const p = parsePortalState(adminNotes).payment

  // Money is in motion outside the card lane: collected but not settled, bank
  // details revealed, a proof uploaded, or an operator-entered settlement.
  const touchedEft =
    p?.status === 'collected'
    || !!p?.eft_revealed_at
    || !!p?.eft_submitted_at
    || MASTER_ONLY_METHODS.has(String(p?.method || ''))

  // Settled through a channel she handles. Yoco reconciliation is what ENDS the
  // arrangement, so a vendor who touched EFT and then settled by card is hers
  // again. Y&K gifts and toys is exactly this case and must stay visible.
  // Shared with the roster export via reconciledPaid so the two cannot drift.
  const settledHerWay = reconciledPaid(adminNotes, paidAt)

  // DELIBERATE HAND-OVER. The only way an UNPAID vendor reaches the festival
  // owner. Taona 2026-07-27: vendors who write in asking for an extension or a
  // payment plan are hers to negotiate, and she cannot negotiate with someone
  // she cannot see. Applied per vendor, by an explicit act, never by a rule that
  // infers intent: a detector deciding who leaves this wall would eventually
  // decide wrong, and the wall only works because every hole in it was made on
  // purpose and can be listed.
  //
  // GUARDED AGAINST MONEY IN MOTION. This branch used to `return true`
  // unconditionally, which made it the one hole in the wall that ignored
  // payment state entirely. Stubborn Monkey was handed over so she could sort
  // out a vendor whose card kept declining, then the money arrived by EFT and
  // was marked collected on 2026-07-26; the hand-over kept the vendor visible
  // straight through the collection. Taona 2026-07-29: "all payments yet to be
  // reconciled except for y and k should never be known by her."
  //
  // The ⟦NOEFT⟧ branch below already carried this exact guard, with a comment
  // explaining the hazard. This branch did not, so the hazard simply moved.
  if (OWNERVIS_RE.test(adminNotes || '')) return !touchedEft || settledHerWay

  // EXCLUDED FROM EFT MEANS HERS. Taona 2026-07-28: "If excluded on master lane,
  // it belongs to samreen." The master lane exists to hide an EFT ARRANGEMENT.
  // A vendor carrying ⟦NOEFT⟧ has none by definition, so there is nothing to
  // withhold and keeping them on the master lane only hides an ordinary vendor
  // from the person meant to handle them.
  //
  // GUARDED, though, and this is the part that is not obvious. The marker says
  // what happens NEXT, not what already happened. Add ⟦NOEFT⟧ to someone who has
  // already paid by EFT, or who is sitting at 'collected' awaiting settlement
  // (Y&K gifts and toys is in exactly that state today), and an unguarded
  // hand-over would expose the settlement this wall was built to hide. So the
  // hand-over applies only to a vendor who never touched EFT at all: no interim
  // collection, no revealed bank details, no uploaded proof, no EFT/manual
  // settlement. (touchedEft is computed once at the top, shared with the
  // OWNERVIS branch above, so the two hand-overs cannot drift apart.)
  if (hasNoEftMarker(adminNotes) && !touchedEft) return true

  // 'collected' is the EFT interim state and never sets paid_at, so it correctly
  // fails this test and stays with the master until a real settlement lands.
  if (!paidAt && p?.status !== 'paid') return false
  return !MASTER_ONLY_METHODS.has(String(p?.method || ''))
}

/** Hand a vendor to the festival owner regardless of payment state. */
export function withOwnerVisibleMarker(adminNotes: string | null | undefined): string {
  const notes = adminNotes || ''
  return OWNERVIS_RE.test(notes) ? notes : `${notes}\n${OWNERVIS_MARKER}`.trim()
}

/** Take it back. The vendor returns to the normal payment-based rule. */
export function withoutOwnerVisibleMarker(adminNotes: string | null | undefined): string {
  return (adminNotes || '').replace(OWNERVIS_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

export function isOwnerVisible(adminNotes: string | null | undefined): boolean {
  return OWNERVIS_RE.test(adminNotes || '')
}

/** Whose CONVERSATIONS move to the master EFT tab (and off the festival owner's
 *  main inbox). The rule is PAYMENT STATUS, not EFT-engagement (Taona 2026-07-25:
 *  "every unpaid vendor's message goes to the master lane, only paid vendors stay
 *  on the normal lane"). While global EFT mode is ON, any vendor that is not
 *  truly PAID and not internal/⟦NOEFT⟧ is on the master lane — this includes both
 *  UNPAID vendors and EFT-`collected` vendors (interim, paid_at still null), so
 *  Samreen only ever sees fully Yoco-settled vendors during the outage.
 *    - ⟦EFT⟧ marker or an uploaded EFT proof → master lane ALWAYS (survives mode
 *      off, for a vendor mid-transaction), OR
 *    - global EFT mode ON → every unpaid/collected non-excluded vendor.
 *  A truly PAID vendor (paid_at set, or status 'paid' from a Yoco settlement) is
 *  NEVER in the lane; ⟦NOEFT⟧ and internal/operator accounts are explicit
 *  exclusions. The globalOn sweep self-reverts when EFT mode is switched off, so it
 *  cannot permanently strand the owner's inbox (the concern behind b886ff5). */
export function vendorCommsInEftLane(
  adminNotes: string | null | undefined,
  paidAt?: string | null,
  globalOn: boolean = false,
  identity?: LaneIdentity,
): boolean {
  if (identity && isInternalAccount(identity.email, identity.phone)) return false // internal/operator account, never EFT
  if (paidAt) return false
  if (hasNoEftMarker(adminNotes)) return false // explicit exclusion wins
  const p = parsePortalState(adminNotes).payment
  if (p?.status === 'paid') return false
  // 'collected' (EFT interim) has no paid_at and status !== 'paid', so it falls
  // through to globalOn below and correctly stays on the master lane.
  return hasEftMarker(adminNotes) || !!p?.eft_submitted_at || globalOn
}

/** True when the vendor sees EFT details on their PAYMENT view: global mode on,
 *  OR individually selected (⟦EFT⟧), but NEVER if they have already paid. An already-paid
 *  vendor (Yoco before the outage, or a reconciled EFT vendor) is treated as
 *  normal even while global mode is on: normal bot replies, their messages stay
 *  on the main inbox, and they see their paid state, not the EFT panel. Only
 *  UNPAID vendors are routed to EFT. `globalOn` is passed in so callers read
 *  getEftMode() once per request and reuse it across a vendor loop; `paidAt` is
 *  the vendor_applications.paid_at column when the caller has it. */
export function vendorInEftLane(
  adminNotes: string | null | undefined,
  globalOn: boolean,
  paidAt?: string | null,
  identity?: LaneIdentity,
): boolean {
  if (identity && isInternalAccount(identity.email, identity.phone)) return false // internal/operator account, never EFT
  if (paidAt) return false
  if (hasNoEftMarker(adminNotes)) return false // explicit exclusion wins over global
  if (parsePortalState(adminNotes).payment?.status === 'paid') return false
  return globalOn || hasEftMarker(adminNotes)
}

// ── PER-TIER PAYMENT-METHOD ROTATION ─────────────────────────────────────────
//
// Taona 2026-08-04: steer the Yoco/EFT mix per tier so cheap stalls stay on
// instant low-fee Yoco and expensive stalls lean to fee-free EFT. The rotation
// advances with PAYMENTS RECEIVED in each tier (not approval order), counting
// only from an activation "start line" so the ~30 payments taken under the old
// all-EFT system don't seed a random starting slot.
//
// Small tiers: 2 Yoco : 1 EFT (slots 0,1 Yoco, slot 2 EFT).
// Big tiers  : 2 EFT : 1 Yoco (slots 0,1 EFT, slot 2 Yoco).
// The slot of the NEXT payer = how many payments already landed since the start
// line. Nothing is stored per vendor; the count is derived (repo convention).

/** Pure rule: does the payment at position `receivedCount` (0-based) get EFT? */
export function tierRotationSaysEft(receivedCount: number, tierSlug: string | null | undefined): boolean {
  const slot = ((receivedCount % 3) + 3) % 3 // 0,1,2 even for negatives
  return SMALL_EFT_ROTATION_TIERS.has(tierSlug || '') ? slot === 2 : slot !== 2
}

/** The activation "start line": the rotation counts payments received AFTER this
 *  ISO timestamp. Null = rotation NOT activated (deploys inert; the resolver then
 *  falls back to the existing global-mode behaviour). Latest `pm_rotation` event
 *  wins, same pattern as getEftMode(). Fails closed to null. */
export async function getRotationStartAt(): Promise<string | null> {
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('site_events')
      .select('metadata')
      .eq('event_type', 'pm_rotation')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const at = (data?.metadata as { started_at?: string } | null)?.started_at
    return typeof at === 'string' && at ? at : null
  } catch {
    return null
  }
}

/** How many payments have been RECEIVED in a tier since the start line: a Yoco
 *  settlement (`paid_at`) or an EFT collection (`payment.eft_collected_at`) that
 *  landed after `startAtIso`. This is the 0-based slot for the next payer. */
export async function tierReceivedCount(tierSlug: string, startAtIso: string): Promise<number> {
  if (!tierSlug) return 0
  const admin = createAdminClient()
  const { data } = await admin
    .from('vendor_applications')
    .select('paid_at, admin_notes')
    .eq('preferred_booth_tier', tierSlug)
    .eq('status', 'approved')
  let n = 0
  for (const r of data || []) {
    const paidAt = r.paid_at as string | null
    if (paidAt && paidAt > startAtIso) { n++; continue }
    const collectedAt = parsePortalState(r.admin_notes as string).payment?.eft_collected_at
    if (typeof collectedAt === 'string' && collectedAt > startAtIso) n++
  }
  return n
}

/** THE payment-page routing decision. Same definite guards as vendorInEftLane,
 *  but the global-mode fallback is replaced by the per-tier rotation once
 *  activated. Order matters: overrides win, then committed-method stickiness (so
 *  a vendor mid-payment never flips when the tier count moves under them), then
 *  the rotation. Async because the rotation reads the DB. */
// A vendor "opened EFT" when they revealed the bank details (eft_revealed_at).
// This grace window holds them on EFT for `hours` after they last opened it, so a
// vendor mid-transfer is never yanked to Yoco. Pure (nowMs passed in) so it is
// unit-testable. Absent timestamp -> not in grace; present-but-unparseable ->
// treated as in-grace (never flip a vendor off EFT on bad data).
export function eftRevealWithinGrace(revealedAt: string | null | undefined, nowMs: number, hours = 48): boolean {
  if (!revealedAt) return false
  const t = new Date(revealedAt).getTime()
  if (Number.isNaN(t)) return true
  return nowMs - t <= hours * 3600 * 1000
}

export async function resolveInEftLane(
  app: { admin_notes?: string | null; paid_at?: string | null; preferred_booth_tier?: string | null },
  globalOn: boolean,
  identity?: LaneIdentity,
): Promise<boolean> {
  if (identity && isInternalAccount(identity.email, identity.phone)) return false // internal/operator
  if (app.paid_at) return false                                                   // already paid
  if (hasNoEftMarker(app.admin_notes)) return false                               // ⟦NOEFT⟧ excluded
  const p = parsePortalState(app.admin_notes).payment
  if (p?.status === 'paid') return false
  if (hasEftMarker(app.admin_notes)) return true                                  // ⟦EFT⟧ hand-picked
  // Money is already on the EFT rail (proof uploaded, or an operator marked it
  // collected): NEVER flip these to Yoco, they have paid by EFT. Independent of
  // the master switch and of the 48h grace below.
  if (p?.eft_submitted_at || p?.status === 'collected' || p?.eft_collected_at) return true
  // Opened the bank details but nothing in yet: hold on EFT for a 48h grace so a
  // vendor mid-transfer is never yanked to Yoco. After 48h an unpaid opener falls
  // through to the switch, so with EFT mode ON they stay EFT (rotation, unchanged)
  // and with it OFF they return to card. Taona 2026-08-05: "turn off eft mode
  // except those who opened eft in the past 48 hours".
  if (p?.eft_revealed_at && (globalOn || eftRevealWithinGrace(p.eft_revealed_at, Date.now()))) return true
  if (p?.status === 'pending') return false                                       // Yoco checkout started, don't flip
  if (!globalOn) return false                                                     // EFT master switch off
  const startAt = await getRotationStartAt()
  if (!startAt) return true                                                       // rotation not activated → prior all-EFT behaviour
  const count = await tierReceivedCount(app.preferred_booth_tier || '', startAt)
  return tierRotationSaysEft(count, app.preferred_booth_tier)
}

// A reply "tells a vendor they can pay by EFT" when it mentions EFT, a bank
// transfer, or proof of payment. Deliberately narrow so an unrelated reply does
// not sweep a vendor onto the lane.
const EFT_MENTION_RE = /\b(eft|bank\s*transfer|proof\s*of\s*payment)\b/i
export function mentionsEft(text: string | null | undefined): boolean {
  return EFT_MENTION_RE.test(text || '')
}

// ── THE WIDER, READ-ONLY PREDICATE ───────────────────────────────────────────
//
// mentionsEft above stays NARROW on purpose and must not be widened: four write
// paths (reply/route.ts x3, email-concierge.ts) feed it to markVendorToldEft,
// which MOVES A VENDOR ONTO THE MASTER LANE. Widen that and an admin typing
// "your transfer came through" silently pulls a vendor out of the festival
// owner's world. A predicate that hides and a predicate that reassigns
// ownership cannot be the same function.
//
// This one only ever HIDES. Taona 2026-07-29: "what guard can u put that says
// when someone mentioned paid via eft, trasnfered, sent pop, etc".
//
// It exists because the narrow one is three phrases, and of eleven realistic
// paraphrases probed against live data, NINE walked straight through: "I did
// the transfer this morning", "deposited into your account", "sent it from my
// FNB", "please send banking details".
//
// THE REFUSAL CARVE-OUT IS NOT A NICETY.
//
// Most matches in her threads today are the bot DECLINING: "stall fees are paid
// by card only through Yoco, so there aren't any banking details". Hiding those
// is worse than useless. She would see a vendor ask for bank details and no
// answer, conclude nobody replied, and answer it herself, possibly wrongly. The
// refusal is the single most reassuring thing in the thread, so it stays.
// (A) Explicit vocabulary, and (B) an assertion that money ALREADY MOVED outside
// the card lane. These are what betray the arrangement: you cannot have
// transferred to an account you were never given.
const MOVEMENT_ASSERTED_RE = new RegExp([
  '\\b(eft|efts|eft\\047d)\\b',
  '\\bbank\\s*transfer\\b',
  '\\bproof\\s*of\\s*payment\\b',
  // "POP attached" AND "sent POP". The evidence word can sit on either side, so
  // the check runs both ways; a one-sided lookahead missed "sent POP" outright.
  // Never bare \bpop\b, which would eat "popped up" and "pop-up stall".
  '\\bpop\\b[^a-z]{0,14}(attach|sent|send|here|below|proof|confirm)',
  '(attach|sent|send|here|below|proof|emailed?)[^a-z]{0,14}\\bpop\\b',
  '\\b(transferred|transfered|transferring|transfering)\\b',
  // The NOUN, as in "I did the transfer this morning". Requires a determiner or
  // an action verb so "transfer of ownership" style prose does not match.
  '\\b(did|made|done|completed|processed)\\s+(the|a|an|my)?\\s*transfer\\b',
  '\\b(the|my|that)\\s+transfer\\b',
  '\\bdeposited\\s+(it\\s+)?(in|into)\\b',
  '\\bbank\\s+deposit\\b',
  '\\bpaid?\\s+(it\\s+)?(directly\\s+)?into\\b',
  '\\bpay(ing)?\\s+(directly\\s+)?into\\s+(your|the|ur)\\b',
  '\\bsent\\s+(the\\s+|you\\s+the\\s+)?(money|funds|payment)\\b',
  '\\b(payshap|ozow|snapscan|instant\\s*eft)\\b',
].join('|'), 'i')

// (C) Actual coordinates. A branch code or an account number is the thing
// itself, so it hides whatever sentence surrounds it.
const COORDINATES_RE = new RegExp([
  '\\baccount\\s*(number|nr|no\\b)',
  '\\bbranch\\s*code\\b',
  '\\b(fnb|absa|nedbank|capitec|standard\\s*bank|tymebank)\\b[^.!?\\n]{0,40}\\d{6,}',
].join('|'), 'i')

// A bare long digit run was tried here and had to be removed: South African
// mobile numbers are 11 digits with the country code, so it hid every
// "WA opt-in: ... subscribed at +2767..." alert in her feed. The actual account
// number is matched EXACTLY instead, which cannot false-positive at all.
function containsRealBankValues(text: string): boolean {
  const d = getEftBankDetails()
  for (const v of [d.accountNumber, d.branchCode]) {
    const s = String(v || '').replace(/\s/g, '')
    if (s.length >= 5 && text.replace(/\s/g, '').includes(s)) return true
  }
  return false
}

// (D) Bank-detail TOPIC words. On their own these are usually a vendor ASKING,
// which is safe and must stay visible, so they only hide when something is
// being handed over.
const TOPIC_RE = /\b(bank|banking)\s*(details|detail|info|information)\b|\baccount\s*details\b/i
const HANDOVER_RE = new RegExp([
  '\\b(here\\s+(is|are)|attached|as\\s+follows|below\\s+are|these\\s+are)\\b',
  '\\bdetails\\s*(are|:)',
  '\\b(sending|sent|share[sd]?|shared|provided|forwarded)\\b',
].join('|'), 'i')

// Phrases that mean "we do NOT do that", which make a match safe to show.
const CARD_ONLY_RE = new RegExp([
  '\\bcard\\s*only\\b',
  '\\bonly\\s+(by|via|through|with)\\s+(card|yoco)\\b',
  '\\bpaid?\\s+by\\s+card\\s+only\\b',
  "\\b(aren'?t|are\\s*not|no)\\s+(any\\s+)?bank(ing)?\\s*details\\b",
  "\\b(can'?t|cannot|can\\s*not|not\\s+able\\s+to|do\\s*n[o']t|unable\\s+to)\\b[^.!?]{0,40}\\b(give|share|provide|send|hand)\\b[^.!?]{0,30}\\b(bank|banking|account|payment)\\b",
  '\\bno\\s+(other|alternative)\\s+payment\\s+method\\b',
].join('|'), 'i')

/** True when this text would reveal that money moved, or could move, outside
 *  the card lane. HIDE-SIDE ONLY: never wire this to markVendorToldEft or to
 *  anything else that writes.
 *
 *  Returns false for a refusal even when the wording matches, so the bot's
 *  card-only answers stay visible and her conversations keep both halves. */
export function revealsPaymentArrangement(text: string | null | undefined): boolean {
  const t = text || ''
  if (!t) return false

  // A refusal is safe whatever words it uses, and showing it is actively
  // valuable: it is the answer to the question above it.
  if (CARD_ONLY_RE.test(t)) return false

  // Coordinates are the thing itself.
  if (containsRealBankValues(t)) return true
  if (COORDINATES_RE.test(t)) return true

  // An assertion that money already moved.
  if (MOVEMENT_ASSERTED_RE.test(t)) return true

  // Bank-detail topic words hide only when something is being HANDED OVER.
  // "Please send banking details" is a vendor asking, and hiding it while
  // showing the bot's refusal would leave her an answer with no question,
  // which reads as a bug and invites her to answer it herself.
  if (TOPIC_RE.test(t) && HANDOVER_RE.test(t)) return true

  return false
}

/** When a reply that tells a vendor about EFT is SENT to them, move that vendor
 *  onto the Master lane by adding the ⟦EFT⟧ marker (Taona 2026-07-24: "any vendor
 *  told by the bot they can pay via EFT must move their comms to the master lane").
 *  Reuses the ⟦EFT⟧ machinery: comms leave the owner's inbox, they show on the
 *  payments tab, and eft_lane_activity reports them. Best-effort + idempotent:
 *  skips a paid, ⟦NOEFT⟧-excluded, already-marked, or unresolved contact. Resolve
 *  by email, else by last-9 phone. Returns the marked vendor id, or null. */
export async function markVendorToldEft(opts: { email?: string | null; phone?: string | null }): Promise<string | null> {
  try {
    const db = createAdminClient()
    type Row = { id: string; admin_notes: string | null; paid_at: string | null }
    let row: Row | null = null
    if (opts.email) {
      const { data } = await db.from('vendor_applications').select('id, admin_notes, paid_at').ilike('email', opts.email).limit(1)
      row = (data?.[0] as Row) || null
    }
    if (!row && opts.phone) {
      const last9 = opts.phone.replace(/\D/g, '').slice(-9)
      if (last9) {
        const { data } = await db.from('vendor_applications').select('id, admin_notes, paid_at').like('phone', `%${last9}`).limit(1)
        row = (data?.[0] as Row) || null
      }
    }
    if (!row || row.paid_at) return null
    const notes = row.admin_notes || ''
    if (hasNoEftMarker(notes) || hasEftMarker(notes)) return null // excluded or already on the lane
    if (parsePortalState(notes).payment?.status === 'paid') return null
    await db.from('vendor_applications').update({ admin_notes: withEftMarker(notes) }).eq('id', row.id)
    return row.id
  } catch (e) {
    console.error('[markVendorToldEft] failed:', (e as Error).message)
    return null
  }
}

/** Suggested payment reference for reconciliation: the vendor's allocated stall
 *  code when they have one (unique on the floor), else a short stable code from
 *  the application id. Show the business name alongside it in the UI; this is the
 *  token an operator matches a bank deposit against. */
export function eftReference(app: { id?: string | null; admin_notes?: string | null }): string {
  const alloc = parseAllocation(app.admin_notes)
  if (alloc.stall) return alloc.stall
  const id = (app.id || '').replace(/-/g, '')
  return id ? `CTH${id.slice(-6).toUpperCase()}` : 'CTH'
}

/** The earliest timestamp that proves this vendor touched the EFT lane:
 *  revealing bank details, uploading a proof, or the operator marking the money
 *  collected. Used to set the owner-view cutoff when the vendor is later
 *  reconciled back through Yoco, so every EFT-era message stays hidden from the
 *  festival owner. */
export function earliestEftTimestamp(state: PortalState): string | null {
  const p = state.payment
  if (!p) return null
  const candidates = [p.eft_revealed_at, p.eft_submitted_at, p.eft_collected_at].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  )
  if (candidates.length === 0) return null
  candidates.sort() // ISO 8601 strings sort lexicographically
  return candidates[0]
}

/** Holding message the bot sends to master-lane vendors instead of running the
 *  normal agent, while the lane is active.
 *
 *  Rewritten 2026-07-26: it used to say the assistant was "under maintenance"
 *  and referred to paying "by EFT". Neither is a vendor's business. A vendor on
 *  this lane must feel that everything is normal (Taona: "those who pay on
 *  master lane should feel that everything is normal"), so nothing here names
 *  the lane, an outage, or an acronym. It reads as a human picking the
 *  conversation up, which is exactly what happens. No em-dashes (Law 7). */
export const EFT_MAINTENANCE_MESSAGE =
  'Thanks for your message. One of our team is looking after your account personally, ' +
  'so someone will reply to you here or by email shortly. ' +
  'You can also reach us at support@youngatheart.co.za or through your vendor portal inbox. ' +
  'If you have already paid, upload your proof of payment in your vendor portal or email it to us, ' +
  'and please allow up to 24 hours for our team to confirm it and update you.'
