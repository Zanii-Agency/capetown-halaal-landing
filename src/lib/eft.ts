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

import { parseAllocation } from '@/lib/stalls'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalState } from '@/lib/portal-state'

const EFT_MARKER = '⟦EFT⟧'
// Bare token; cannot collide with ⟦PORTAL:<base64>⟧ or ⟦STALL:...⟧ (different
// bodies), and PORTAL/STALL writers only strip their own marker, so ⟦EFT⟧
// survives their read-modify-writes untouched.
const EFT_RE = /⟦EFT⟧/

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
const DEFAULT_BANK: EftBankDetails = {
  accountName: 'Halaal Hub',
  bank: 'FNB',
  accountNumber: '63170873351',
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
 *  on (crisis override, needs a deploy), else the latest persisted toggle from
 *  the /admin/eft tab (site_events, no DDL, instant). A vendor is "in the lane"
 *  when this is ON *or* they carry the per-vendor ⟦EFT⟧ marker. Server-only. */
export async function getEftMode(): Promise<boolean> {
  const env = (process.env.EFT_MODE || '').toLowerCase()
  if (env === '1' || env === 'true' || env === 'on' || env === 'yes') return true
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

// A reply "tells a vendor they can pay by EFT" when it mentions EFT, a bank
// transfer, or proof of payment. Deliberately narrow so an unrelated reply does
// not sweep a vendor onto the lane.
const EFT_MENTION_RE = /\b(eft|bank\s*transfer|proof\s*of\s*payment)\b/i
export function mentionsEft(text: string | null | undefined): boolean {
  return EFT_MENTION_RE.test(text || '')
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

/** Holding message the bot sends to EFT-lane vendors instead of running the
 *  normal agent, while the lane is active. Steers them to EMAIL as the only
 *  channel while WhatsApp is under maintenance. No em-dashes (Law 7). */
export const EFT_MAINTENANCE_MESSAGE =
  'Thanks for your message. Our WhatsApp assistant is under maintenance at the moment, ' +
  'so a team member will reply to you here or by email shortly. ' +
  'You can also reach us at support@youngatheart.co.za or through your vendor portal inbox. ' +
  'If you are paying by EFT, upload your proof of payment in your vendor portal or email it to us, ' +
  'and please allow up to 24 hours for our team to confirm your payment and update you.'
