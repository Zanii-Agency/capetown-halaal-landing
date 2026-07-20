// Payment gate for exhibitor portal pages.
//
// The vendor journey is strictly sequential:
//   approved  ->  sign contract  ->  pay stall fee  ->  everything else
//
// Until a vendor has paid their stall fee, the ONLY things they can do in the
// portal are sign the contract and pay. Every other page calls requirePaid()
// at the top of its server-side render function. requirePaid() enforces the
// whole sequence: an approved vendor who has not signed is sent to /contract;
// a signed vendor who has not paid is sent to /payments.
//
// /contract, /payments and /support are the exceptions (they don't call this).
//
// IMPORTANT (the bug this fixes): "paid" is read from BOTH the first-class DB
// columns (payment_status / paid_at, written by the Yoco webhook and admin
// mark-paid via confirm.ts) AND the legacy base64 portal-state marker. The
// old gate read ONLY the marker, so a vendor paid by EFT / marked paid by an
// operator (column set, marker absent) was redirect-trapped on /payments
// forever even though they had genuinely paid. Reading either source clears it.

import { redirect } from 'next/navigation'
import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState } from '@/lib/portal-state'

/** True if the application has paid, per either the DB columns or the marker. */
function isPaid(app: Record<string, unknown>): boolean {
  if (app.payment_status === 'paid') return true
  if (app.paid_at) return true
  const state = parsePortalState((app.admin_notes as string) || null)
  return state.payment?.status === 'paid'
}

/** True if an approved vendor still needs to sign the contract. */
function needsContract(app: Record<string, unknown>): boolean {
  return app.status === 'approved' && !app.contract_signed_at
}

/**
 * Gate a post-payment portal page. Enforces the full sequence:
 * unsigned approved vendor -> /contract; signed-but-unpaid vendor -> /payments.
 */
export async function requirePaid(): Promise<void> {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return // layout will redirect to login
  const app = ctx.application
  if (needsContract(app)) {
    redirect('/exhibitor/portal/contract')
  }
  if (!isPaid(app)) {
    redirect('/exhibitor/portal/payments')
  }
}

/**
 * Gate a page an APPROVED vendor may use regardless of whether they have signed,
 * paid, or been allocated. The stall-request pages use this (NOT requirePaid):
 * a vendor must be able to change their stall SIZE (tier) or request a different
 * stall POSITION as soon as they are approved — before the contract locks their
 * fee and before allocation. Non-approved applications go back to the overview.
 */
export async function requireApproved(): Promise<void> {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return // layout redirects to login
  if (ctx.application.status !== 'approved') {
    redirect('/exhibitor/portal')
  }
}

/**
 * Gate the /payments page itself: a vendor must sign the contract before they
 * can pay. An approved, unsigned vendor is sent to /contract. (Does not gate on
 * payment, since this is where they pay.)
 */
export async function requireContractSigned(): Promise<void> {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) return
  if (needsContract(ctx.application)) {
    redirect('/exhibitor/portal/contract')
  }
}

/** Return number of days between today and a target date string (negative = overdue). */
export function daysUntil(target: Date | string | null | undefined): number | null {
  if (!target) return null
  const d = typeof target === 'string' ? new Date(target) : target
  if (isNaN(d.getTime())) return null
  return Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
}

/** Format a date string (YYYY-MM-DD or ISO) as "DD Month YYYY" UK-style. */
export function fmtDate(target: Date | string | null | undefined, fallback = 'TBC'): string {
  if (!target) return fallback
  const d = typeof target === 'string' ? new Date(target) : target
  if (isNaN(d.getTime())) return fallback
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
}

/** Compute due-date for a vendor: explicit column → fallback to approved_at + 30 days. */
export function computePaymentDue(app: { payment_due_date?: string | null; reviewed_at?: string | null }): Date | null {
  if (app.payment_due_date) {
    const d = new Date(app.payment_due_date)
    if (!isNaN(d.getTime())) return d
  }
  if (app.reviewed_at) {
    const d = new Date(app.reviewed_at)
    if (!isNaN(d.getTime())) {
      d.setDate(d.getDate() + 30)
      return d
    }
  }
  return null
}
