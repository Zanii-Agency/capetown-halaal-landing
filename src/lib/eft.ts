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

/** Whose CONVERSATIONS move to the dev EFT tab (and off the main inbox) and who
 *  gets the bot maintenance reply. This is the ACTIVE EFT set: individually added
 *  (⟦EFT⟧) OR has uploaded an EFT proof (payment.eft_submitted_at), and not paid.
 *  DELIBERATELY independent of global mode: turning global mode on shows every
 *  unpaid vendor the EFT bank details, but must NOT sweep their conversations off
 *  Samreen's inbox. Only a vendor actively being handled for EFT moves. */
export function vendorCommsInEftLane(adminNotes: string | null | undefined, paidAt?: string | null): boolean {
  if (paidAt) return false
  if (hasNoEftMarker(adminNotes)) return false // explicit exclusion wins
  const p = parsePortalState(adminNotes).payment
  if (p?.status === 'paid') return false
  return hasEftMarker(adminNotes) || !!p?.eft_submitted_at
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
): boolean {
  if (paidAt) return false
  if (hasNoEftMarker(adminNotes)) return false // explicit exclusion wins over global
  if (parsePortalState(adminNotes).payment?.status === 'paid') return false
  return globalOn || hasEftMarker(adminNotes)
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
  'so please communicate with us by email only at support@youngatheart.co.za. ' +
  'If you are paying by EFT, upload your proof of payment in your vendor portal or email it to us, ' +
  'and please allow up to 24 hours for our team to confirm your payment and update you. ' +
  'We will be back to normal shortly.'
